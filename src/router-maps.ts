// ============================================================================
// WS-07 — Normalización de opciones del router (módulo puro y testeable).
// Extraído de app.ts. Traduce lo que llega de WhatsApp (id de lista o título
// de botón) al id canónico que entiende el router de app.ts.
// ============================================================================

// Mapa título→id para los BOTONES de respuesta. En BuilderBot/Meta, al tocar
// un botón llega su TÍTULO en ctx.body (no el id); las listas sí devuelven el id.
// Aquí normalizamos los títulos de botones a los ids que usa el router.
export const TITULO_A_ID: Record<string, string> = {
    'continuar': 'continuar',
    'no soy yo': 'no_soy_yo',
    'sí': 'otra_si',
    'si': 'otra_si',
    'no': 'otra_no',
    'hablar con agente': 'agente',
    'necesito un asesor': 'agente_humano',
    'hablar con un asesor': 'agente_humano',
    'salir': 'salir',
    'volver al menú': 'volver_menu',
    'volver al menu': 'volver_menu',
    'rete ica': 'rete_ica',
    'rete fuente': 'rete_fuente',
    'sí, soy yo': 'continuar',
    'si, soy yo': 'continuar',
    'sí, gracias': 'otra_si',
    'si, gracias': 'otra_si',
    'no, finalizar': 'otra_no',
    // Política de tratamiento de datos.
    'acepto': 'acepto_politica',
    'no acepto': 'rechazo_politica',
}

// Prefijos/ids de navegación que ya vienen canónicos (listas y acciones).
const RE_IDS_CONOCIDOS =
    /^(owner_|menu_|anio_|mes_|mas_meses|ret_anio_|rete_|volver_menu|continuar|no_soy_yo|otra_|agente_humano|agente|salir|acepto_politica|rechazo_politica)/

/**
 * Normaliza lo recibido: si es un id conocido lo deja; si es el título de un
 * botón, lo convierte a su id; los años (2024) de botones se marcan como
 * `year_<n>` para que el router resuelva extracto vs retención por contexto.
 */
export const normalizarOpcion = (raw: string): string => {
    const v = raw.trim()
    if (RE_IDS_CONOCIDOS.test(v)) return v
    const lower = v.toLowerCase()
    if (TITULO_A_ID[lower]) return TITULO_A_ID[lower]
    if (/^\d{4}$/.test(v)) return `year_${v}`
    return v
}

/**
 * Heurística: ¿el mensaje entrante PARECE una respuesta interactiva (id de
 * lista, título de botón o año) más que texto libre? Se usa en el flujo para
 * decidir si enrutar o reencaminar al menú.
 */
export const pareceInteractivo = (tipo: string, bodyRaw: string): boolean =>
    tipo === 'interactive' ||
    tipo === 'button' ||
    RE_IDS_CONOCIDOS.test(bodyRaw) ||
    /^\d{4}$/.test(bodyRaw) ||
    !!TITULO_A_ID[bodyRaw.toLowerCase()]
