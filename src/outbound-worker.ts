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
  // Cada cuántos ciclos revisar SENDING huérfanos (proceso caído a mitad).
  const CICLOS_ENTRE_RECUPERACION = Math.max(1, Math.round(30000 / intervalo))
  let ciclosDesdeRecuperacion = CICLOS_ENTRE_RECUPERACION // fuerza chequeo en el 1er ciclo

  const ciclo = async () => {
    if (!activo || corriendo) return
    corriendo = true
    try {
      // Recuperación periódica de SENDING huérfanos: los devuelve a PENDING.
      if (++ciclosDesdeRecuperacion >= CICLOS_ENTRE_RECUPERACION) {
        ciclosDesdeRecuperacion = 0
        try {
          const n = await repo.recuperarSalientesHuerfanos()
          if (n > 0) log('[outbound] recuperados', n, 'SENDING huérfanos -> PENDING')
        } catch (err) {
          log('[outbound] error recuperando huérfanos:', String(err))
        }
      }

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

          // Persiste el mensaje del asesor en el histórico (rol advisor) SOLO si
          // el portal no lo persistió ya. El portal puede dejarlo registrado de
          // dos formas: con un `clientMessageId` (mensaje manual del asesor) o
          // con un `messageId` ya creado por él (p. ej. el aviso de "Devolver a
          // Paula", que la API inserta como mensaje del bot). Si cualquiera de
          // los dos ya existe en `messages`, NO creamos otro (evita el doble en
          // el portal: uno de la API y otro del worker).
          if (p.content) {
            let yaExiste = null as Awaited<ReturnType<typeof prisma.message.findFirst>> | null
            if (p.messageId) {
              yaExiste = await prisma.message.findFirst({ where: { messageId: p.messageId } })
            }
            if (!yaExiste && p.clientMessageId) {
              yaExiste = await prisma.message.findFirst({ where: { clientMessageId: p.clientMessageId } })
            }
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

          await repo.marcarSalienteEnviado(p.id, p.messageId)
          log('[outbound] enviado', p.id, '->', p.phoneE164)
        } catch (err) {
          // marcarSalienteFallido decide reintento (backoff) vs FAILED definitivo
          // según p.attempts (ya incrementado al reclamar) y MAX_OUTBOUND_ATTEMPTS.
          await repo.marcarSalienteFallido(p.id, String(err), p.attempts, p.messageId)
          const definitivo = p.attempts >= repo.MAX_OUTBOUND_ATTEMPTS
          log(
            '[outbound]',
            definitivo ? 'FALLIDO definitivo' : `fallo (intento ${p.attempts}), reintentará`,
            p.id,
            String(err),
          )
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
