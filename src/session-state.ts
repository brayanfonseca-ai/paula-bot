// ============================================================================
// WS-07 — Estado de sesión en memoria (write-through de flow_context en BD).
// Extraído de app.ts. Concentra el Map SESIONES y el ciclo de vida de la
// sesión (resolver/crear/cerrar) + la (des)hidratación del contexto temporal.
// La BD (PostgreSQL, vía repo) es la fuente de verdad; este Map es solo caché.
// El logger se inyecta una vez con `configurarLogger` para no acoplar este
// módulo al sistema de logs concreto de app.ts.
// ============================================================================
import * as repo from './repository'
import type { Propietario } from './pharitech'

export interface Sesion {
    propietario?: Propietario
    propietarios?: Propietario[]
    year?: number
    month?: number
    tipoRetencion?: 'ICA' | 'FUENTE'
    retencionYear?: number
    procesando?: boolean
    /** Id de la sesión persistida en PostgreSQL (une memoria con BD). */
    sessionId?: string
}

export type MotivoCierre =
    | 'USER_FINISHED'
    | 'AGENT_FINISHED'
    | 'TIMEOUT'
    | 'MANUAL'
    | 'SYSTEM_ERROR'

type LogFn = (...args: unknown[]) => void
let log: LogFn = (...args) => console.log(...args)
/** Inyecta el logger de la app (se llama una vez al arrancar). */
export const configurarLogger = (fn: LogFn): void => {
    log = fn
}

// Caché en memoria del contexto de flujo por número. Write-through de
// `flow_context` en BD: nunca autoritativa; se hidrata desde BD y se persiste
// tras cada cambio, sobreviviendo reinicios y cambios hechos desde el portal.
export const SESIONES = new Map<string, Sesion>()

export const getSesion = (numero: string): Sesion => {
    if (!SESIONES.has(numero)) SESIONES.set(numero, {})
    return SESIONES.get(numero) as Sesion
}

/** Vuelca el contexto de memoria (propietario/año/mes/…) a flow_context en BD. */
export const persistirContexto = async (numero: string): Promise<void> => {
    const mem = getSesion(numero)
    if (!mem.sessionId) return
    try {
        await repo.actualizarSesion(mem.sessionId, {
            flowContext: {
                propietario: mem.propietario ?? null,
                propietarios: mem.propietarios ?? null,
                year: mem.year ?? null,
                month: mem.month ?? null,
                tipoRetencion: mem.tipoRetencion ?? null,
                retencionYear: mem.retencionYear ?? null,
            },
        })
    } catch (err) {
        log('[db] No se pudo persistir flow_context:', String(err))
    }
}

/** Reconstruye el contexto en memoria a partir de flow_context de la BD. */
export const hidratarContexto = (
    mem: Sesion,
    ctx: Record<string, unknown> | null | undefined,
): void => {
    if (!ctx) return
    mem.propietario = (ctx.propietario as Propietario) ?? undefined
    mem.propietarios = (ctx.propietarios as Propietario[]) ?? undefined
    mem.year = (ctx.year as number) ?? undefined
    mem.month = (ctx.month as number) ?? undefined
    mem.tipoRetencion = (ctx.tipoRetencion as 'ICA' | 'FUENTE') ?? undefined
    mem.retencionYear = (ctx.retencionYear as number) ?? undefined
}

/**
 * Garantiza una sesión ABIERTA en BD para el número y sincroniza el contexto en
 * memoria (RF-003/004): si la cacheada fue cerrada o ya no existe, abre una
 * NUEVA y descarta el contexto anterior; tras reinicio (Map vacío) rehidrata.
 */
export const resolverSesion = async (
    numero: string,
    nombrePerfil?: string,
): Promise<{ sessionId: string; creada: boolean }> => {
    const mem = getSesion(numero)
    const abierta = await repo.sesionAbiertaDe(numero)

    if (abierta) {
        const cambioDeSesion = mem.sessionId !== abierta.sessionId
        if (cambioDeSesion) {
            SESIONES.set(numero, { sessionId: abierta.sessionId })
            hidratarContexto(getSesion(numero), abierta.flowContext as Record<string, unknown> | null)
        }
        if (nombrePerfil) {
            void repo.upsertContacto(numero, nombrePerfil).catch(() => {})
        }
        return { sessionId: abierta.sessionId, creada: false }
    }

    // Ventana de reactivación (24h): si la última sesión se cerró por inactividad
    // pero el cliente vuelve a escribir dentro de la ventana, se REUTILIZA la
    // MISMA sesión (mismo sessionId) en vez de abrir una nueva. Así el asesor
    // retoma la conversación previa y el historial continúa. No se trata como
    // sesión nueva (creada:false) => el bot NO relanza el saludo inicial.
    const reactivable = await repo.sesionReactivableDe(numero)
    if (reactivable) {
        try {
            await repo.reabrirSesion(reactivable.sessionId)
        } catch (err) {
            log('[sesion] no se pudo reabrir sesión reactivable:', String(err))
        }
        SESIONES.set(numero, { sessionId: reactivable.sessionId })
        hidratarContexto(
            getSesion(numero),
            reactivable.flowContext as Record<string, unknown> | null,
        )
        if (nombrePerfil) {
            void repo.upsertContacto(numero, nombrePerfil).catch(() => {})
        }
        return { sessionId: reactivable.sessionId, creada: false }
    }

    const { sesion } = await repo.obtenerOCrearSesion(numero, nombrePerfil)
    SESIONES.set(numero, { sessionId: sesion.sessionId })
    return { sessionId: sesion.sessionId, creada: true }
}

/** Devuelve el sessionId de BD del número (garantizando sesión abierta). */
export const getSessionId = async (numero: string): Promise<string> => {
    const { sessionId } = await resolverSesion(numero)
    return sessionId
}

/** Cierra la sesión en BD y limpia el estado en memoria del número. */
export const finalizarSesion = async (
    numero: string,
    motivo: MotivoCierre,
): Promise<void> => {
    try {
        const sessionId = SESIONES.get(numero)?.sessionId
        if (sessionId) await repo.cerrarSesion(sessionId, motivo)
    } catch (err) {
        log('[db] Error cerrando sesión:', String(err))
    }
    SESIONES.delete(numero)
}
