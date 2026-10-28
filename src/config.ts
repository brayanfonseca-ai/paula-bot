// ============================================================================
// WS-07 — Configuración del bot (constantes + credenciales de Meta).
// Extraído de app.ts para separar la CONFIG del flujo conversacional. Módulo
// puro (sin estado ni efectos salvo la validación de credenciales al importar).
// ============================================================================

// --- Puerto del servidor HTTP del bot. ---
export const PORT = process.env.PORT ?? 3008

// ============================================================================
// CREDENCIALES DE META (desde variables de entorno / archivo .env).
// Se cargan con `node --env-file=.env`. No se hardcodean para no exponerlas.
// ============================================================================
export const META_JWT_TOKEN = process.env.META_JWT_TOKEN ?? ''
export const META_NUMBER_ID = process.env.META_NUMBER_ID ?? ''
export const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? ''
// v26.0: necesaria para el campo `recipient` (envío a usuarios BSUID/username).
export const META_VERSION = process.env.META_VERSION ?? 'v26.0'

/**
 * Verifica que existan las credenciales mínimas de Meta. Si faltan, termina el
 * proceso (el bot no puede operar sin ellas). Se invoca explícitamente desde el
 * arranque para mantener el import de este módulo libre de efectos.
 */
export const validarCredencialesMeta = (): void => {
    if (!META_JWT_TOKEN || !META_NUMBER_ID || !META_VERIFY_TOKEN) {
        console.error(
            '🟠 Faltan credenciales de Meta. Copia .env.example a .env y completa ' +
            'META_JWT_TOKEN, META_NUMBER_ID y META_VERIFY_TOKEN.',
        )
        process.exit(1)
    }
}

// ============================================================================
// CONFIGURACIÓN de negocio (replicada del proyecto Python paula_whatsapp).
// ============================================================================
export const COMPANY_ID = 409
export const APPLICANT = 'SYSTEM'

export const OWNER_URL = 'https://api-astrans.pharitechservices.com/partner/owner/'
export const EXTRACT_API = 'https://api-seven.pharitechservices.com/certificate/extract'
export const ICA_API = 'https://api-seven.pharitechservices.com/certificate/withholdings'
export const FUENTE_API = 'https://api-seven.pharitechservices.com/certificate/withholdingsSource'
export const STATUS_API = 'https://reports.phari-tech.co/report/getStatus'

