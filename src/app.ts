import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'

const PORT = process.env.PORT ?? 3008

// ============================================================================
// CONFIGURACIÓN (replicada del proyecto Python paula_whatsapp/sam-app)
// ============================================================================
const COMPANY_ID = 409
const APPLICANT = 'SYSTEM'

const OWNER_URL = 'https://api-astrans.pharitechservices.com/partner/owner/'
const EXTRACT_API = 'https://api-seven.pharitechservices.com/certificate/extract'
const ICA_API = 'https://api-seven.pharitechservices.com/certificate/withholdings'
const FUENTE_API = 'https://api-seven.pharitechservices.com/certificate/withholdingsSource'
const STATUS_API = 'https://reports.phari-tech.co/report/getStatus'

// Imagen de Facturación electrónica (Radicación de factura).
const FACTURACION_IMG =
    'https://yt3.googleusercontent.com/bAseQlKvNmjdLQrvYWm_q3QDp8C8YKyYI-nYJewgOkPi0JU1_3X9oFgjrEdzkOlXzLGFxFbnsw=s900-c-k-c0x00ffffff-no-rj'

const MESES = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

// Polling de estado del reporte. El servicio de reportes tiene latencia
// variable (a veces >60s), por eso esperamos hasta 60 intentos x 2s = 120s.
const MAX_REINTENTOS = 60
const INTERVALO_MS = 2000

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ============================================================================
// LOG a consola + archivo (revisable en /v1/logs)
// ============================================================================
const LOG_DIR = join(process.cwd(), 'logs')
const LOG_FILE = join(LOG_DIR, 'extracto.log')

const log = (...args: unknown[]) => {
    const linea = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    const registro = `[${new Date().toISOString()}] ${linea}`
    console.log(registro)
    try {
        mkdirSync(LOG_DIR, { recursive: true })
        appendFileSync(LOG_FILE, registro + '\n')
    } catch (err) {
        console.error('No se pudo escribir el log en archivo:', err)
    }
}

// ============================================================================
// TRAZABILIDAD PASO A PASO (para monitoreo / futura inserción en BD)
// ----------------------------------------------------------------------------
// Cada evento se imprime como una línea JSON con marca de tiempo, número,
// etapa, paso y datos. Está pensado para que un consumidor (worker, stream,
// etc.) capture estas líneas e inserte el rastro en una base de datos en
// tiempo real para una interfaz gráfica de monitoreo.
// Reemplaza el cuerpo de `persistirTraza` cuando conectes la BD real.
// ============================================================================
interface EventoTraza {
    ts: string
    numero: string
    etapa: string   // p.ej. 'sesion', 'menu', 'extracto', 'retencion', 'salida'
    paso: string    // p.ej. 'saludo', 'owner_ok', 'anio_seleccionado', 'pdf_enviado'
    detalle?: Record<string, unknown>
}

// Punto único de persistencia. Hoy imprime por consola; mañana escribe en BD.
const persistirTraza = (evento: EventoTraza) => {
    // TODO(BD): reemplazar por INSERT/stream a la base de datos de monitoreo.
    console.log('TRACE', JSON.stringify(evento))
    try {
        mkdirSync(LOG_DIR, { recursive: true })
        appendFileSync(join(LOG_DIR, 'traza.log'), JSON.stringify(evento) + '\n')
    } catch { /* noop */ }
}

// Helper para emitir un evento de traza de forma concisa.
const trace = (numero: string, etapa: string, paso: string, detalle?: Record<string, unknown>) => {
    persistirTraza({
        ts: new Date().toISOString(),
        numero,
        etapa,
        paso,
        detalle,
    })
}

// ============================================================================
// ESTADO EN MEMORIA POR NÚMERO (equivalente a SESIONES del proyecto Python)
// ============================================================================
interface Propietario {
    names: string
    nit: string | number
    [k: string]: unknown
}
interface Sesion {
    propietario?: Propietario
    propietarios?: Propietario[]
    year?: number
    month?: number
    tipoRetencion?: 'ICA' | 'FUENTE'
    retencionYear?: number
    procesando?: boolean
}
const SESIONES = new Map<string, Sesion>()

const getSesion = (numero: string): Sesion => {
    if (!SESIONES.has(numero)) SESIONES.set(numero, {})
    return SESIONES.get(numero) as Sesion
}

