// ============================================================================
// WS-07 — Transporte WhatsApp (envío de mensajes por la Graph API de Meta).
// Extraído de app.ts. Agrupa todos los envíos salientes (texto, botones,
// listas, documentos, imágenes) y su persistencia en el histórico. No mantiene
// estado propio: se construye con `crearTransporteWa(deps)` inyectando el
// acceso al provider (lazy), el logger y el persistidor del histórico. Así el
// flujo/estado del bot queda separado del detalle del canal.
//
// SOPORTE DE USERNAMES/BSUID (Meta 2026): algunos usuarios llegan SIN teléfono;
// su identidad es un BSUID (p. ej. "CO.1382579090194370"). Para RESPONDERLES,
// Meta NO acepta el BSUID en el campo `to` (da "Message Undeliverable"); hay que
// usar el campo `recipient`. El provider de BuilderBot solo sabe enviar con
// `to`, así que para destinatarios BSUID enviamos DIRECTO por la Graph API con
// `recipient`. Para teléfonos normales seguimos usando el provider (sin cambios).
// La distinción es simple: un teléfono es puramente numérico; un BSUID no lo es.
// ============================================================================

export type FilaLista = { id: string; title: string; description?: string }
export type SeccionLista = { title: string; rows: FilaLista[] }

type LogFn = (...args: unknown[]) => void

/** Tipo de saliente persistido en el histórico (alineado con MessageType). */
type TipoSaliente = 'text' | 'image' | 'document' | 'system_event'

export interface TransporteWaDeps {
    /** Devuelve el provider de BuilderBot ya inicializado (lazy: se resuelve en runtime). */
    getProvider: () => {
        sendText: (numero: string, mensaje: string) => Promise<unknown>
        sendMessageMeta: (payload: Record<string, unknown>) => Promise<unknown>
    }
    log: LogFn
    /** Persiste un saliente del bot en el histórico (content + displayText legible). */
    persistir: (
        numero: string,
        content: string,
        type: TipoSaliente,
        displayText?: string,
    ) => void
    /** Credenciales de Meta para el envío directo por Graph API (caso BSUID). */
    meta: {
        token: string
        numberId: string
        version: string
    }
}

export interface TransporteWa {
    enviarTexto: (numero: string, mensaje: string) => Promise<void>
    enviarBotones: (
        numero: string,
        mensaje: string,
        opciones: { id: string; title: string }[],
    ) => Promise<void>
    enviarLista: (
        numero: string,
        mensaje: string,
        boton: string,
        filasOSecciones: FilaLista[] | SeccionLista[],
        header?: string,
    ) => Promise<void>
    enviarPdf: (numero: string, pdfUrl: string, filename: string, caption: string) => Promise<void>
    enviarImagen: (numero: string, imgUrl: string, caption: string) => Promise<void>
    /** Envía una imagen ya subida a Meta por su media_id (sin URL pública). */
    enviarImagenPorId: (numero: string, mediaId: string, caption: string) => Promise<void>
    /** Envía un documento ya subido a Meta por su media_id (sin URL pública). */
    enviarDocumentoPorId: (
        numero: string,
        mediaId: string,
        filename: string,
        caption: string,
    ) => Promise<void>
}

/** Extrae el detalle real de un error de la Graph API (Axios) para logging útil. */
export const errDetalle = (err: unknown): string => {
    const data = (err as { response?: { data?: unknown } })?.response?.data
    if (data) return typeof data === 'string' ? data : JSON.stringify(data)
    return String(err)
}

/**
 * ¿El identificador es un teléfono? Un teléfono es puramente numérico (admite
 * un '+' inicial). Un BSUID NO lo es (p. ej. "CO.1382579090194370"). Esta es la
 * señal que usamos para decidir `to` (teléfono) vs `recipient` (BSUID).
 */
export const esTelefono = (destino: string): boolean =>
    /^\+?\d{6,}$/.test(String(destino ?? '').trim())

/**
 * Construye el transporte WhatsApp con las dependencias inyectadas. Cada envío
 * es tolerante a fallos: registra el error (no lanza) para no tumbar el flujo.
 */
