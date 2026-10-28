// ============================================================================
// WS-07 — Cliente de los servicios externos PhariTech (owner + reportes).
// Extraído de app.ts para aislar el acceso HTTP externo del flujo/estado del
// bot. No mantiene estado propio: las dependencias con efectos (log, avisos al
// usuario, trazas) se inyectan, de modo que el módulo es fácil de razonar y
// testear sin arrastrar el Map de sesiones ni el provider de WhatsApp.
// ============================================================================
import { OWNER_URL, STATUS_API, MAX_REINTENTOS, INTERVALO_MS, DELAY_INICIAL_MS, esperar } from './config'

/** Perfil de propietario devuelto por el servicio owner de PhariTech. */
export interface Propietario {
    names: string
    nit: string | number
    [k: string]: unknown
}

/**
 * Resultado del polling de un reporte:
 *  - listo: documento disponible, entregar.
 *  - sin_documento: el proceso TERMINÓ pero no hay documento (p. ej. NIT no
 *    registrado). Resultado de negocio terminal: NO seguir esperando.
 *  - timeout: se agotó el tiempo sin resolución.
 */
export type ResultadoReporte =
    | { estado: 'listo'; url: string }
    | { estado: 'sin_documento'; mensaje?: string }
    | { estado: 'timeout' }

type LogFn = (...args: unknown[]) => void

const esperarMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * `fetch` con reintentos ante errores de RED transitorios (TypeError:
 * "fetch failed"). En redes corporativas/con proxy, la PRIMERA conexión tras
 * arrancar o tras una sesión nueva suele fallar "en frío" (socket/DNS/keep-alive
 * no caliente) y el segundo intento funciona. Esto causaba que el usuario viera
 * "no autenticado" o "no se pudo generar el documento" en el primer intento y
 * tuviera que repetir. Reintentando aquí, el fallo transitorio es transparente.
 *
 * Solo reintenta ante errores de red (fetch rechaza con TypeError). Si el
 * servidor responde (aunque sea 4xx/5xx) NO reintenta: eso es decisión del caller.
 */
const fetchConReintentos = async (
    url: string,
    init: RequestInit,
    log: LogFn,
    etiqueta: string,
    intentos = 3,
    esperaMs = 400,
): Promise<Response> => {
    let ultimoError: unknown
    for (let i = 1; i <= intentos; i++) {
        try {
            return await fetch(url, init)
        } catch (err) {
            ultimoError = err
            log(`[${etiqueta}] intento ${i}/${intentos} falló (red):`, String(err))
            if (i < intentos) await esperarMs(esperaMs)
        }
    }
    throw ultimoError
}

/** Consulta el servicio owner por teléfono y devuelve los perfiles asociados. */
export const consultarOwner = async (
    numero: string,
    log: LogFn,
): Promise<Propietario[]> => {
    const telefono = numero.startsWith('+') ? numero : `+${numero}`
    try {
        const res = await fetchConReintentos(
            OWNER_URL,
            { method: 'GET', headers: { phone: telefono } },
            log,
            'owner',
        )
        if (res.status === 404) return []
        if (!res.ok) {
            log('[owner] HTTP', String(res.status))
            return []
        }
        const data = await res.json()
        return Array.isArray(data) ? data : []
    } catch (err) {
        log('[owner] Error:', String(err))
        return []
    }
}

/** Crea un reporte en PhariTech y devuelve su id (o null si falla). */
export const crearReporte = async (
    url: string,
    etiqueta: string,
    log: LogFn,
): Promise<string | null> => {
    try {
        log(`[${etiqueta}] GET`, url)
        const res = await fetchConReintentos(url, { method: 'GET' }, log, etiqueta)
        const id = (await res.text()).trim().replace(/["']/g, '')
        log(`[${etiqueta}] HTTP`, String(res.status), 'id:', id)
        return id || null
    } catch (err) {
        log(`[${etiqueta}] Error creando reporte:`, String(err))
        return null
    }
}

/**
 * Extrae un mensaje legible del proveedor, quitando prefijos técnicos como
 * "[Resource: REP_EXT00 ]: Externo: Api-Seven - ". Función pura.
 */
export const limpiarMensajeProveedor = (msg?: string): string => {
    if (!msg) return ''
    return msg
        .replace(/\[Resource:[^\]]*\]\s*:?/gi, '')
        .replace(/Externo:\s*[^-]*-\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim()
}

/**
 * Hace polling del estado de un reporte hasta que hay documento, el proceso
 * termina sin documento, o se agota el tiempo. A los ~20s avisa al usuario que
 * seguimos trabajando (usando el `avisar` inyectado, opcional).
 */
export const esperarPdf = async (
    id: string,
    etiqueta: string,
    deps: {
        log: LogFn
        /** Traza de dominio (opcional). */
        trace?: (etapa: string, paso: string, detalle?: Record<string, unknown>) => void
        /** Aviso de demora al usuario (opcional). */
        avisar?: () => Promise<void>
    },
): Promise<ResultadoReporte> => {
    const { log, trace, avisar } = deps
    let avisado = false
    // Espera inicial GENEROSA antes de la 1ª consulta: el documento tarda en
    // generarse y preguntar de inmediato solo añade carga inútil al servicio.
    await esperar(DELAY_INICIAL_MS)
    for (let intento = 0; intento < MAX_REINTENTOS; intento++) {
        try {
            const res = await fetch(`${STATUS_API}?id=${encodeURIComponent(id)}`, { method: 'GET' })
            const data = (await res.json()) as {
                url?: string; status?: string; message?: string
                Url?: string; urlReport?: string; reportUrl?: string; downloadUrl?: string
            }
            log(`[${etiqueta}] intento ${intento + 1}:`, data.status ?? '')

            const urlDoc = data.url ?? data.Url ?? data.urlReport ?? data.reportUrl ?? data.downloadUrl

            if (data.status === 'FinishedProcess' && urlDoc) {
                return { estado: 'listo', url: urlDoc }
            }
            if (data.status === 'FinishedProcess' && !urlDoc) {
                log(`[${etiqueta}] FinishedProcess sin url. Payload:`, JSON.stringify(data))
                return { estado: 'sin_documento', mensaje: data.message }
            }
            if (data.status === 'ErrorInProcess') {
                log(`[${etiqueta}] ErrorInProcess:`, data.message ?? '')
                return { estado: 'sin_documento', mensaje: data.message }
            }
        } catch (err) {
            log(`[${etiqueta}] intento ${intento + 1} error:`, String(err))
        }

        // Tras la primera consulta (ya pasaron ~40s de espera inicial), si aún
        // no está listo, avisamos UNA vez al usuario que seguimos trabajando.
        if (!avisado && intento === 0 && avisar) {
            avisado = true
            trace?.(etiqueta, 'demora_en_proceso', { reporteId: id })
            await avisar()
        }

        // Espera entre consultas (no tras la última, para no demorar el timeout).
        if (intento < MAX_REINTENTOS - 1) {
            await esperar(INTERVALO_MS)
        }
    }
    log(`[${etiqueta}] Tiempo de espera agotado`)
    return { estado: 'timeout' }
}