// URL pública base con la que Meta/WhatsApp puede alcanzar a ESTE bot para
// descargar recursos (p. ej. la imagen de facturación). En producción debe ser
// el host/HTTPS accesible desde internet; por defecto usa localhost:PORT (solo
// sirve si el servidor es alcanzable en esa dirección). Configurable por env.
export const PUBLIC_BASE_URL =
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`

// Imagen de Facturación electrónica (Radicación de factura). Se sirve desde el
// propio bot (assets/factura.jpeg) vía la ruta /v1/assets/factura, para no
// depender de imágenes externas de prueba. Puede sobreescribirse con
// FACTURACION_IMG si se prefiere alojar la imagen en otro lugar (CDN/HTTPS).
export const FACTURACION_IMG =
    process.env.FACTURACION_IMG ?? `${PUBLIC_BASE_URL}/v1/assets/factura`

// Política de tratamiento de datos: el PDF (assets/politica.pdf) se sube a Meta
// al arrancar y se envía por media_id tras la primera autenticación. La versión
// permite re-solicitar la aceptación si el documento cambia (basta con subir el
// PDF nuevo y cambiar POLITICA_VERSION).
export const POLITICA_VERSION = process.env.POLITICA_VERSION ?? 'v2-2026'
export const POLITICA_PDF_NOMBRE = 'Politica_Tratamiento_Datos_Vigia.pdf'

// ============================================================================
// Polling de estado del reporte (PhariTech getStatus).
// IMPORTANTE: consultar muy seguido SATURA el servicio de reportes y lo tumba.
// Por eso: (1) esperamos un tiempo inicial GENEROSO antes de la 1ª consulta
// (el documento tarda en generarse, no tiene sentido preguntar de inmediato),
// y (2) espaciamos las consultas. Todo configurable por .env.
//
//   - DELAY_INICIAL_MS: espera antes de la PRIMERA consulta de status (~40s).
//   - INTERVALO_MS: tiempo entre consultas sucesivas (~10s).
//   - MAX_REINTENTOS: nº de consultas. Ventana total ≈ DELAY_INICIAL + N*INTERVALO.
//     Con 40s + 20 x 10s = ~240s (4 min), suficiente y con MUCHA menos carga
//     que el polling agresivo anterior (2s), que colapsaba el servicio.
// ============================================================================
/** Espera (ms) antes de la primera consulta de estado. Da tiempo a que PhariTech genere (~40s). */
export const DELAY_INICIAL_MS = Number(process.env.REPORT_INITIAL_DELAY_MS ?? 40000)
/** Tiempo (ms) entre consultas de estado sucesivas (~30s para NO saturar el servicio). */
export const INTERVALO_MS = Number(process.env.REPORT_POLL_INTERVAL_MS ?? 30000)
/** Nº máximo de consultas de estado antes de rendirse. 40s + 10 x 30s ≈ 340s. */
export const MAX_REINTENTOS = Number(process.env.REPORT_MAX_ATTEMPTS ?? 10)

// Antigüedad máxima (segundos) de un mensaje entrante de WhatsApp para
// procesarlo. Meta reintrega los webhooks pendientes tras una caída/reinicio
// del bot; sin este filtro, un mensaje viejo reintentado vuelve a disparar el
// flujo (p. ej. reabrir la sesión y remostrar el menú/autenticación) sin que el
// usuario haya escrito nada nuevo. Los mensajes con timestamp anterior a
// (ahora - este umbral) se registran pero NO se procesan. 0 = desactiva el filtro.
export const INBOUND_MAX_AGE_SECONDS = Number(process.env.INBOUND_MAX_AGE_SECONDS ?? 120)

// ============================================================================
// AGENTE IA (Amazon Bedrock AgentCore vía la API orquestadora - Lambda).
// Cuando el usuario elige "hablar con agente", la sesión pasa a modo AGENT:
// el asesor recibe la notificación de monitoreo Y el bot sigue respondiendo con
// las respuestas de esta API. El bot NO guarda credenciales de AWS: toda la
// lógica de Bedrock vive en la Lambda; aquí solo se consume el endpoint HTTP.
// ============================================================================

/** Endpoint de la API del agente (Lambda orquestadora). POST con { message, sessionId }. */
export const AGENT_API_URL =
    process.env.AGENT_API_URL ??
    'https://e4vbnziokk.execute-api.us-east-2.amazonaws.com/Prod/chat'

/**
 * Timeout (ms) de la llamada del bot a la API del agente. La Lambda tiene un
 * límite de 180 s; dejamos un poco menos para no colgar el flujo indefinidamente.
 */
export const AGENT_API_TIMEOUT_MS = Number(process.env.AGENT_API_TIMEOUT_MS ?? 150000)

/**
 * Vida (ms) del hilo de conversación con el agente (bedrockSessionId). Alineado
 * con el cierre de sesión por inactividad (SESSION_TIMEOUT_MS, 10 min): pasado
 * este tiempo sin actividad, el vínculo se considera vencido y el siguiente
 * turno arranca un hilo nuevo (la Lambda genera un sessionId nuevo).
 */
export const AGENT_SESSION_TTL_MS = Number(
    process.env.AGENT_SESSION_TTL_MS ?? process.env.SESSION_TIMEOUT_MS ?? 10 * 60 * 1000,
)

/** Nombre genérico del documento cuando el agente devuelve un PDF (el usuario lo renombra). */
export const AGENT_PDF_FILENAME = process.env.AGENT_PDF_FILENAME ?? 'Documento.pdf'

/** Espera `ms` milisegundos (util para el polling de reportes). */
export const esperar = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms))
