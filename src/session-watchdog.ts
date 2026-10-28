// ============================================================================
// Watchdog de inactividad de sesiones (FUNC-002).
// Cada cierto intervalo busca sesiones abiertas sin actividad del usuario desde
// hace más de SESSION_TIMEOUT_MS (default 10 min), las cierra por inactividad
// (invalidando el contexto temporal, conservando el historial) y avisa al
// usuario. La próxima vez que escriba se creará una nueva sesión (menú principal).
//
// Reutiliza el patrón de polling del worker de salida en vez de introducir
// infraestructura nueva (EventBridge/Lambda no aplica: despliegue on-prem).
// ============================================================================
import * as repo from './repository'

type EnviarTexto = (numero: string, mensaje: string) => Promise<void>
type LogFn = (...args: unknown[]) => void
type OlvidarMemoria = (numero: string) => void

const MENSAJE_INACTIVIDAD =
  'Tu sesión ha sido finalizada por inactividad. ⏳\n' +
  'Cuando quieras continuar, escríbeme nuevamente y con gusto te ayudo. 👋'

export interface WatchdogOpts {
  enviarTexto: EnviarTexto
  log: LogFn
  /** Limpia la entrada en memoria del número (Map SESIONES). */
  olvidarMemoria: OlvidarMemoria
  /** Umbral de inactividad en ms (default 10 min). */
  timeoutMs?: number
  /** Intervalo de barrido en ms (default 60 s). */
  intervaloMs?: number
}

/** Inicia el watchdog. Devuelve una función para detenerlo. */
export const iniciarWatchdogSesiones = (opts: WatchdogOpts): (() => void) => {
  const timeoutMs = opts.timeoutMs ?? Number(process.env.SESSION_TIMEOUT_MS ?? 10 * 60 * 1000)
  const intervaloMs = opts.intervaloMs ?? Number(process.env.SESSION_SWEEP_MS ?? 60 * 1000)
  const { enviarTexto, log, olvidarMemoria } = opts

  let activo = true
  let corriendo = false

  const ciclo = async () => {
    if (!activo || corriendo) return
    corriendo = true
    try {
      // Limpia los vínculos del agente IA ya vencidos (hilos que caducaron sin
      // que la sesión se cerrara por inactividad, p. ej. si el usuario siguió en
      // otro flujo). Evita reanudar hilos viejos. Best-effort.
      try {
        const purgadas = await repo.purgarAgentSessionsVencidas()
        if (purgadas > 0) log('[watchdog] vínculos de agente IA vencidos purgados:', purgadas)
      } catch (err) {
        log('[watchdog] error purgando vínculos de agente IA:', String(err))
      }

      const vencidas = await repo.sesionesInactivas(timeoutMs)
      for (const s of vencidas) {
        try {
          await repo.cerrarSesionPorInactividad(s.sessionId)
          olvidarMemoria(s.phoneE164)
          // El número en BD está en E.164 (+57...); Meta espera sin '+'.
          const numero = s.phoneE164.replace(/^\+/, '')
          await enviarTexto(numero, MENSAJE_INACTIVIDAD)
          log('[watchdog] sesión cerrada por inactividad:', s.sessionId, s.phoneE164)
        } catch (err) {
          log('[watchdog] error cerrando sesión', s.sessionId, String(err))
        }
      }
    } catch (err) {
      log('[watchdog] error en ciclo:', String(err))
    } finally {
      corriendo = false
    }
  }

  const timer = setInterval(ciclo, intervaloMs)
  log('[watchdog] iniciado: timeout', timeoutMs, 'ms, barrido cada', intervaloMs, 'ms')
  return () => {
    activo = false
    clearInterval(timer)
    log('[watchdog] detenido')
  }
}
