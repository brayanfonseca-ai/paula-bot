// ============================================================================
// Subida de medios a WhatsApp Cloud API (Graph /media).
// WhatsApp NO puede descargar imágenes desde URLs privadas (localhost, red
// interna) ni sin HTTPS. Para enviar una imagen propia sin exponerla en
// internet, se SUBE el archivo a Meta una vez y se obtiene un `media_id`
// reutilizable; luego los mensajes referencian ese id en vez de un `link`.
//
// Aquí subimos `assets/factura.jpeg` al arrancar y cacheamos su media_id.
// ============================================================================
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { META_JWT_TOKEN, META_NUMBER_ID, META_VERSION } from './config'

type LogFn = (...args: unknown[]) => void

/**
 * Sube un archivo local a la Graph API y devuelve su media_id (o null si falla).
 * Usa fetch/FormData nativos de Node (>=18). El media_id es reutilizable para
 * múltiples envíos y no requiere que el archivo sea público.
 */
export const subirMediaLocal = async (
    rutaRelativa: string,
    mimeType: string,
    log: LogFn,
): Promise<string | null> => {
    try {
        const ruta = join(process.cwd(), rutaRelativa)
        const contenido = await readFile(ruta)
        const form = new FormData()
        form.append('messaging_product', 'whatsapp')
        form.append(
            'file',
            new Blob([new Uint8Array(contenido)], { type: mimeType }),
            rutaRelativa.split(/[\\/]/).pop() ?? 'archivo',
        )
        const url = `https://graph.facebook.com/${META_VERSION}/${META_NUMBER_ID}/media`
        const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${META_JWT_TOKEN}` },
            body: form,
        })
        const data = (await res.json()) as { id?: string; error?: unknown }
        if (!res.ok || !data.id) {
            log('[media] Falló la subida a Meta:', res.status, JSON.stringify(data))
            return null
        }
        log('[media] Subida OK, media_id:', data.id)
        return data.id
    } catch (err) {
        log('[media] Error subiendo media:', String(err))
        return null
    }
}