// ============================================================================
// REPORTES PENDIENTES (recuperación tras reinicio)
// ----------------------------------------------------------------------------
// El polling del PDF vive en memoria. Si el proceso se reinicia (deploy, guardar
// código con nodemon, crash) mientras un reporte está "InProgress", el usuario
// nunca recibiría su documento aunque el servicio lo genere después.
// Para evitarlo, cada reporte creado se persiste en disco; al arrancar el bot
// se reanuda el polling de los pendientes y se entrega el PDF al terminar.
// ============================================================================
interface ReportePendiente {
    id: string
    numero: string
    etiqueta: string   // 'extracto' | 'ica' | 'fuente'
    filename: string
    caption: string
    mensajeExito: string
    creadoTs: string
}
const PENDIENTES_FILE = join(LOG_DIR, 'pendientes.json')

const leerPendientes = (): ReportePendiente[] => {
    try {
        if (!existsSync(PENDIENTES_FILE)) return []
        return JSON.parse(readFileSync(PENDIENTES_FILE, 'utf-8')) as ReportePendiente[]
    } catch {
        return []
    }
}

const guardarPendientes = (lista: ReportePendiente[]) => {
    try {
        mkdirSync(LOG_DIR, { recursive: true })
        writeFileSync(PENDIENTES_FILE, JSON.stringify(lista, null, 2))
    } catch (err) {
        console.error('No se pudo guardar pendientes:', err)
    }
}

const agregarPendiente = (p: ReportePendiente) => {
    const lista = leerPendientes().filter((x) => x.id !== p.id)
    lista.push(p)
    guardarPendientes(lista)
}

const quitarPendiente = (id: string) => {
    guardarPendientes(leerPendientes().filter((x) => x.id !== id))
}

// ============================================================================
// PROVIDER: acceso global para poder enviar mensajes desde los routers
// ============================================================================
let PROVIDER: any = null

// Extrae el detalle real de un error de la Graph API (Axios) para logging útil.
const errDetalle = (err: any): string => {
    const data = err?.response?.data
    if (data) return typeof data === 'string' ? data : JSON.stringify(data)
    return String(err)
}

// --- Envíos WhatsApp (usan la Graph API a través del provider de BuilderBot) ---
const enviarTexto = async (numero: string, mensaje: string) => {
    try {
        await PROVIDER.sendText(numero, mensaje)
    } catch (err) {
        log('[wa] Error sendText:', errDetalle(err))
    }
}

const enviarBotones = async (
    numero: string,
    mensaje: string,
    opciones: { id: string; title: string }[],
) => {
    try {
        // sendButtons de BuilderBot usa el título; guardamos también el id en el título
        // no aplica: capturamos por título. Para conservar ids usamos sendButtonReply crudo.
        await PROVIDER.sendMessageMeta({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numero,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: mensaje },
                action: {
                    buttons: opciones.map((o) => ({
                        type: 'reply',
                        reply: { id: o.id, title: o.title.slice(0, 20) },
                    })),
                },
            },
        })
    } catch (err) {
        log('[wa] Error botones:', errDetalle(err))
    }
}

type FilaLista = { id: string; title: string; description?: string }
type SeccionLista = { title: string; rows: FilaLista[] }

const enviarLista = async (
    numero: string,
    mensaje: string,
    boton: string,
    filasOSecciones: FilaLista[] | SeccionLista[],
    header?: string,
) => {
    try {
        // Detecta si nos pasaron filas planas o secciones ya armadas.
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

        await PROVIDER.sendMessageMeta({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numero,
            type: 'interactive',
            interactive,
        })
    } catch (err) {
        log('[wa] Error lista:', errDetalle(err))
    }
}

const enviarPdf = async (numero: string, pdfUrl: string, filename: string, caption: string) => {
    try {
        await PROVIDER.sendMessageMeta({
            messaging_product: 'whatsapp',
            to: numero,
            type: 'document',
            document: { link: pdfUrl, filename, caption },
        })
    } catch (err) {
        log('[wa] Error enviando PDF:', errDetalle(err))
    }
}

const enviarImagen = async (numero: string, imgUrl: string, caption: string) => {
    try {
        await PROVIDER.sendMessageMeta({
            messaging_product: 'whatsapp',
            to: numero,
            type: 'image',
            image: { link: imgUrl, caption },
        })
    } catch (err) {
        log('[wa] Error enviando imagen:', errDetalle(err))
    }
}

