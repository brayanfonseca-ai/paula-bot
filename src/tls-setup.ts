// ============================================================================
// TLS SETUP — confianza en CA de inspección SSL (Acronis / DeviceLock, proxys)
// ----------------------------------------------------------------------------
// En entornos con antivirus/proxy que hacen "SSL inspection", la conexión a
// graph.facebook.com llega firmada por una CA local (ej. "Acronis International
// GmbH") en vez de la CA real de Meta. Node no la conoce y lanza
// SELF_SIGNED_CERT_IN_CHAIN, rompiendo el arranque del provider de Meta.
//
// Solución (segura): añadir ese CA a la cadena de confianza del agente HTTPS
// global, SIN desactivar la validación TLS. Se importa de primero en app.ts,
// antes de crear cualquier cliente HTTP. Si el archivo del CA no existe, no
// hace nada: el bot funciona igual en máquinas sin esa inspección.
// ============================================================================
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import https from 'https'
import tls from 'tls'

const CA_FILE = join(process.cwd(), 'certs', 'acronis-ca.pem')

if (existsSync(CA_FILE)) {
    try {
        const extraCa = readFileSync(CA_FILE, 'utf-8')
        // CAs raíz que Node ya trae + el CA extra de la herramienta de inspección.
        const bundle = [...tls.rootCertificates, extraCa]

        // Agente global: axios (usado por el provider de Meta) y otros clientes
        // https que no pasan un agente propio heredan esta configuración.
        https.globalAgent.options.ca = bundle

        console.log('[tls] CA extra cargada desde certs/acronis-ca.pem (inspección SSL detectada).')

        // --------------------------------------------------------------------
        // IMPORTANTE — `fetch` (undici) NO usa https.globalAgent.
        // ----------------------------------------------------------------------
        // Las llamadas a PhariTech (owner, extracto, retenciones, getStatus) usan
        // el `fetch` global de Node (undici), que mantiene su PROPIA cadena de
        // confianza y NO hereda `https.globalAgent.options.ca`. La única forma
        // fiable de que undici confíe en el CA de inspección, sin añadir la
        // dependencia `undici` (no instalada en el bot), es la variable de entorno
        // NODE_EXTRA_CA_CERTS, que Node lee AL ARRANCAR y aplica a https + fetch.
        //
        // Si no está definida (o no apunta a un CA válido), en entornos con
        // inspección SSL `fetch` fallará con SELF_SIGNED_CERT_IN_CHAIN, `crearReporte`
        // devolverá null y el usuario verá "No pudimos generar el documento" aunque
        // el PDF sí se genere. Aquí NO podemos arreglarlo en caliente (la variable
        // se lee en el bootstrap), así que avisamos de forma clara y accionable.
        // --------------------------------------------------------------------
        const extraCaEnv = process.env.NODE_EXTRA_CA_CERTS
        if (!extraCaEnv) {
            console.warn(
                '🟠 [tls] NODE_EXTRA_CA_CERTS NO está definida. `fetch` (undici) no ' +
                'confiará en el CA de inspección y las llamadas a PhariTech pueden ' +
                'fallar con SELF_SIGNED_CERT_IN_CHAIN. Define ' +
                'NODE_EXTRA_CA_CERTS=./certs/acronis-ca.pem en el .env del bot ' +
                '(o en el entorno del proceso / PM2) y reinícialo.',
            )
        } else {
            console.log('[tls] NODE_EXTRA_CA_CERTS =', extraCaEnv, '(fetch/undici confiará en este CA).')
        }
    } catch (err) {
        console.error('[tls] No se pudo cargar el CA extra:', err)
    }
}
