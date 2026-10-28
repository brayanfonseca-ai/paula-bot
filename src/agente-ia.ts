// ============================================================================
// Cliente del Agente IA (Amazon Bedrock AgentCore vía la API orquestadora).
//
// El bot NO habla con AWS directamente: consume un endpoint HTTP (una Lambda)
// que recibe { message, sessionId }, invoca el harness de Bedrock y devuelve
// { sessionId, reply, stopReason, usage }. El `reply` normalmente trae un JSON
// ESTRUCTURADO dentro del string (a veces precedido de bloques <thinking>...),
// con la forma { tipo, estado, pdf_url, mensaje }.
//
// Este módulo:
//   1. Llama a la API con reintentos ante errores de RED transitorios (igual
//      patrón que pharitech.ts: la 1ª conexión "en frío" suele fallar).
//   2. Limpia los bloques <thinking>...</thinking> del reply.
//   3. Parsea el JSON interno; si no es JSON, trata el reply como texto plano.
//   4. Normaliza `pdf_url` (string | array | ausente) a una lista de URLs.
//
// No mantiene estado: el logger se inyecta. El manejo de la sesión (persistir
// el bedrockSessionId y su expiración) vive en el repositorio/app.ts.
// ============================================================================
import { AGENT_API_URL, AGENT_API_TIMEOUT_MS } from './config'

type LogFn = (...args: unknown[]) => void

/** Respuesta normalizada del agente, lista para que app.ts la entregue. */
export interface RespuestaAgente {
    /** Texto para el usuario (siempre presente; vacío si el agente no mandó nada). */
    mensaje: string
    /** URLs de PDF a entregar como documento (puede venir 0, 1 o varias). */
    pdfUrls: string[]
    /** sessionId de la conversación en el agente (para el próximo turno). */
    bedrockSessionId: string | null
    /** Clasificación del agente (p. ej. 'conversacion' | 'extracto' | ...), si vino. */
    tipo?: string
    /** Estado del agente ('ok' | 'error' | ...), si vino. */
    estado?: string
    /** true si la llamada HTTP falló por completo (red/servidor): el caller hace fallback. */
    fallo: boolean
}

const esperarMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Quita los bloques <thinking>...</thinking> que el modelo a veces antepone. */
const quitarThinking = (texto: string): string =>
    texto.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim()

/**
 * Extrae TODOS los objetos JSON embebidos en un texto. El agente puede devolver:
 *   - un solo objeto:            {tipo,...}
 *   - un array:                  [{...},{...}]
 *   - varios objetos seguidos:   {...}{...}  o  {...}\n{...}  (sin array)
 * Devuelve la lista de objetos parseados (vacía si no hay ninguno). Antes solo
 * se extraía UN objeto (de la primera "{" a la última "}"), lo que con dos
 * documentos (rete_ica + rete_fuente) producía un JSON inválido y el bot
 * mostraba el texto crudo al usuario. Ahora cada objeto se maneja por separado.
 */
const extraerObjetos = (texto: string): Record<string, unknown>[] => {
    const t = texto.trim()
    if (!t) return []

    // Camino feliz: el texto completo es JSON válido (objeto o array).
    try {
        const parsed = JSON.parse(t)
        if (Array.isArray(parsed)) {
            return parsed.filter((o) => o && typeof o === 'object') as Record<string, unknown>[]
        }
        if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>]
    } catch {
        /* seguimos al escaneo por llaves balanceadas */
    }

    // Escaneo: recorre el texto y aísla cada bloque {...} balanceando llaves,
    // respetando las comillas (no cuenta llaves dentro de strings). Cada bloque
    // se intenta parsear por separado.
    const objetos: Record<string, unknown>[] = []
    let profundidad = 0
    let inicio = -1
    let enString = false
    let escape = false
    for (let i = 0; i < t.length; i++) {
        const c = t[i]
        if (enString) {
            if (escape) escape = false
            else if (c === '\\') escape = true
            else if (c === '"') enString = false
            continue
        }
        if (c === '"') { enString = true; continue }
        if (c === '{') {
            if (profundidad === 0) inicio = i
            profundidad++
        } else if (c === '}') {
            if (profundidad > 0) {
                profundidad--
                if (profundidad === 0 && inicio >= 0) {
                    try {
                        const obj = JSON.parse(t.slice(inicio, i + 1))
                        if (obj && typeof obj === 'object') {
                            objetos.push(obj as Record<string, unknown>)
                        }
                    } catch {
                        /* bloque no parseable: se ignora */
                    }
                    inicio = -1
                }
            }
        }
    }
    return objetos
}