// Botones finales reutilizables: Sí / No / Hablar con agente
const opcionesFinales = async (numero: string, mensaje: string) => {
    trace(numero, 'salida', 'opciones_finales')
    await enviarBotones(numero, mensaje, [
        { id: 'otra_si', title: 'Sí, gracias' },
        { id: 'otra_no', title: 'No, finalizar' },
        { id: 'agente', title: 'Hablar con agente' },
    ])
}

// Opciones tras entregar la imagen de radicación o al hablar con agente:
// volver al menú o hablar con un asesor.
const opcionesVolverAgente = async (numero: string, mensaje: string) => {
    trace(numero, 'salida', 'opciones_volver_agente')
    await enviarBotones(numero, mensaje, [
        { id: 'volver_menu', title: 'Volver al menú' },
        { id: 'agente', title: 'Hablar con agente' },
    ])
}

// ============================================================================
// OWNER (autenticación por número → propietarios asociados)
// ============================================================================
const consultarOwner = async (numero: string): Promise<Propietario[]> => {
    const telefono = numero.startsWith('+') ? numero : `+${numero}`
    try {
        const res = await fetch(OWNER_URL, { method: 'GET', headers: { phone: telefono } })
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

const confirmarPropietario = async (numero: string, propietario: Propietario) => {
    getSesion(numero).propietario = propietario
    trace(numero, 'autenticacion', 'confirmar_propietario', {
        nit: propietario.nit,
        nombre: String(propietario.names).trim(),
    })
    await enviarBotones(
        numero,
        '🔎 Encontramos un perfil asociado a este número:\n\n' +
            `*${String(propietario.names).trim()}*\n` +
            `NIT: ${propietario.nit}\n\n` +
            '¿Deseas continuar con este perfil?',
        [
            { id: 'continuar', title: 'Sí, soy yo' },
            { id: 'no_soy_yo', title: 'No soy yo' },
        ],
    )
}

const validarUsuario = async (numero: string) => {
    trace(numero, 'autenticacion', 'consultar_owner')
    const propietarios = await consultarOwner(numero)

    if (!propietarios.length) {
        trace(numero, 'autenticacion', 'owner_no_encontrado')
        await enviarTexto(
            numero,
            '🔒 No encontramos una autorización asociada a este número para ingresar al servicio.\n\n' +
                'Si crees que es un error, comunícate con uno de nuestros asesores y con gusto te ayudamos. 🙌',
        )
        return
    }

    if (propietarios.length === 1) {
        SESIONES.set(numero, {})
        trace(numero, 'autenticacion', 'owner_unico', { nit: propietarios[0].nit })
        await confirmarPropietario(numero, propietarios[0])
        return
    }

    SESIONES.set(numero, { propietarios })
    trace(numero, 'autenticacion', 'owner_multiple', { cantidad: propietarios.length })
    const rows = propietarios.map((p, i) => ({
        id: `owner_${i}`,
        title: String(p.names).trim().slice(0, 24),
        description: `NIT: ${p.nit}`,
    }))
    await enviarLista(
        numero,
        '👥 Este número está asociado a varios perfiles.\n\nSelecciona con cuál deseas continuar:',
        'Ver perfiles',
        rows,
    )
}

// ============================================================================
// MENÚ PRINCIPAL
// ============================================================================
const menuPrincipal = async (numero: string) => {
    // Al volver al menú se limpia el contexto de consulta (no el propietario).
    const sesion = getSesion(numero)
    sesion.tipoRetencion = undefined
    sesion.retencionYear = undefined
    sesion.year = undefined
    sesion.month = undefined
    trace(numero, 'menu', 'menu_principal')
    await enviarLista(
        numero,
        '¿En qué te puedo ayudar hoy? 😊\nElige una opción del menú:',
        'Ver opciones',
        [
            { id: 'menu_1', title: 'Consultar extracto', description: 'Descarga tu extracto en PDF' },
            { id: 'menu_2', title: 'Certif. retenciones', description: 'Rete ICA o Rete Fuente' },
            { id: 'menu_3', title: 'Realizar PQR', description: 'Peticiones, quejas y reclamos' },
            { id: 'menu_4', title: 'Hablar con agente', description: 'Te atiende un asesor' },
            { id: 'menu_5', title: 'Radicar factura', description: 'Facturación electrónica' },
        ],
        '📋 Menú principal',
    )
}

// ============================================================================
// EXTRACTOS
// ============================================================================
const menuAniosExtracto = async (numero: string) => {
    const sesion = getSesion(numero)
    // Limpia el contexto de retención para que el año se interprete como extracto.
    sesion.tipoRetencion = undefined
    sesion.retencionYear = undefined
    const anio = new Date().getFullYear()
    trace(numero, 'extracto', 'menu_anios')
    await enviarBotones(numero, '📄 *Consulta de extractos*\n\n¿De qué año deseas el extracto?', [
        { id: `anio_${anio}`, title: String(anio) },
        { id: `anio_${anio - 1}`, title: String(anio - 1) },
        { id: 'volver_menu', title: 'Volver al menú' },
    ])
}

// Menú de meses. WhatsApp limita a 10 filas TOTALES por lista, por eso se
// pagina igual que en el proyecto Python: página 1 = "Todo el año" + meses 1–7
// + "Más meses" (si aplica) + "Volver"; página 2 = meses 8–12 + "Volver".
const menuMeses = async (numero: string, pagina = 1) => {
    const sesion = getSesion(numero)
    const anio = sesion.year as number
    const ahora = new Date()
    const limite = anio === ahora.getFullYear() ? ahora.getMonth() + 1 : 12

    trace(numero, 'extracto', 'menu_meses', { anio, limite, pagina })

    const filaMes = (mes: number) => ({ id: `mes_${mes}`, title: `${mes}. ${MESES[mes - 1]}` })
    const rows: FilaLista[] = []

    if (pagina === 1) {
        rows.push({ id: 'mes_0', title: 'Todo el año' })
        const hasta = Math.min(limite, 7)
        for (let mes = 1; mes <= hasta; mes++) rows.push(filaMes(mes))
        if (limite > 7) rows.push({ id: 'mas_meses', title: 'Ver más meses' })
    } else {
        for (let mes = 8; mes <= limite; mes++) rows.push(filaMes(mes))
    }
    rows.push({ id: 'volver_menu', title: 'Volver al menú' })

    await enviarLista(
        numero,
        `📅 Elige el período de ${anio} que deseas consultar:`,
        'Ver meses',
        rows,
        '📄 Extractos',
    )
}

// ============================================================================
// GENERACIÓN DE REPORTES (crear + polling de estado)
// ============================================================================
const crearReporte = async (url: string, etiqueta: string): Promise<string | null> => {
    try {
        log(`[${etiqueta}] GET`, url)
        const res = await fetch(url, { method: 'GET' })
        const id = (await res.text()).trim().replace(/["']/g, '')
        log(`[${etiqueta}] HTTP`, String(res.status), 'id:', id)
        return id || null
    } catch (err) {
        log(`[${etiqueta}] Error creando reporte:`, String(err))
        return null
    }
}

const esperarPdf = async (id: string, etiqueta: string, numero?: string): Promise<string | null> => {
    let avisado = false
    for (let intento = 0; intento < MAX_REINTENTOS; intento++) {
        await esperar(INTERVALO_MS)
        try {
            const res = await fetch(`${STATUS_API}?id=${encodeURIComponent(id)}`, { method: 'GET' })
            const data = (await res.json()) as { url?: string; status?: string; message?: string }
            log(`[${etiqueta}] intento ${intento + 1}:`, data.status ?? '')
            if (data.status === 'FinishedProcess' && data.url) return data.url
            if (data.status === 'ErrorInProcess') {
                log(`[${etiqueta}] ErrorInProcess:`, data.message ?? '')
                return null
            }
        } catch (err) {
            log(`[${etiqueta}] intento ${intento + 1} error:`, String(err))
        }

        // A los ~20s, si aún no termina, avisamos al usuario que seguimos trabajando.
        if (!avisado && intento === 9 && numero) {
            avisado = true
            trace(numero, etiqueta, 'demora_en_proceso', { reporteId: id })
            await enviarTexto(numero, '⏳ El documento está tardando un poco más de lo normal. Sigo trabajando en él, dame unos segundos más. 🙏')
        }
    }
    log(`[${etiqueta}] Tiempo de espera agotado`)
    return null
}

// Espera el PDF de un reporte y lo entrega. Registra el reporte como pendiente
// (para recuperarlo si el proceso se reinicia) y lo quita al finalizar.
const procesarReporte = async (p: ReportePendiente) => {
    agregarPendiente(p)
    const pdfUrl = await esperarPdf(p.id, p.etiqueta, p.numero)

    if (!pdfUrl) {
        // No terminó dentro del tiempo. Lo dejamos como pendiente para que, si
        // el servicio lo genera luego, la recuperación al reiniciar lo entregue.
        trace(p.numero, p.etiqueta, 'pdf_no_listo_aun', { reporteId: p.id })
        await opcionesFinales(
            p.numero,
            '⏳ Tu documento está tardando más de lo habitual. Apenas esté listo te lo enviaré.\n\n¿Deseas hacer algo más mientras tanto?',
        )
        return
    }

    trace(p.numero, p.etiqueta, 'pdf_generado', { reporteId: p.id, pdfUrl })
    await enviarPdf(p.numero, pdfUrl, p.filename, p.caption)
    trace(p.numero, p.etiqueta, 'pdf_enviado', { reporteId: p.id })
    quitarPendiente(p.id)
    await opcionesFinales(p.numero, p.mensajeExito)
}

// Al arrancar, reanuda la entrega de reportes que quedaron pendientes.
const recuperarPendientes = async () => {
    const lista = leerPendientes()
    if (!lista.length) return
    log('[recuperar] Reportes pendientes:', String(lista.length))
    for (const p of lista) {
        trace(p.numero, p.etiqueta, 'recuperar_pendiente', { reporteId: p.id })
        // Consulta puntual: si ya está listo, entrega; si no, sigue el polling.
        procesarReporte(p).catch((err) => log('[recuperar] Error:', String(err)))
    }
}

const ejecutarExtracto = async (numero: string) => {
    const sesion = getSesion(numero)
    const nit = sesion.propietario?.nit
    const params = new URLSearchParams({
        nit: String(nit),
        year: String(sesion.year),
        month: String(sesion.month),
        company: String(COMPANY_ID),
        applicant: APPLICANT,
    })
    const url = `${EXTRACT_API}?${params.toString()}`
    trace(numero, 'extracto', 'generar_solicitado', { nit, year: sesion.year, month: sesion.month })
    const id = await crearReporte(url, 'extracto')
    if (!id) {
        trace(numero, 'extracto', 'error_crear_reporte')
        await opcionesFinales(numero, '😕 No pudimos generar el documento para el período seleccionado.\n\n¿Deseas realizar otra consulta?')
        return
    }
    trace(numero, 'extracto', 'reporte_creado', { reporteId: id })
    await procesarReporte({
        id,
        numero,
        etiqueta: 'extracto',
        filename: 'Extracto.pdf',
        caption: '📄 Aquí tienes tu extracto.',
        mensajeExito: '✅ ¡Listo! Tu extracto se generó correctamente.\n\n¿Deseas realizar otra consulta?',
        creadoTs: new Date().toISOString(),
    })
}

const ejecutarRetencion = async (numero: string, tipo: 'ICA' | 'FUENTE') => {
    const sesion = getSesion(numero)
    const nit = sesion.propietario?.nit
    const cType = tipo === 'ICA' ? 'C' : 'R'
    const api = tipo === 'ICA' ? ICA_API : FUENTE_API
    const params = new URLSearchParams({
        cType,
        tCode: String(nit),
        year: String(sesion.retencionYear),
        iMonth: '1',
        eMonth: '12',
        company: String(COMPANY_ID),
        applicant: APPLICANT,
    })
    const etiqueta = tipo === 'ICA' ? 'ica' : 'fuente'
    const url = `${api}?${params.toString()}`
    const nombreDoc = tipo === 'ICA' ? 'Certificado_Rete_ICA.pdf' : 'Certificado_Rete_Fuente.pdf'
    const nombreLegible = tipo === 'ICA' ? 'Rete ICA' : 'Retención en la Fuente'

    trace(numero, 'retencion', 'generar_solicitado', { tipo, nit, year: sesion.retencionYear })
    const id = await crearReporte(url, etiqueta)
    if (!id) {
        trace(numero, 'retencion', 'error_crear_reporte', { tipo })
        await opcionesFinales(numero, `😕 No pudimos generar tu certificado de ${nombreLegible}.\n\n¿Deseas realizar otra consulta?`)
        return
    }
    trace(numero, 'retencion', 'reporte_creado', { tipo, reporteId: id })
    await procesarReporte({
        id,
        numero,
        etiqueta,
        filename: nombreDoc,
        caption: `📄 Aquí tienes tu certificado de ${nombreLegible}.`,
        mensajeExito: `✅ ¡Listo! Tu certificado de ${nombreLegible} se generó correctamente.\n\n¿Deseas realizar otra consulta?`,
        creadoTs: new Date().toISOString(),
    })
}

// ============================================================================
// RETENCIONES (menús)
// ============================================================================
const menuRetenciones = async (numero: string) => {
    trace(numero, 'retencion', 'menu_tipo')
    await enviarBotones(numero, '🧾 *Certificados de retención*\n\n¿Cuál deseas consultar?', [
        { id: 'rete_ica', title: 'Rete ICA' },
        { id: 'rete_fuente', title: 'Rete Fuente' },
        { id: 'volver_menu', title: 'Volver al menú' },
    ])
}

const menuAniosRetencion = async (numero: string, tipo: 'ICA' | 'FUENTE') => {
    const anio = new Date().getFullYear()
    const sesion = getSesion(numero)
    sesion.tipoRetencion = tipo
    sesion.retencionYear = undefined // se llenará al elegir el año
    const nombre = tipo === 'ICA' ? 'Rete ICA' : 'Rete Fuente'
    trace(numero, 'retencion', 'menu_anios', { tipo })
    await enviarBotones(numero, `🧾 *${nombre}*\n\n¿De qué año deseas el certificado?`, [
        { id: `ret_anio_${anio}`, title: String(anio) },
        { id: `ret_anio_${anio - 1}`, title: String(anio - 1) },
        { id: 'volver_menu', title: 'Volver al menú' },
    ])
}

// Mapa título→id para los BOTONES de respuesta. En BuilderBot/Meta, al tocar
// un botón llega su TÍTULO en ctx.body (no el id); las listas sí devuelven el id.
// Aquí normalizamos los títulos de botones a los ids que usa el router.
const TITULO_A_ID: Record<string, string> = {
    'continuar': 'continuar',
    'no soy yo': 'no_soy_yo',
    'sí': 'otra_si',
    'si': 'otra_si',
    'no': 'otra_no',
    'hablar con agente': 'agente',
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
}

// Normaliza lo recibido: si es un id conocido lo deja; si es el título de un
// botón, lo convierte a su id; los años (2024) de botones se pasan por título.
const normalizarOpcion = (raw: string): string => {
    const v = raw.trim()
    // Ids de lista o navegación ya vienen con prefijo conocido.
    if (/^(owner_|menu_|anio_|mes_|mas_meses|ret_anio_|rete_|volver_menu|continuar|no_soy_yo|otra_|agente|salir)/.test(v)) {
        return v
    }
    const lower = v.toLowerCase()
    if (TITULO_A_ID[lower]) return TITULO_A_ID[lower]
    // Botón de AÑO: el título es el año (ej. "2024"). Depende del contexto de
    // sesión (extracto vs retención), se resuelve en el router.
    if (/^\d{4}$/.test(v)) return `year_${v}`
    return v
}

// ============================================================================
// ROUTER DE RESPUESTAS INTERACTIVAS (equivalente a procesar_interactivo)
// ============================================================================
const procesarInteractivo = async (numero: string, opcionRaw: string) => {
    const sesion = getSesion(numero)
    const opcion = normalizarOpcion(opcionRaw)
    log('[router] numero:', numero, 'raw:', opcionRaw, '-> opcion:', opcion)

    // Botón de AÑO: el título llegó como "2024". Decide extracto vs retención
    // según si ya se eligió un tipo de retención pendiente.
    if (opcion.startsWith('year_')) {
        const year = parseInt(opcion.replace('year_', ''), 10)
        if (sesion.tipoRetencion && sesion.retencionYear === undefined) {
            sesion.retencionYear = year
            const tipo = sesion.tipoRetencion
            trace(numero, 'retencion', 'anio_seleccionado', { tipo, year })
            if (tipo === 'ICA') {
                await enviarTexto(numero, '⏳ Estoy generando tu certificado de *Rete ICA*.\nEn unos momentos te enviaré el documento. 📄')
                await ejecutarRetencion(numero, 'ICA')
            } else {
                await enviarTexto(numero, '⏳ Estoy generando tu certificado de *Retención en la Fuente*.\nEn unos momentos te enviaré el documento. 📄')
                await ejecutarRetencion(numero, 'FUENTE')
            }
        } else {
            sesion.year = year
            trace(numero, 'extracto', 'anio_seleccionado', { year })
            await menuMeses(numero)
        }
        return
    }

    // ----- OWNER -----
    if (opcion.startsWith('owner_')) {
        const indice = parseInt(opcion.replace('owner_', ''), 10)
        const p = sesion.propietarios?.[indice]
        if (p) await confirmarPropietario(numero, p)
        return
    }
    if (opcion === 'continuar') {
        const p = sesion.propietario
        trace(numero, 'autenticacion', 'perfil_confirmado', { nit: p?.nit })
        await enviarTexto(numero, `¡Hola, ${String(p?.names).trim()}! 👋\nSoy *Paula*, tu asistente. Es un gusto ayudarte.`)
        await menuPrincipal(numero)
        return
    }
    if (opcion === 'no_soy_yo') {
        trace(numero, 'autenticacion', 'perfil_rechazado')
        await enviarBotones(
            numero,
            'Entendido, no hay problema. 🙂\n\nPara validar la información asociada a tu número, puedes hablar con uno de nuestros asesores.',
            [
                { id: 'agente', title: 'Hablar con agente' },
                { id: 'salir', title: 'Salir' },
            ],
        )
        return
    }

    // ----- FINAL / NAVEGACIÓN -----
    if (opcion === 'otra_si') {
        trace(numero, 'salida', 'otra_consulta_si')
        await menuPrincipal(numero)
        return
    }
    if (opcion === 'otra_no') {
        trace(numero, 'salida', 'finalizar')
        await enviarTexto(numero, '¡Gracias por usar nuestros servicios! �\nQue tengas un excelente día. 👋')
        SESIONES.delete(numero)
        return
    }
    if (opcion === 'volver_menu') {
        trace(numero, 'menu', 'volver_menu')
        await menuPrincipal(numero)
        return
    }
    if (opcion === 'agente' || opcion === 'menu_4') {
        trace(numero, 'agente', 'derivar_asesor')
        await enviarTexto(
            numero,
            '👤 En seguida te comunico con uno de nuestros asesores. Por favor, espera un momento mientras uno de ellos retoma tu conversación.',
        )
        await opcionesVolverAgente(numero, '¿Deseas hacer algo más mientras tanto?')
        return
    }
    if (opcion === 'salir') {
        trace(numero, 'salida', 'salir')
        await enviarTexto(numero, '¡Gracias por comunicarte con nosotros! 👋')
        SESIONES.delete(numero)
        return
    }

    // ----- MENÚ PRINCIPAL -----
    if (opcion === 'menu_1') { trace(numero, 'menu', 'sel_extracto'); await menuAniosExtracto(numero); return }
    if (opcion === 'menu_2') { trace(numero, 'menu', 'sel_retenciones'); await menuRetenciones(numero); return }
    if (opcion === 'menu_3') {
        trace(numero, 'menu', 'sel_pqr')
        await enviarTexto(numero, '🛠️ La opción de *PQR* estará disponible muy pronto. Gracias por tu paciencia.')
        await opcionesVolverAgente(numero, '¿Deseas hacer algo más?')
        return
    }
    if (opcion === 'menu_5') {
        trace(numero, 'facturacion', 'imagen_enviada')
        await enviarImagen(numero, FACTURACION_IMG, '🧾 Aquí tienes la información para la *radicación de tu factura electrónica*.')
        await opcionesVolverAgente(numero, '¿Deseas volver al menú o hablar con un agente?')
        return
    }

    // ----- EXTRACTO: año -----
    if (opcion.startsWith('anio_')) {
        sesion.year = parseInt(opcion.replace('anio_', ''), 10)
        trace(numero, 'extracto', 'anio_seleccionado', { year: sesion.year })
        await menuMeses(numero)
        return
    }

    // ----- EXTRACTO: ver más meses (página 2) -----
    if (opcion === 'mas_meses') {
        trace(numero, 'extracto', 'mas_meses')
        await menuMeses(numero, 2)
        return
    }

    // ----- EXTRACTO: mes -----
    if (opcion.startsWith('mes_')) {
        sesion.month = parseInt(opcion.replace('mes_', ''), 10)
        trace(numero, 'extracto', 'mes_seleccionado', { month: sesion.month })
        await enviarTexto(
            numero,
            '⏳ Estoy consultando los registros del período solicitado.\nEn unos momentos te enviaré tu documento. 🤓',
        )
        await ejecutarExtracto(numero)
        return
    }

    // ----- RETENCIONES -----
    if (opcion === 'rete_ica') { trace(numero, 'retencion', 'sel_ica'); await menuAniosRetencion(numero, 'ICA'); return }
    if (opcion === 'rete_fuente') { trace(numero, 'retencion', 'sel_fuente'); await menuAniosRetencion(numero, 'FUENTE'); return }

    if (opcion.startsWith('ret_anio_')) {
        const year = parseInt(opcion.replace('ret_anio_', ''), 10)
        sesion.retencionYear = year
        const tipo = sesion.tipoRetencion
        trace(numero, 'retencion', 'anio_seleccionado', { tipo, year })
        if (tipo === 'ICA') {
            await enviarTexto(numero, '⏳ Estoy generando tu certificado de *Rete ICA*.\nEn unos momentos te enviaré el documento. 📄')
            await ejecutarRetencion(numero, 'ICA')
        } else if (tipo === 'FUENTE') {
            await enviarTexto(numero, '⏳ Estoy generando tu certificado de *Retención en la Fuente*.\nEn unos momentos te enviaré el documento. 📄')
            await ejecutarRetencion(numero, 'FUENTE')
        }
        return
    }
}

// ============================================================================
// FLUJO ÚNICO BUILDERBOT: captura cada mensaje y enruta por id.
// Replica el webhook del proyecto Python usando un router central.
// ============================================================================
const mainFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
    .addAction(async (ctx) => {
        const numero = ctx.from
        const tipo = (ctx as any)?.type ?? ''
        const bodyRaw = (ctx.body ?? '').trim()
        log('[in] numero:', numero, 'tipo:', tipo, 'body:', bodyRaw)

        // NUEVA SESIÓN: sólo "hola" (texto) inicia el proceso (igual que el Python).
        if (!SESIONES.has(numero)) {
            if (tipo === 'text' || tipo === '') {
                if (bodyRaw.toLowerCase() === 'hola') {
                    trace(numero, 'sesion', 'saludo_inicial', { texto: bodyRaw })
                    await validarUsuario(numero)
                }
            }
            return
        }

        // SESIÓN EXISTENTE:
        // - Respuesta interactiva (lista=id, botón=título) → al router.
        // - Texto libre → guiar al usuario.
        const pareceInteractivo =
            tipo === 'interactive' ||
            tipo === 'button' ||
            /^(owner_|menu_|anio_|mes_|mas_meses|ret_anio_|rete_|volver_menu|continuar|no_soy_yo|otra_|agente|salir)/.test(bodyRaw) ||
            /^\d{4}$/.test(bodyRaw) || // año en botón
            !!TITULO_A_ID[bodyRaw.toLowerCase()] // título de botón conocido

        if (pareceInteractivo) {
            await procesarInteractivo(numero, bodyRaw)
            return
        }

        trace(numero, 'sesion', 'texto_libre', { texto: bodyRaw })

        await enviarTexto(numero, 'Por favor utiliza las opciones disponibles para continuar.')
    })

// ============================================================================
// BOOTSTRAP
// ============================================================================
const main = async () => {
    const adapterFlow = createFlow([mainFlow])

    const adapterProvider = createProvider(Provider, {
        jwtToken: 'EAAg1ZA3jiRAkBSjZCmcevZBwDAFmt4iQoyNM9GERXvwThsvwuwlIEXWmx7C2gspnNWxaGweCBQeBe4khj6iomO8TB9ZC5ItAvzl6IOVaC1L0ZBZB21qHgwzbEpGqj79cwZBZB6XUW3Sh22OvQ6KPwx48mWqG8sehf4X6uOKKIDqMPJNUrYIZCeLZCq9ZADd0Fm2EpTJeICyoOaM6h0BUtbeNDLOE4S8fAZAZAptlkGR4hNEjQGfq4JQYKsLPhPF51eFb4yohcMy5DLegJrfpaTl9v5Nf8zgepRDZA8iezxW3oNvSQZD',
        numberId: '1282085621652620',
        verifyToken: 'paula2026',
        version: 'v25.0',
    })
    const adapterDB = new Database()

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    // Exponer el provider para los routers.
    PROVIDER = adapterProvider

    // Reanuda la entrega de reportes que quedaron pendientes antes de un reinicio.
    await recuperarPendientes()

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        }),
    )

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        }),
    )

    adapterProvider.server.get(
        '/v1/blacklist/list',
        handleCtx(async (bot, req, res) => {
            const blacklist = bot.blacklist.getList()
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', blacklist }))
        }),
    )

    // Log revisable desde el navegador.
    adapterProvider.server.get('/v1/logs', (_req, res) => {
        try {
            const contenido = readFileSync(LOG_FILE, 'utf-8')
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            return res.end(contenido)
        } catch {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            return res.end('Aún no hay logs registrados.')
        }
    })

    httpServer(+PORT)
}

main()