export const crearTransporteWa = (deps: TransporteWaDeps): TransporteWa => {
    const { getProvider, log, persistir, meta } = deps

    /**
     * Envío DIRECTO por la Graph API para destinatarios BSUID. Arma el payload
     * con `recipient` (no `to`) e inyecta el objeto de mensaje (text/image/etc.).
     * Devuelve true si Meta aceptó (2xx). Nunca lanza.
     */
    const enviarPorRecipient = async (
        bsuid: string,
        mensajeObj: Record<string, unknown>,
    ): Promise<boolean> => {
        try {
            const url = `https://graph.facebook.com/${meta.version}/${meta.numberId}/messages`
            // El BSUID se persiste a veces con un '+' delante (la normalización
            // E.164 antepone '+' a todo identificador sin él). Meta NO acepta el
            // BSUID con '+' en `recipient` (lo rechaza como "Message Undeliverable"
            // y el saliente queda PENDING). El BSUID real NO lleva '+' (p. ej.
            // "CO.1382579090194370"), así que lo quitamos antes de enviar.
            const recipient = String(bsuid ?? '').trim().replace(/^\+/, '')
            const payload = {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                recipient,
                ...mensajeObj,
            }
            // Reintenta ante fallo de RED transitorio ("fetch failed" en frío).
            for (let i = 1; i <= 3; i++) {
                try {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${meta.token}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload),
                    })
                    const detalle = await res.text()
                    log('[wa:bsuid] META STATUS', res.status, detalle.slice(0, 400))
                    return res.ok
                } catch (err) {
                    log(`[wa:bsuid] intento ${i}/3 falló (red):`, String(err))
                    if (i < 3) await new Promise((r) => setTimeout(r, 400))
                }
            }
            return false
        } catch (err) {
            log('[wa:bsuid] Error enviando por recipient:', errDetalle(err))
            return false
        }
    }

    const enviarTexto = async (numero: string, mensaje: string): Promise<void> => {
        try {
            if (esTelefono(numero)) {
                await getProvider().sendText(numero, mensaje)
            } else {
                await enviarPorRecipient(numero, { type: 'text', text: { body: mensaje } })
            }
            persistir(numero, mensaje, 'text')
        } catch (err) {
            log('[wa] Error sendText:', errDetalle(err))
        }
    }

    const enviarBotones = async (
        numero: string,
        mensaje: string,
        opciones: { id: string; title: string }[],
    ): Promise<void> => {
        try {
            const interactive = {
                type: 'button',
                body: { text: mensaje },
                action: {
                    buttons: opciones.map((o) => ({
                        type: 'reply',
                        reply: { id: o.id, title: o.title.slice(0, 20) },
                    })),
                },
            }
            if (esTelefono(numero)) {
                await getProvider().sendMessageMeta({
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: numero,
                    type: 'interactive',
                    interactive,
                })
            } else {
                await enviarPorRecipient(numero, { type: 'interactive', interactive })
            }
            const opcionesTxt = opciones.map((o) => `• ${o.title}`).join('\n')
            persistir(numero, mensaje, 'text', `${mensaje}\n${opcionesTxt}`)
        } catch (err) {
            log('[wa] Error botones:', errDetalle(err))
        }
    }

    const enviarLista = async (
        numero: string,
        mensaje: string,
        boton: string,
        filasOSecciones: FilaLista[] | SeccionLista[],
        header?: string,
    ): Promise<void> => {
        try {
            const esSecciones =
                filasOSecciones.length > 0 && (filasOSecciones as SeccionLista[])[0].rows !== undefined
            const sections: SeccionLista[] = esSecciones
                ? (filasOSecciones as SeccionLista[])
                : [{ title: 'Opciones', rows: filasOSecciones as FilaLista[] }]

            const interactive: Record<string, unknown> = {
                type: 'list',
                body: { text: mensaje },
                action: { button: boton, sections },
            }
            if (header) interactive.header = { type: 'text', text: header }

            if (esTelefono(numero)) {
                await getProvider().sendMessageMeta({
                    messaging_product: 'whatsapp',
                    recipient_type: 'individual',
                    to: numero,
                    type: 'interactive',
                    interactive,
                })
            } else {
                await enviarPorRecipient(numero, { type: 'interactive', interactive })
            }
            const filas = sections.flatMap((s) => s.rows.map((r) => `• ${r.title}`)).join('\n')
            const encabezado = header ? `${header}\n` : ''
            persistir(numero, mensaje, 'text', `${encabezado}${mensaje}\n${filas}`)
        } catch (err) {
            log('[wa] Error lista:', errDetalle(err))
        }
    }

    const enviarPdf = async (
        numero: string,
        pdfUrl: string,
        filename: string,
        caption: string,
    ): Promise<void> => {
        try {
            const doc = { link: pdfUrl, filename, caption }
            if (esTelefono(numero)) {
                await getProvider().sendMessageMeta({
                    messaging_product: 'whatsapp',
                    to: numero,
                    type: 'document',
                    document: doc,
                })
            } else {
                await enviarPorRecipient(numero, { type: 'document', document: doc })
            }
            persistir(
                numero,
                caption || filename,
                'document',
                `📎 ${filename}${caption ? ' — ' + caption : ''}\n${pdfUrl}`,
            )
        } catch (err) {
            log('[wa] Error enviando PDF:', errDetalle(err))
        }
    }

    const enviarImagen = async (numero: string, imgUrl: string, caption: string): Promise<void> => {
        try {
            const img = { link: imgUrl, caption }
            if (esTelefono(numero)) {
                await getProvider().sendMessageMeta({
                    messaging_product: 'whatsapp',
                    to: numero,
                    type: 'image',
                    image: img,
                })
            } else {
                await enviarPorRecipient(numero, { type: 'image', image: img })
            }
            persistir(numero, caption || 'Imagen', 'image', `🖼️ ${caption || 'Imagen'}\n${imgUrl}`)
        } catch (err) {
            log('[wa] Error enviando imagen:', errDetalle(err))
        }
    }

    // Envía una imagen por media_id (archivo previamente subido a Meta). No
    // requiere URL pública: Meta ya tiene el archivo. Ideal para servidores
    // internos sin dominio/HTTPS.
    const enviarImagenPorId = async (
        numero: string,
        mediaId: string,
        caption: string,
    ): Promise<void> => {
        try {
            const img = { id: mediaId, caption }
            if (esTelefono(numero)) {
                await getProvider().sendMessageMeta({
                    messaging_product: 'whatsapp',
                    to: numero,
                    type: 'image',
                    image: img,
                })
            } else {
                await enviarPorRecipient(numero, { type: 'image', image: img })
            }
            persistir(numero, caption || 'Imagen', 'image', `🖼️ ${caption || 'Imagen'}`)
        } catch (err) {
            log('[wa] Error enviando imagen por id:', errDetalle(err))
        }
    }

    // Envía un documento por media_id (archivo ya subido a Meta). No requiere
    // URL pública. Se usa para la política de tratamiento de datos (PDF).
    const enviarDocumentoPorId = async (
        numero: string,
        mediaId: string,
        filename: string,
        caption: string,
    ): Promise<void> => {
        try {
            const doc = { id: mediaId, filename, caption }
            if (esTelefono(numero)) {
                await getProvider().sendMessageMeta({
                    messaging_product: 'whatsapp',
                    to: numero,
                    type: 'document',
                    document: doc,
                })
            } else {
                await enviarPorRecipient(numero, { type: 'document', document: doc })
            }
            persistir(numero, caption || filename, 'document', `📎 ${filename}${caption ? ' — ' + caption : ''}`)
        } catch (err) {
            log('[wa] Error enviando documento por id:', errDetalle(err))
        }
    }

    return {
        enviarTexto,
        enviarBotones,
        enviarLista,
        enviarPdf,
        enviarImagen,
        enviarImagenPorId,
        enviarDocumentoPorId,
    }
}
