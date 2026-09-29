// ============================================================================
// Worker de mensajes salientes (portal -> bot).
// Hace polling de la tabla outbound_messages: los mensajes que un asesor
// escribe desde el portal en modo MANUAL se encolan ahí como PENDING. Este
// worker los reclama, los envía por WhatsApp (Graph API vía el provider) y los
// marca SENT/FAILED. También persiste el mensaje del asesor en el histórico.
//
// Es el complemento del canal de entrada: así el portal "le habla" al usuario
// de WhatsApp a través del bot, sin acoplarse a Meta.
// ============================================================================
import * as repo from './repository'
import { prisma } from './db'

type Enviar = {
  texto: (numero: string, mensaje: string) => Promise<void>
  imagen: (numero: string, url: string, caption: string) => Promise<void>
  documento: (numero: string, url: string, filename: string, caption: string) => Promise<void>
}

type LogFn = (...args: unknown[]) => void

/**
 * Inicia el bucle de polling. Devuelve una función para detenerlo.
 * @param enviar   funciones de envío del bot (ya conectadas al provider).
 * @param log      logger del bot.
 * @param intervalo ms entre ciclos (default 3000).
 */
export const iniciarWorkerSalientes = (
  enviar: Enviar,
  log: LogFn,
  intervalo = Number(process.env.OUTBOUND_POLL_MS ?? 3000),
): (() => void) => {
  let activo = true
  let corriendo = false

  const ciclo = async () => {
    if (!activo || corriendo) return
    corriendo = true
    try {
      const pendientes = await repo.reclamarSalientesPendientes(10)
      for (const p of pendientes) {
        try {
          if (p.kind === 'image' && p.mediaUrl) {
            await enviar.imagen(p.phoneE164, p.mediaUrl, p.content ?? '')
          } else if (p.kind === 'document' && p.mediaUrl) {
            await enviar.documento(p.phoneE164, p.mediaUrl, p.filename ?? 'documento.pdf', p.content ?? '')
          } else {
            await enviar.texto(p.phoneE164, p.content ?? '')
          }

          // Persiste el mensaje del asesor en el histórico (rol advisor) si no
          // fue ya persistido por el portal (evita duplicar por clientMessageId).
          if (p.content) {
            const yaExiste = p.clientMessageId
              ? await prisma.message.findFirst({ where: { clientMessageId: p.clientMessageId } })
              : null
            if (!yaExiste) {
              await repo.guardarMensaje({
                sessionId: p.sessionId,
                role: 'advisor',
                direction: 'OUTBOUND',
                type: (p.kind as 'text' | 'image' | 'document') ?? 'text',
                content: p.content,
                clientMessageId: p.clientMessageId ?? undefined,
                authorId: p.enqueuedBy ?? undefined,
              })
            }
          }

          await repo.marcarSalienteEnviado(p.id)
          log('[outbound] enviado', p.id, '->', p.phoneE164)
        } catch (err) {
          await repo.marcarSalienteFallido(p.id, String(err))
          log('[outbound] fallo enviando', p.id, String(err))
        }
      }
    } catch (err) {
      log('[outbound] error en ciclo de polling:', String(err))
    } finally {
      corriendo = false
    }
  }

  const timer = setInterval(ciclo, intervalo)
  log('[outbound] worker iniciado, polling cada', intervalo, 'ms')

  return () => {
    activo = false
    clearInterval(timer)
    log('[outbound] worker detenido')
  }
}