/** Normaliza pdf_url (string | string[] | null) a una lista de URLs no vacías. */
const normalizarPdfUrls = (valor: unknown): string[] => {
    if (!valor) return []
    if (typeof valor === 'string') {
        const u = valor.trim()
        return u ? [u] : []
    }
    if (Array.isArray(valor)) {
        return valor
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter(Boolean)
    }
    return []
}

/**
 * `fetch` con reintentos ante errores de RED transitorios (TypeError "fetch
 * failed"). Igual criterio que pharitech.ts: si el servidor responde (aunque
 * sea 4xx/5xx) NO reintenta. Aborta por timeout para no colgar el flujo.
 */
const fetchConReintentos = async (
    url: string,
    init: RequestInit,
    log: LogFn,
    intentos = 3,
    esperaReintentoMs = 400,
): Promise<Response> => {
    let ultimoError: unknown
    for (let i = 1; i <= intentos; i++) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), AGENT_API_TIMEOUT_MS)
        try {
            return await fetch(url, { ...init, signal: ctrl.signal })
        } catch (err) {
            ultimoError = err
            log(`[agente-ia] intento ${i}/${intentos} falló (red):`, String(err))
            if (i < intentos) await esperarMs(esperaReintentoMs)
        } finally {
            clearTimeout(timer)
        }
    }
    throw ultimoError
}

/**
 * Envía un mensaje al agente y devuelve la respuesta normalizada. `sessionId`
 * es el bedrockSessionId vigente (o null/undefined para iniciar un hilo nuevo:
 * la Lambda genera uno y lo devuelve).
 */
export const consultarAgente = async (
    mensaje: string,
    bedrockSessionId: string | null | undefined,
    log: LogFn,
): Promise<RespuestaAgente> => {
    const body: Record<string, unknown> = { message: mensaje }
    if (bedrockSessionId) body.sessionId = bedrockSessionId

    let res: Response
    try {
        res = await fetchConReintentos(
            AGENT_API_URL,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
            log,
        )
    } catch (err) {
        log('[agente-ia] Error de red definitivo:', String(err))
        return { mensaje: '', pdfUrls: [], bedrockSessionId: bedrockSessionId ?? null, fallo: true }
    }

    let envelope: {
        sessionId?: string
        reply?: string
        error?: string
        message?: string
    }
    try {
        envelope = (await res.json()) as typeof envelope
    } catch (err) {
        log('[agente-ia] Respuesta no-JSON:', String(err))
        return { mensaje: '', pdfUrls: [], bedrockSessionId: bedrockSessionId ?? null, fallo: true }
    }

    const nuevaSesion = envelope.sessionId ?? bedrockSessionId ?? null

    // Error HTTP de negocio (4xx/5xx): la API devuelve { error, message }.
    if (!res.ok) {
        log('[agente-ia] HTTP', String(res.status), envelope.error ?? '', envelope.message ?? '')
        return {
            mensaje: '',
            pdfUrls: [],
            bedrockSessionId: nuevaSesion,
            estado: 'error',
            fallo: true,
        }
    }

    const replyCrudo = typeof envelope.reply === 'string' ? envelope.reply : ''
    const replyLimpio = quitarThinking(replyCrudo)

    // El reply trae uno o VARIOS objetos JSON { tipo, estado, pdf_url, mensaje }.
    // Cuando el agente genera varios documentos (p. ej. rete_ica + rete_fuente)
    // devuelve varios objetos: combinamos sus mensajes (uno por línea) y
    // juntamos TODOS los pdf_url. Así el usuario ve texto legible y recibe cada
    // PDF como documento, en vez del JSON crudo.
    const objetos = extraerObjetos(replyLimpio)
    if (objetos.length > 0) {
        const mensajes: string[] = []
        const pdfUrls: string[] = []
        for (const obj of objetos) {
            if (typeof obj.mensaje === 'string' && obj.mensaje.trim()) {
                mensajes.push(obj.mensaje.trim())
            }
            pdfUrls.push(
                ...normalizarPdfUrls(obj.pdf_url ?? (obj as { pdfUrl?: unknown }).pdfUrl),
            )
        }
        const primero = objetos[0]
        return {
            mensaje: mensajes.join('\n\n'),
            pdfUrls,
            bedrockSessionId: nuevaSesion,
            tipo: typeof primero.tipo === 'string' ? primero.tipo : undefined,
            estado: typeof primero.estado === 'string' ? primero.estado : undefined,
            fallo: false,
        }
    }

    // Fallback: el reply no era JSON → se trata como texto plano para el usuario.
    return {
        mensaje: replyLimpio,
        pdfUrls: [],
        bedrockSessionId: nuevaSesion,
        fallo: false,
    }
}
