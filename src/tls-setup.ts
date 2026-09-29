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
    } catch (err) {
        console.error('[tls] No se pudo cargar el CA extra:', err)
    }
}
