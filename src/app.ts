// IMPORTANTE: debe ir de PRIMERO, antes de cualquier cliente HTTP (provider Meta).
import './tls-setup'
import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import * as repo from './repository'
import { prisma } from './db'
import { iniciarWorkerSalientes } from './outbound-worker'
import { iniciarWatchdogSesiones } from './session-watchdog'
import { MESES, textoVisibleDe } from './display-text'
import {
    PORT,
    META_JWT_TOKEN,
    META_NUMBER_ID,
    META_VERIFY_TOKEN,
    META_VERSION,
    validarCredencialesMeta,
    COMPANY_ID,
    APPLICANT,
    EXTRACT_API,
    ICA_API,
    FUENTE_API,
    FACTURACION_IMG,
    INBOUND_MAX_AGE_SECONDS,
    POLITICA_VERSION,
    POLITICA_PDF_NOMBRE,
    AGENT_SESSION_TTL_MS,
    AGENT_PDF_FILENAME,
} from './config'
import { consultarAgente } from './agente-ia'
import { normalizarOpcion, pareceInteractivo } from './router-maps'
import {
    consultarOwner,
    crearReporte,
    limpiarMensajeProveedor,
    esperarPdf,
    type Propietario,
} from './pharitech'
import {
    crearTransporteWa,
    type FilaLista,
} from './wa-transport'
import { subirMediaLocal } from './media'
import {
    SESIONES,
    getSesion,
    persistirContexto,
    resolverSesion,
    getSessionId,
    finalizarSesion,
    configurarLogger as configurarLoggerSesion,
} from './session-state'

// Config y credenciales viven en ./config; la validación es explícita (sin
// efectos al importar). MESES/textoVisibleDe en ./display-text; la
// normalización de opciones del router en ./router-maps (módulos puros).
validarCredencialesMeta()

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

// Inyecta el logger de la app en el módulo de estado de sesión (WS-07).
configurarLoggerSesion(log)

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

// Punto único de persistencia. Escribe la traza a consola, archivo y a la
// tabla audit_events de PostgreSQL (para el portal y el monitoreo en tiempo real).
const persistirTraza = (evento: EventoTraza) => {
    console.log('TRACE', JSON.stringify(evento))
    try {
        mkdirSync(LOG_DIR, { recursive: true })
        appendFileSync(join(LOG_DIR, 'traza.log'), JSON.stringify(evento) + '\n')
    } catch { /* noop */ }

    // Persistencia en BD (fire-and-forget): solo si ya hay una sesión asociada
    // al número; no forzamos crearla desde una traza para no generar sesiones
    // vacías por saludos que no autentican.
    const sessionId = SESIONES.get(evento.numero)?.sessionId
    if (sessionId) {
        void repo.registrarEvento({
            sessionId,
            eventType: `${evento.etapa}.${evento.paso}`.toUpperCase(),
            actorType: 'BOT',
            entityType: 'SESSION',
            entityId: sessionId,
            newValue: evento.detalle,
        })
    }
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
// ESTADO EN MEMORIA POR NÚMERO (SESIONES)
// ----------------------------------------------------------------------------
// El estado de sesión en memoria (Sesion, SESIONES + resolver/persistir/
// hidratar/cerrar) vive en ./session-state; se importa arriba. `Propietario`
// se importa de ./pharitech. El logger se inyecta a session-state en main().
// ============================================================================

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

// WS-08: la persistencia de reportes pendientes vive ahora en la tabla
// pending_reports (repo), no en logs/pendientes.json. Así sobrevive reinicios
// y despliegues y es la fuente única. Estas funciones adaptan el ReportePendiente
// (en memoria del flujo) hacia/desde la fila de BD.
const agregarPendiente = async (p: ReportePendiente): Promise<void> => {
    await repo.agregarReportePendiente({
        reportId: p.id,
        phoneE164: p.numero,
        label: p.etiqueta,
        filename: p.filename,
        caption: p.caption,
        successText: p.mensajeExito,
    })
}

const quitarPendiente = async (id: string): Promise<void> => {
    await repo.quitarReportePendiente(id)
}

// ============================================================================
// PROVIDER + TRANSPORTE WhatsApp
// ----------------------------------------------------------------------------
// PROVIDER es el provider de BuilderBot; se asigna en el bootstrap (main). El
// transporte (enviarTexto/Botones/Lista/Pdf/Imagen) vive en ./wa-transport y se
// construye inyectando un accesor lazy al provider, el logger y el persistidor
// del histórico. Los envíos siguen usándose igual que antes en el flujo.
// ============================================================================
let PROVIDER: any = null

// media_id de la imagen de facturación, subida a Meta al arrancar (WhatsApp no
// puede descargar imágenes desde URLs privadas/localhost). Si queda null, la
// opción 5 cae de vuelta al envío por URL (FACTURACION_IMG).
let FACTURA_MEDIA_ID: string | null = null

// media_id del PDF de política de tratamiento de datos (subido a Meta al
// arrancar). Se envía tras la primera autenticación para que el usuario acepte.
let POLITICA_MEDIA_ID: string | null = null

// Persiste en el histórico un saliente del bot para que el portal muestre lo
// MISMO que ve el usuario en WhatsApp (menús, listas, documentos, imágenes).
// `content` = texto principal; `displayText` = versión legible enriquecida.
const persistirSalienteBot = (
    numero: string,
    content: string,
    type: 'text' | 'image' | 'document' | 'system_event' = 'text',
    displayText?: string,
) => {
    const sessionId = SESIONES.get(numero)?.sessionId
    if (sessionId) void repo.guardarMensajeSalienteBot(sessionId, content, type, displayText).catch(() => {})
}

const {
    enviarTexto,
    enviarBotones,
    enviarLista,
    enviarPdf,
    enviarImagen,
    enviarImagenPorId,
    enviarDocumentoPorId,
} = crearTransporteWa({
    getProvider: () => PROVIDER,
    log,
    persistir: persistirSalienteBot,
    meta: { token: META_JWT_TOKEN, numberId: META_NUMBER_ID, version: META_VERSION },
})

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
// AGENTE IA (Bedrock vía la API orquestadora).
// ----------------------------------------------------------------------------
// Atiende UN turno del modo agente IA: envía el texto del usuario a la API,
// refresca la expiración del vínculo (y guarda el bedrockSessionId para el
// próximo turno), y entrega la respuesta: primero el texto y luego cada PDF que
// el agente devuelva (como documento, nombre genérico). Si la API falla, cae a
// modo MANUAL para que un asesor retome (ya está notificado desde el inicio).
// El texto/PDF entregados se persisten automáticamente vía enviarTexto/enviarPdf.
// ============================================================================
const atenderTurnoAgente = async (
    numero: string,
    sessionId: string,
    textoUsuario: string,
): Promise<void> => {
    const vinculo = await repo.agentSessionVigente(sessionId)
    const bedrockSessionId = vinculo?.bedrockSessionId ?? null

    // La API del agente (Bedrock vía API Gateway) a veces responde con errores
    // TRANSITORIOS: 502 "Service capacity limit" o 504 "Endpoint request timed
    // out" (el gateway corta a los ~29s en turnos pesados). Reintentamos el
    // mismo turno un par de veces antes de rendirnos: suelen resolverse solos.
    let resp = await consultarAgente(textoUsuario, bedrockSessionId, log)
    for (let intento = 1; resp.fallo && intento <= 2; intento++) {
        trace(numero, 'agente_ia', 'reintento_turno', { intento, estado: resp.estado })
        await new Promise((r) => setTimeout(r, 1500))
        resp = await consultarAgente(textoUsuario, bedrockSessionId, log)
    }

    // Si tras los reintentos SIGUE fallando: NO sacamos al usuario del agente
    // (un error transitorio de AWS no debe perder el hilo). Le avisamos que fue
    // algo momentáneo y le dejamos los botones para que decida: reintentar
    // escribiendo de nuevo, pedir un asesor humano, o volver al menú. El modo
    // AGENT se mantiene; el vínculo NO se borra.
    if (resp.fallo) {
        trace(numero, 'agente_ia', 'fallo_api', { tipo: resp.tipo, estado: resp.estado })
        await enviarTexto(
            numero,
            '⚠️ Tuve un problema momentáneo para procesar tu solicitud (el servicio ' +
                'estaba ocupado). Por favor, vuelve a escribir tu mensaje en unos segundos.\n\n' +
                'Si prefieres, puedo comunicarte con un asesor.',
        )
        await enviarBotonesAgente(numero)
        return
    }

    // Refresca el hilo (bump expiración) y guarda el sessionId devuelto.
    try {
        await repo.refrescarAgentSession(sessionId, AGENT_SESSION_TTL_MS, resp.bedrockSessionId)
    } catch (err) {
        log('[agente-ia] No se pudo refrescar el vínculo:', String(err))
    }

    // Entrega: primero el texto (si lo hay), luego cada PDF como documento.
    const mensaje = resp.mensaje.trim()
    if (mensaje) {
        await enviarTexto(numero, mensaje)
    }
    for (const url of resp.pdfUrls) {
        trace(numero, 'agente_ia', 'pdf_entregado', { tipo: resp.tipo })
        await enviarPdf(numero, url, AGENT_PDF_FILENAME, '')
    }
    // Si no vino ni texto ni PDF, avisamos para no dejar al usuario en silencio.
    if (!mensaje && resp.pdfUrls.length === 0) {
        await enviarTexto(numero, 'No obtuve una respuesta. ¿Puedes reformular tu solicitud?')
    }

    // Tras CADA respuesta del agente IA, ofrecemos las dos salidas del modo
    // agente como botones: pedir un asesor humano o volver al menú (que cierra
    // el vínculo con el agente). Así el usuario siempre tiene cómo salir sin
    // tener que adivinar palabras clave.
    await enviarBotonesAgente(numero)

    trace(numero, 'agente_ia', 'turno_atendido', {
        tipo: resp.tipo,
        estado: resp.estado,
        pdfs: resp.pdfUrls.length,
    })
}

// Botones que acompañan cada respuesta del agente IA: salir a un asesor humano
// o volver al menú principal (cerrando el vínculo con el agente).
const enviarBotonesAgente = async (numero: string): Promise<void> => {
    await enviarBotones(numero, '¿Qué deseas hacer?', [
        { id: 'agente_humano', title: 'Necesito un asesor' },
        { id: 'volver_menu', title: 'Volver al menú' },
    ])
}

// Deriva la conversación a un ASESOR HUMANO (no al agente IA). Pone la sesión
// en MANUAL (el bot deja de responder), cierra cualquier vínculo con el agente
// IA y registra el handoff para que el asesor la vea/tome en el portal. Se usa
// desde el botón "Necesito un asesor" y desde el caso del usuario con @ sin
// registrar (para que no quede sin salida).
const solicitarAsesorHumano = async (numero: string, motivo: string): Promise<void> => {
    trace(numero, 'agente', 'solicitar_asesor_humano', { motivo })
    try {
        const sessionId = await getSessionId(numero)
        await repo.actualizarSesion(sessionId, { mode: 'MANUAL' })
        await repo.borrarAgentSession(sessionId)
        await repo.registrarEvento({
            sessionId,
            eventType: 'HANDOFF_REQUESTED',
            actorType: 'BOT',
            entityType: 'SESSION',
            entityId: sessionId,
            reason: motivo,
        })
    } catch (err) {
        log('[db] Error solicitando asesor humano:', String(err))
    }
    await enviarTexto(
        numero,
        '👤 Con gusto. En seguida te comunico con uno de nuestros asesores.\n\n' +
            'Por favor, espera un momento mientras uno de ellos retoma tu conversación. 🙌',
    )
}

// Cierra el modo agente IA y devuelve el control al bot. Pone la sesión en
// AUTOMATIC, borra el vínculo con el agente (para que un futuro "Hablar con
// agente" arranque un hilo nuevo) y vuelve a mostrar el menú principal.
const volverAlMenuDesdeAgente = async (numero: string, sessionId: string): Promise<void> => {
    try {
        await repo.actualizarSesion(sessionId, { mode: 'AUTOMATIC', flow: 'MENU_PRINCIPAL' })
        await repo.borrarAgentSession(sessionId)
        await repo.registrarEvento({
            sessionId,
            eventType: 'AI_AGENT_ENDED',
            actorType: 'BOT',
            entityType: 'SESSION',
            entityId: sessionId,
        })
    } catch (err) {
        log('[db] Error cerrando el agente para volver al menú:', String(err))
    }
    await enviarTexto(numero, '👋 Listo, cierro el asistente. Te dejo de nuevo en el menú.')
    await menuPrincipal(numero)
}

// Nota: el envío a usuarios BSUID (sin teléfono) lo maneja ahora el transporte
// (wa-transport.ts): detecta que el destino no es un teléfono y responde por el
// campo `recipient` de la Graph API. Así TODO el flujo (menú, owner, agente IA,
// PDFs) llega igual a teléfonos y a usuarios con @.

/** ¿La identidad de sesión es un teléfono? (si no, es un BSUID "CO.xxx"). */
const esTelefonoIdentidad = (id: string): boolean => /^\+?\d{6,}$/.test(String(id ?? '').trim())

/**
 * Consulta el owner (PhariTech) a partir de la identidad de la sesión. Si la
 * identidad es un teléfono, consulta directo. Si es un BSUID (usuario con @),
 * PhariTech no entiende el BSUID: resolvemos primero el TELÉFONO real desde el
 * directorio (que un asesor registró) y consultamos con ese. Si el BSUID aún no
 * tiene teléfono en el directorio, devolvemos [] (no autenticado) para que el
 * flujo pida completar el registro.
 */
const consultarOwnerIdentidad = async (numero: string): Promise<Propietario[]> => {
    if (esTelefonoIdentidad(numero)) {
        return consultarOwner(numero, log)
    }
    // Es un BSUID: buscar el teléfono mapeado en el directorio.
    const match = await repo.resolverTelefonoPorIdentidad(undefined, numero)
    if (!match) {
        log('[owner] BSUID sin teléfono registrado en el directorio:', numero)
        return []
    }
    return consultarOwner(match.phoneE164, log)
}

// ============================================================================
// OWNER (autenticación por número → propietarios asociados)
// consultarOwner vive en ./pharitech; aquí se usa con el `log` local.
// ============================================================================
/**
 * Garantiza que el propietario esté en memoria antes de generar un documento.
 * Si falta (sesión expirada por inactividad, reinicio del proceso, o botón
 * "Sí, soy yo" pulsado sobre una sesión ya cerrada), reconsulta el servicio
 * owner por número y lo restablece. Devuelve true si quedó un propietario
 * utilizable; false si no se pudo resolver (ya avisó al usuario).
 *
 * Nota: si el número tiene VARIOS propietarios no podemos elegir por él; se le
 * pide re-autenticar para que seleccione el correcto.
 */
const asegurarPropietario = async (numero: string): Promise<boolean> => {
    const sesion = getSesion(numero)
    if (sesion.propietario?.nit != null) return true

    trace(numero, 'autenticacion', 'reconsultar_owner_por_nit_ausente')
    const propietarios = await consultarOwnerIdentidad(numero)
    if (propietarios.length === 1) {
        sesion.propietario = propietarios[0]
        trace(numero, 'autenticacion', 'owner_restablecido', { nit: propietarios[0].nit })
        await persistirContexto(numero)
        return true
    }

    // 0 o varios → no podemos continuar de forma segura: re-autenticar.
    trace(numero, 'autenticacion', 'reautenticar_requerida', { cantidad: propietarios.length })
    await validarUsuario(numero)
    return false
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
    const propietarios = await consultarOwnerIdentidad(numero)

    if (!propietarios.length) {
        trace(numero, 'autenticacion', 'owner_no_encontrado')
        // Mensaje distinto según el tipo de identidad: a los usuarios con @
        // (BSUID) les pedimos registrarse con un asesor (su teléfono aún no está
        // en el directorio); a los de teléfono, el aviso clásico.
        if (esTelefonoIdentidad(numero)) {
            // Teléfono sin autorización en el servicio: NO lo dejamos sin salida.
            // Le ofrecemos un botón para hablar con un asesor humano, que lo
            // deriva directo al portal (modo MANUAL, NO al agente IA).
            await enviarBotones(
                numero,
                '🔒 No encontramos una autorización asociada a este número para ingresar al servicio.\n\n' +
                    'Si crees que es un error, puedo comunicarte con un asesor para ayudarte.',
                [
                    { id: 'agente_humano', title: 'Hablar con un asesor' },
                    { id: 'salir', title: 'Salir' },
                ],
            )
        } else {
            // Usuario con @ (BSUID) sin teléfono registrado: NO lo dejamos sin
            // salida. Le explicamos qué pasa y le damos un botón para hablar con
            // un asesor humano, que lo deriva de una al portal (modo MANUAL, NO
            // al agente IA) para que una persona complete su registro.
            await enviarBotones(
                numero,
                '👋 ¡Hola! Aún no tenemos tu usuario de WhatsApp vinculado con tus datos, ' +
                    'por eso no puedo validarte automáticamente.\n\n' +
                    'No te preocupes: puedo comunicarte con un asesor para completar tu registro ahora mismo.',
                [
                    { id: 'agente_humano', title: 'Hablar con un asesor' },
                    { id: 'salir', title: 'Salir' },
                ],
            )
        }
        return
    }

    // Importante: NO pisar la memoria con un objeto nuevo (perdería el
    // sessionId que une memoria y BD). Limpiamos el contexto previo pero
    // conservamos el sessionId, y PERSISTIMOS a flow_context. Sin esto, al
    // llegar la selección del usuario `resolverSesion` rehidrata desde la BD y,
    // como no se había guardado nada, `propietarios` quedaba vacío y la opción
    // elegida (owner_N) no encontraba el perfil -> el bot "no hacía nada".
    const mem = getSesion(numero)

    if (propietarios.length === 1) {
        mem.propietario = undefined
        mem.propietarios = undefined
        mem.year = undefined
        mem.month = undefined
        mem.tipoRetencion = undefined
        mem.retencionYear = undefined
        trace(numero, 'autenticacion', 'owner_unico', { nit: propietarios[0].nit })
        await confirmarPropietario(numero, propietarios[0])
        await persistirContexto(numero)
        return
    }

    // Varios perfiles: guardamos la lista en memoria Y en BD (flow_context) para
    // que la selección posterior (owner_N) la encuentre aunque la memoria se
    // rehidrate desde la BD entre mensajes.
    mem.propietario = undefined
    mem.propietarios = propietarios
    trace(numero, 'autenticacion', 'owner_multiple', { cantidad: propietarios.length })
    await persistirContexto(numero)
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
    // Persiste el estado de la máquina en BD (fuente de verdad).
    if (sesion.sessionId) {
        void repo.actualizarSesion(sesion.sessionId, { flow: 'MENU_PRINCIPAL' }).catch(() => {})
    }
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
            { id: 'menu_5', title: 'Radicar factura', description: 'Factura electronica y cuentas de cobro' },
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
// crearReporte / esperarPdf / limpiarMensajeProveedor viven en ./pharitech.
// Aquí se orquesta la entrega inyectando log/trace/aviso al usuario.
// ============================================================================

// Espera el PDF de un reporte y lo entrega. Registra el reporte como pendiente
// (para recuperarlo si el proceso se reinicia) y lo quita al finalizar.
const procesarReporte = async (p: ReportePendiente) => {
    await agregarPendiente(p)
    const resultado = await esperarPdf(p.id, p.etiqueta, {
        log,
        trace: (etapa, paso, detalle) => trace(p.numero, etapa, paso, detalle),
        avisar: () =>
            enviarTexto(
                p.numero,
                '⏳ El documento está tardando un poco más de lo normal. Sigo trabajando en él, dame unos segundos más. 🙏',
            ),
    })

    // Caso terminal SIN documento (p. ej. NIT no registrado): NO seguir esperando.
    // Se muestra el motivo (mensaje del proveedor si es legible) y se ofrece el menú.
    if (resultado.estado === 'sin_documento') {
        trace(p.numero, p.etiqueta, 'reporte_sin_documento', { reporteId: p.id, mensaje: resultado.mensaje })
        await quitarPendiente(p.id)
        const detalle = limpiarMensajeProveedor(resultado.mensaje)
        const cuerpo = detalle
            ? `😕 No pudimos generar el documento.\n\n_${detalle}_`
            : '😕 No pudimos generar el documento para los datos solicitados.'
        await opcionesFinales(
            p.numero,
            `${cuerpo}\n\nSi crees que es un error, comunícate con un asesor. ¿Deseas hacer algo más?`,
        )
        return
    }

    // Timeout: no resolvió dentro del tiempo. Se deja pendiente para reintentar
    // en un reinicio, pero NO se deja al usuario esperando indefinidamente.
    if (resultado.estado === 'timeout') {
        trace(p.numero, p.etiqueta, 'pdf_no_listo_aun', { reporteId: p.id })
        await opcionesFinales(
            p.numero,
            '⏳ Tu documento está tardando más de lo habitual. Apenas esté listo te lo enviaré.\n\n¿Deseas hacer algo más mientras tanto?',
        )
        return
    }

    // Documento listo → entregar.
    trace(p.numero, p.etiqueta, 'pdf_generado', { reporteId: p.id, pdfUrl: resultado.url })
    await enviarPdf(p.numero, resultado.url, p.filename, p.caption)
    trace(p.numero, p.etiqueta, 'pdf_enviado', { reporteId: p.id })
    await quitarPendiente(p.id)
    await opcionesFinales(p.numero, p.mensajeExito)
}

// Al arrancar, reanuda la entrega de reportes que quedaron pendientes.
// WS-08: la lista viene de la tabla pending_reports (sobrevive reinicios).
const recuperarPendientes = async () => {
    const lista = await repo.listarReportesPendientes()
    if (!lista.length) return
    log('[recuperar] Reportes pendientes:', String(lista.length))
    for (const r of lista) {
        const p: ReportePendiente = {
            id: r.reportId,
            numero: r.phoneE164,
            etiqueta: r.label,
            filename: r.filename,
            caption: r.caption,
            mensajeExito: r.successText,
            creadoTs: new Date().toISOString(),
        }
        trace(p.numero, p.etiqueta, 'recuperar_pendiente', { reporteId: p.id })
        // Consulta puntual: si ya está listo, entrega; si no, sigue el polling.
        procesarReporte(p).catch((err) => log('[recuperar] Error:', String(err)))
    }
}

const ejecutarExtracto = async (numero: string) => {
    const sesion = getSesion(numero)
    // Defensa: si por expiración/reinicio de sesión el propietario no está en
    // memoria, se re-consulta el owner ANTES de llamar al proveedor. Nunca se
    // debe pedir el reporte con nit=undefined (el proveedor responde "Su nit no
    // se encuentra registrado" aunque el NIT real sí exista).
    if (sesion.propietario?.nit == null) {
        const ok = await asegurarPropietario(numero)
        if (!ok) return
    }
    const nit = sesion.propietario?.nit
    if (nit == null) {
        trace(numero, 'extracto', 'nit_ausente')
        await opcionesFinales(
            numero,
            '😕 No pudimos identificar tu perfil para generar el documento.\n\nEscribe *Hola* para volver a validar tu número. ¿Deseas hacer algo más?',
        )
        return
    }
    const params = new URLSearchParams({
        nit: String(nit),
        year: String(sesion.year),
        month: String(sesion.month),
        company: String(COMPANY_ID),
        applicant: APPLICANT,
    })
    const url = `${EXTRACT_API}?${params.toString()}`
    trace(numero, 'extracto', 'generar_solicitado', { nit, year: sesion.year, month: sesion.month })
    const id = await crearReporte(url, 'extracto', log)
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
    if (sesion.propietario?.nit == null) {
        const ok = await asegurarPropietario(numero)
        if (!ok) return
    }
    const nit = sesion.propietario?.nit
    if (nit == null) {
        trace(numero, 'retencion', 'nit_ausente', { tipo })
        await opcionesFinales(
            numero,
            '😕 No pudimos identificar tu perfil para generar el documento.\n\nEscribe *Hola* para volver a validar tu número. ¿Deseas hacer algo más?',
        )
        return
    }
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
    const id = await crearReporte(url, etiqueta, log)
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

// El texto humano de un payload (BUG-003) vive en un módulo puro y testeable
// (./display-text). TITULO_A_ID / normalizarOpcion / pareceInteractivo viven en
// ./router-maps (módulo puro, ver imports arriba).

// ============================================================================
// POLÍTICA DE TRATAMIENTO DE DATOS (aceptación única tras la 1a autenticación)
// ============================================================================
// Envía el PDF de la política y pide aceptarla. Se llama solo cuando el contacto
// aún no la ha aceptado. Si el PDF no pudo subirse a Meta, se continúa igual al
// menú (no bloquear el servicio por un fallo de infraestructura).
const pedirAceptacionPolitica = async (numero: string) => {
    trace(numero, 'politica', 'solicitar_aceptacion')
    if (!POLITICA_MEDIA_ID) {
        log('[politica] Sin media_id (PDF no subido); se omite el gate y se va al menú.')
        await menuPrincipal(numero)
        return
    }
    await enviarDocumentoPorId(
        numero,
        POLITICA_MEDIA_ID,
        POLITICA_PDF_NOMBRE,
        '📄 Antes de continuar, te compartimos nuestra *Política de Tratamiento de Datos Personales*.',
    )
    await enviarBotones(
        numero,
        'Para usar nuestros servicios necesitamos tu autorización del tratamiento de datos personales conforme a la política adjunta. ¿La aceptas?',
        [
            { id: 'acepto_politica', title: 'Acepto' },
            { id: 'rechazo_politica', title: 'No acepto' },
        ],
    )
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
        if (p) {
            await confirmarPropietario(numero, p)
        } else {
            // Defensa: si el contexto de perfiles se perdió (expiración/reinicio),
            // no dejamos al usuario sin respuesta: re-autenticamos para que vuelva
            // a aparecer la selección de perfiles.
            trace(numero, 'autenticacion', 'owner_indice_sin_contexto', { indice })
            await validarUsuario(numero)
        }
        return
    }
    if (opcion === 'continuar') {
        // Si la sesión se recreó (expiró por inactividad, reinicio, o el usuario
        // pulsó "Sí, soy yo" sobre botones de una sesión ya cerrada), el
        // propietario no está en memoria. Reconsultamos el owner antes de
        // continuar; si no se puede resolver, asegurarPropietario ya reautentica.
        if (sesion.propietario?.nit == null) {
            const ok = await asegurarPropietario(numero)
            if (!ok) return
        }
        const p = sesion.propietario
        trace(numero, 'autenticacion', 'perfil_confirmado', { nit: p?.nit })
        // Guarda el nombre real del propietario como displayName del contacto y
        // el tercero en la sesión, para que el portal muestre el nombre (BUG-001).
        const nombre = String(p?.names ?? '').trim()
        if (nombre) {
            void repo.fijarNombreContacto(numero, nombre).catch(() => {})
            if (sesion.sessionId) {
                void repo
                    .actualizarSesion(sesion.sessionId, {
                        thirdPartyId: p?.nit != null ? String(p.nit) : null,
                        thirdPartyName: nombre,
                    })
                    .catch(() => {})
            }
        }
        await enviarTexto(numero, `¡Hola, ${nombre}! 👋\nSoy *Paula*, tu asistente. Es un gusto ayudarte.`)
        // Política de tratamiento de datos: solo la primera vez en el historial.
        // Si ya la aceptó (permanente por contacto), va directo al menú.
        const yaAcepto = await repo.politicaAceptadaDe(numero, POLITICA_VERSION)
        if (yaAcepto) {
            await menuPrincipal(numero)
        } else {
            await pedirAceptacionPolitica(numero)
        }
        return
    }

    // ----- POLÍTICA DE TRATAMIENTO DE DATOS -----
    if (opcion === 'acepto_politica') {
        trace(numero, 'politica', 'aceptada', { version: POLITICA_VERSION })
        try {
            await repo.fijarPoliticaAceptada(numero, POLITICA_VERSION)
        } catch (err) {
            log('[politica] No se pudo guardar la aceptación:', String(err))
        }
        await enviarTexto(numero, '✅ ¡Gracias! Registramos tu autorización. Ya puedes usar nuestros servicios.')
        await menuPrincipal(numero)
        return
    }
    if (opcion === 'rechazo_politica') {
        trace(numero, 'politica', 'rechazada', { version: POLITICA_VERSION })
        await enviarBotones(
            numero,
            'Entendido. Sin la autorización del tratamiento de datos no podemos continuar con el servicio automático. ' +
                'Si tienes dudas, puedes hablar con uno de nuestros asesores.',
            [
                { id: 'agente', title: 'Hablar con agente' },
                { id: 'salir', title: 'Salir' },
            ],
        )
        return
    }

    if (opcion === 'no_soy_yo') {
        trace(numero, 'autenticacion', 'perfil_rechazado')
        // SEGURIDAD: si el perfil NO corresponde a quien escribe, NO se puede
        // derivar al agente IA (generaría documentos de un tercero). Se envía a
        // un ASESOR HUMANO (modo MANUAL, sin agente IA) para validar identidad.
        await enviarBotones(
            numero,
            'Entendido, no hay problema. 🙂\n\nPara validar la información asociada a tu número, te comunicaremos con uno de nuestros asesores.',
            [
                { id: 'agente_humano', title: 'Hablar con un asesor' },
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
        await enviarTexto(numero, '¡Gracias por usar nuestros servicios! 🙌\nQue tengas un excelente día. 👋')
        await finalizarSesion(numero, 'USER_FINISHED')
        return
    }
    if (opcion === 'volver_menu') {
        trace(numero, 'menu', 'volver_menu')
        await menuPrincipal(numero)
        return
    }
    // ASESOR HUMANO (directo, NO al agente IA). Botón "Necesito un asesor" /
    // "Hablar con un asesor". Deriva la sesión a MANUAL y la pasa al portal para
    // que una persona la atienda. Se usa p. ej. cuando un usuario con @ aún no
    // está registrado y no puede autenticarse automáticamente.
    if (opcion === 'agente_humano') {
        await solicitarAsesorHumano(numero, 'Solicitud de asesor humano desde el bot')
        return
    }
    if (opcion === 'agente' || opcion === 'menu_4') {
        trace(numero, 'agente', 'activar_agente_ia')
        // Modo HÍBRIDO (agente IA + monitoreo del asesor): la sesión pasa a modo
        // AGENT. El asesor recibe la notificación (evento AI_AGENT_STARTED) y
        // puede VIGILAR o TOMAR el control en cualquier momento (al tomarla pasa
        // a MANUAL y el bot deja de responder). Mientras tanto, el bot sigue
        // atendiendo con la IA de Bedrock vía la API orquestadora.
        let sessionId: string
        try {
            sessionId = await getSessionId(numero)
            await repo.actualizarSesion(sessionId, { mode: 'AGENT', flow: 'AGENTE_IA' })
            // Inicia el vínculo del agente IA (teléfono como actorId para memoria
            // por persona). Caduca a los ~10 min (alineado con el watchdog).
            await repo.iniciarAgentSession(sessionId, numero, AGENT_SESSION_TTL_MS)
            // Notifica al asesor para monitoreo (el portal lo muestra en el inbox).
            await repo.registrarEvento({
                sessionId,
                eventType: 'AI_AGENT_STARTED',
                actorType: 'BOT',
                entityType: 'SESSION',
                entityId: sessionId,
            })
        } catch (err) {
            log('[db] Error activando el agente IA:', String(err))
            await enviarTexto(
                numero,
                'No pude activar el asistente en este momento. Intenta de nuevo en unos segundos. 🙏',
            )
            return
        }
        await enviarTexto(
            numero,
            '🤖 Te atiende nuestro *asistente inteligente*. Cuéntame qué necesitas y te ayudo.\n\n' +
                'Si en algún momento prefieres un asesor humano, escribe *asesor*.',
        )
        // Primer turno: saluda al agente para que se presente/active el contexto.
        await atenderTurnoAgente(numero, sessionId, 'Hola, ¿en qué me puedes ayudar?')
        return
    }
    if (opcion === 'salir') {
        trace(numero, 'salida', 'salir')
        await enviarTexto(numero, '¡Gracias por comunicarte con nosotros! 👋')
        await finalizarSesion(numero, 'USER_FINISHED')
        return
    }

    // ----- MENÚ PRINCIPAL -----
    if (opcion === 'menu_1') { trace(numero, 'menu', 'sel_extracto'); await menuAniosExtracto(numero); return }
    if (opcion === 'menu_2') { trace(numero, 'menu', 'sel_retenciones'); await menuRetenciones(numero); return }
    if (opcion === 'menu_3') {
        trace(numero, 'menu', 'sel_pqr')
        // El enlace va en su propia línea y sin adornos para que WhatsApp lo
        // detecte y lo haga clicable automáticamente.
        await enviarTexto(
            numero,
            'Nuestro interés y compromiso, es mejorar tu experiencia de servicio todos los días. ' +
                'Te invitamos a radicar tu solicitud de manera sencilla a través del siguiente enlace.\n\n' +
                'https://kawak.com.co/transportesvigia/pqrs/pqrs_index.php',
        )
        await opcionesVolverAgente(numero, '¿Deseas hacer algo más?')
        return
    }
    if (opcion === 'menu_5') {
        trace(numero, 'facturacion', 'imagen_enviada')
        const caption = '🧾 Aquí tienes la información para la *radicación de tu factura electrónica*.'
        // Preferimos media_id (archivo subido a Meta): funciona sin URL pública.
        // Si por algo no se subió, caemos al envío por URL (FACTURACION_IMG).
        if (FACTURA_MEDIA_ID) {
            await enviarImagenPorId(numero, FACTURA_MEDIA_ID, caption)
        } else {
            await enviarImagen(numero, FACTURACION_IMG, caption)
        }
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
// Extrae el timestamp (epoch en segundos) que Meta envía en cada mensaje del
// webhook. Se buscan varias ubicaciones porque BuilderBot puede exponerlo en
// distintos campos según la versión. Devuelve null si no se encuentra.
const timestampMensajeSegundos = (ctx: any): number | null => {
    const raw =
        ctx?.timestamp ??
        ctx?.messageTimestamp ??
        ctx?.message_timestamp ??
        ctx?.t ??
        ctx?.messages?.timestamp ??
        ctx?._raw?.timestamp ??
        ctx?.raw?.timestamp
    if (raw == null) return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    // Algunos proveedores lo mandan en milisegundos; normalizamos a segundos.
    return n > 1e12 ? Math.floor(n / 1000) : n
}

const mainFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
    .addAction(async (ctx) => {
        const numero = ctx.from
        const tipo = (ctx as any)?.type ?? ''
        const bodyRaw = (ctx.body ?? '').trim()
        const displayText = textoVisibleDe(bodyRaw, tipo, ctx)
        // Nombre de perfil de WhatsApp que envía Meta en el webhook (BUG-001).
        const nombrePerfil =
            (ctx as any)?.pushName ?? (ctx as any)?.name ?? (ctx as any)?.notifyName ?? undefined
        log('[in] numero:', numero, 'tipo:', tipo, 'body:', bodyRaw)

        // --------------------------------------------------------------------
        // FILTRO ANTI-REINTENTO (mensajes viejos reentregados por Meta).
        // Tras una caída/reinicio del bot, Meta reintrega los webhooks pendientes.
        // Un mensaje viejo NO debe reabrir la sesión ni relanzar el flujo (evita
        // que aparezca el menú/autenticación sin que el usuario escriba algo nuevo).
        // Si el timestamp del mensaje es anterior a (ahora - INBOUND_MAX_AGE_SECONDS)
        // se ignora. Se registra para trazabilidad. 0 = filtro desactivado.
        // --------------------------------------------------------------------
        if (INBOUND_MAX_AGE_SECONDS > 0) {
            const tsSeg = timestampMensajeSegundos(ctx)
            if (tsSeg !== null) {
                const edadSeg = Math.floor(Date.now() / 1000) - tsSeg
                if (edadSeg > INBOUND_MAX_AGE_SECONDS) {
                    log(
                        '[in] IGNORADO por antigüedad (reintento de Meta):',
                        numero,
                        'edad(s):',
                        String(edadSeg),
                        'umbral(s):',
                        String(INBOUND_MAX_AGE_SECONDS),
                    )
                    trace(numero, 'sesion', 'mensaje_viejo_ignorado', {
                        edadSegundos: edadSeg,
                        umbral: INBOUND_MAX_AGE_SECONDS,
                        tipo,
                    })
                    return
                }
            }
        }

        // --------------------------------------------------------------------
        // RESOLUCIÓN DE SESIÓN (fuente de verdad = BD, no memoria).
        // Crea una NUEVA sesión si no hay ninguna abierta (cerrada por el portal,
        // por inactividad, o inexistente). Recupera contexto tras reinicio.
        // --------------------------------------------------------------------
        let sessionId: string
        let sesionCreada: boolean
        try {
            const r = await resolverSesion(numero, nombrePerfil)
            sessionId = r.sessionId
            sesionCreada = r.creada
        } catch (err) {
            // Sin BD no podemos garantizar el ciclo de vida; registramos y salimos
            // en lugar de responder con estado potencialmente inconsistente.
            log('[db] No se pudo resolver la sesión:', String(err))
            return
        }

        // Persiste el mensaje entrante (histórico RF-006, guardando el texto
        // legible del payload interactivo para BUG-003) y marca actividad.
        try {
            await repo.guardarMensaje({
                sessionId,
                role: 'user',
                direction: 'INBOUND',
                type: 'text',
                content: bodyRaw,
                displayText,
            })
            await repo.marcarActividadUsuario(sessionId)
        } catch (err) {
            log('[db] Error persistiendo entrante (se continúa):', String(err))
        }

        // --------------------------------------------------------------------
        // RESPONSABLE DE LA CONVERSACIÓN (regla transversal 4).
        //  - MANUAL: un humano controla la conversación. Paula NO responde; solo
        //    guarda el mensaje para que el asesor lo vea y responda por la cola.
        //  - AGENT: modo híbrido IA + monitoreo. El bot SÍ responde, pero con la
        //    IA de Bedrock (vía la API). El asesor ya está notificado y puede
        //    tomar el control (al tomarla, el portal pasa la sesión a MANUAL).
        //  - AUTOMATIC: flujo de menús normal.
        // --------------------------------------------------------------------
        let modo: string = 'AUTOMATIC'
        try {
            const sesionBd = await prisma.session.findUnique({
                where: { sessionId },
                select: { mode: true },
            })
            modo = sesionBd?.mode ?? 'AUTOMATIC'
        } catch (err) {
            log('[db] Error leyendo modo (se asume AUTOMATIC):', String(err))
        }
        if (modo === 'MANUAL') {
            // Humano al mando: el bot no responde (el mensaje ya quedó persistido).
            trace(numero, 'sesion', 'mensaje_control_no_bot', { modo, texto: bodyRaw })
            return
        }
        if (modo === 'AGENT') {
            // Normalizamos la entrada para reconocer los BOTONES que acompañan
            // cada respuesta del agente ("Necesito un asesor" / "Volver al
            // menú"), que llegan como título o id según el canal.
            const opcionAgente = normalizarOpcion(bodyRaw)

            // Salida 1 — VOLVER AL MENÚ: cierra el vínculo con el agente IA y
            // regresa el control al bot (modo AUTOMATIC) mostrando el menú.
            if (opcionAgente === 'volver_menu') {
                trace(numero, 'agente_ia', 'volver_menu_desde_agente')
                await volverAlMenuDesdeAgente(numero, sessionId)
                await persistirContexto(numero)
                return
            }

            // Salida 2 — ASESOR HUMANO: por botón ("Necesito un asesor") o por
            // palabra clave escrita. Pasa la sesión a MANUAL y cierra el agente.
            const txt = bodyRaw.trim().toLowerCase()
            const pideHumano =
                opcionAgente === 'agente_humano' ||
                txt === 'asesor' ||
                txt === 'agente humano' ||
                txt === 'humano' ||
                txt === 'hablar con un asesor' ||
                txt === 'hablar con asesor'
            if (pideHumano) {
                trace(numero, 'agente_ia', 'escape_a_humano', { texto: bodyRaw })
                try {
                    await repo.actualizarSesion(sessionId, { mode: 'MANUAL' })
                    await repo.borrarAgentSession(sessionId)
                    await repo.registrarEvento({
                        sessionId,
                        eventType: 'HANDOFF_REQUESTED',
                        actorType: 'BOT',
                        entityType: 'SESSION',
                        entityId: sessionId,
                    })
                } catch (err) {
                    log('[db] Error en escape a humano:', String(err))
                }
                await enviarTexto(
                    numero,
                    '👤 En seguida te comunico con uno de nuestros asesores. ' +
                        'Por favor, espera un momento mientras uno de ellos retoma tu conversación.',
                )
                return
            }
            // Turno normal del agente IA.
            trace(numero, 'agente_ia', 'turno_usuario', { texto: bodyRaw })
            await atenderTurnoAgente(numero, sessionId, bodyRaw)
            return
        }

        // --------------------------------------------------------------------
        // SESIÓN NUEVA (NUEVA → AUTENTICACIÓN): cualquier mensaje inicia el
        // proceso arrancando por la autenticación. Ya no exige exactamente
        // "hola" (evita el bucle de "usa las opciones" cuando el usuario vuelve).
        // --------------------------------------------------------------------
        if (sesionCreada) {
            trace(numero, 'sesion', 'saludo_inicial', { texto: bodyRaw })
            await validarUsuario(numero)
            return
        }

        // --------------------------------------------------------------------
        // SESIÓN EXISTENTE en modo automático.
        // - Respuesta interactiva (lista=id, botón=título) → router.
        // - Texto libre → se reencamina al menú principal en vez de responder
        //   siempre "usa las opciones" (recuperación amable, sin bucles).
        // --------------------------------------------------------------------
        if (pareceInteractivo(tipo, bodyRaw)) {
            await procesarInteractivo(numero, bodyRaw)
            await persistirContexto(numero)
            return
        }

        // Saludo explícito en sesión ya abierta → reafirma el menú principal.
        if (bodyRaw.toLowerCase() === 'hola') {
            trace(numero, 'sesion', 'saludo_en_sesion_abierta')
            const mem = getSesion(numero)
            if (mem.propietario) {
                await menuPrincipal(numero)
            } else {
                await validarUsuario(numero)
            }
            await persistirContexto(numero)
            return
        }

        trace(numero, 'sesion', 'texto_libre_reencamina', { texto: bodyRaw })
        // Recuperación: en vez de un mensaje que puede volverse un bucle, se
        // reorienta al usuario mostrando de nuevo el menú (o autenticando).
        const mem = getSesion(numero)
        if (mem.propietario) {
            await enviarTexto(numero, 'No reconocí esa opción. Te muestro el menú para continuar. 👇')
            await menuPrincipal(numero)
        } else {
            await validarUsuario(numero)
        }
        await persistirContexto(numero)
    })

// ============================================================================
// CHEQUEO DE SALUD DEL TOKEN DE META
// ----------------------------------------------------------------------------
// Verifica al arrancar que el token de WhatsApp es válido. Si expiró (los
// tokens temporales duran ~24h), el bot procesaría los mensajes pero NO podría
// responder (Meta devuelve 403 #131005). Este chequeo lo hace visible de una.
// ============================================================================
const verificarTokenMeta = async (): Promise<void> => {
    try {
        // Consulta el estado del número: distingue número de PRUEBA vs real, que
        // es la causa típica de "recibe pero no responde" (los números de prueba
        // solo escriben a destinatarios previamente autorizados en el panel).
        const url = `https://graph.facebook.com/${META_VERSION}/${META_NUMBER_ID}?fields=display_phone_number,verified_name,platform_type&access_token=${META_JWT_TOKEN}`
        const res = await fetch(url)
        if (!res.ok) {
            const detalle = await res.text()
            log('🟠 [meta] TOKEN/NÚMERO CON PROBLEMA (HTTP ' + res.status + '):', detalle)
            log('🟠 [meta] Renueva META_JWT_TOKEN en .env (developers.facebook.com -> WhatsApp -> API Setup).')
            return
        }
        const info = (await res.json()) as {
            display_phone_number?: string
            verified_name?: string
        }
        const esNumeroPrueba = (info.verified_name ?? '').toLowerCase().includes('test')
        log('[meta] Número:', info.display_phone_number ?? '?', '(' + (info.verified_name ?? '?') + ')')
        if (esNumeroPrueba) {
            log('🟠 [meta] Estás usando un NÚMERO DE PRUEBA. Solo puedes escribir a destinatarios')
            log('🟠 [meta] previamente autorizados en WhatsApp -> API Setup -> "To" -> Manage phone number list.')
            log('🟠 [meta] Si un usuario no está en esa lista, el bot recibe su mensaje pero Meta devuelve 403 al responder.')
        } else {
            log('[meta] Token válido y número de producción. El bot puede responder a cualquier usuario.')
        }
    } catch (err) {
        log('🟠 [meta] No se pudo verificar el token de Meta:', String(err))
    }
}

// ============================================================================
// BOOTSTRAP
// ============================================================================
const main = async () => {
    const adapterFlow = createFlow([mainFlow])

    const adapterProvider = createProvider(Provider, {
        jwtToken: META_JWT_TOKEN,
        numberId: META_NUMBER_ID,
        verifyToken: META_VERIFY_TOKEN,
        version: META_VERSION,
    })
    const adapterDB = new Database()

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    // Exponer el provider para los routers.
    PROVIDER = adapterProvider

    // Avisa de inmediato si el token de Meta está vencido (causa típica de
    // "recibe pero no responde").
    await verificarTokenMeta()

    // Sube la imagen de facturación a Meta y cachea su media_id. WhatsApp no
    // puede descargar imágenes desde URLs privadas/localhost, así que la opción
    // 5 la envía por media_id (archivo ya en Meta). Es best-effort: si falla,
    // la opción 5 cae al envío por URL.
    FACTURA_MEDIA_ID = await subirMediaLocal('assets/factura.jpeg', 'image/jpeg', log)

    // Sube el PDF de política de tratamiento de datos y cachea su media_id.
    // Se envía tras la primera autenticación para que el usuario lo acepte.
    POLITICA_MEDIA_ID = await subirMediaLocal('assets/politica.pdf', 'application/pdf', log)

    // Reanuda la entrega de reportes que quedaron pendientes antes de un reinicio.
    await recuperarPendientes()

    // Inicia el worker que envía por WhatsApp los mensajes que el portal encola
    // (respuestas de asesores en modo MANUAL). Canal portal -> bot.
    iniciarWorkerSalientes(
        {
            texto: enviarTexto,
            imagen: enviarImagen,
            documento: (numero, url, filename, caption) => enviarPdf(numero, url, filename, caption),
        },
        log,
    )

    // Watchdog de inactividad (FUNC-002): cierra sesiones inactivas (10 min),
    // invalida su contexto temporal y avisa al usuario. El historial permanece.
    iniciarWatchdogSesiones({
        enviarTexto,
        log,
        olvidarMemoria: (numero: string) => {
            SESIONES.delete(numero)
            SESIONES.delete(numero.replace(/^\+/, ''))
        },
    })

    // ========================================================================
    // DIAGNÓSTICO (temporal, no invasivo): captura del webhook CRUDO de Meta.
    // ------------------------------------------------------------------------
    // Objetivo: ver la estructura real que envía Meta para usuarios que llegan
    // SIN teléfono (nuevo esquema username/BSUID) y confirmar en qué campo viene
    // el @username / user_id. Es un middleware que SOLO LEE req.body (ya parseado
    // por el provider; no consume el stream) y lo vuelca a logs/webhook-crudo.log.
    // SIEMPRE llama a next(): el flujo del bot sigue EXACTAMENTE igual. Nunca
    // lanza (try/catch total). Se activa con CAPTURAR_WEBHOOK=1 en el .env; si no
    // está activa, es un passthrough puro. Quitar cuando ya no se necesite.
    // ========================================================================
    // ========================================================================
    // RESOLUCIÓN DE IDENTIDAD (usuarios sin teléfono — esquema username/BSUID).
    // ------------------------------------------------------------------------
    // Middleware que corre ANTES del handler del provider. Para cada webhook de
    // mensaje entrante:
    //   - Si el mensaje YA trae teléfono (`from` con número): no toca nada; el
    //     flujo normal sigue EXACTAMENTE igual (owner/auth/menú/agente).
    //   - Si el mensaje viene SIN teléfono (nuevo esquema de Meta) pero con
    //     @username (contacts[].profile.username) y BSUID (from_user_id):
    //       * Si el @ está en el directorio: REESCRIBE `from` con el teléfono
    //         mapeado, de modo que el provider procese el mensaje como si hubiera
    //         venido con teléfono -> todo el flujo normal funciona sin cambios.
    //         (Y completa el BSUID en el directorio si faltaba, para re-vincular.)
    //       * Si el @ NO está registrado: responde "tu @ no está registrado" al
    //         BSUID por la Graph API y DETIENE el webhook (no llega al provider,
    //         evitando el crash por remitente vacío).
    // Si CAPTURAR_WEBHOOK=1, además vuelca el crudo a logs/webhook-crudo.log.
    // Nunca lanza: ante cualquier error deja pasar el webhook sin tocarlo.
    // ========================================================================
    ;(adapterProvider.server as any).use(async (req: any, res: any, next: any) => {
        try {
            const esWebhook =
                req?.method === 'POST' &&
                typeof req?.url === 'string' &&
                req.url.includes('/webhook')
            const body = req?.body
            if (!esWebhook || !body || typeof body !== 'object') return next()

            // Captura opcional del crudo (diagnóstico).
            if (process.env.CAPTURAR_WEBHOOK === '1') {
                try {
                    mkdirSync(LOG_DIR, { recursive: true })
                    appendFileSync(
                        join(LOG_DIR, 'webhook-crudo.log'),
                        `[${new Date().toISOString()}] WEBHOOK CRUDO:\n` +
                            JSON.stringify(body, null, 2) +
                            '\n----------------------------------------\n',
                    )
                } catch { /* noop */ }
            }

            const value = body?.entry?.[0]?.changes?.[0]?.value
            const message = value?.messages?.[0]
            const contact = value?.contacts?.[0]
            if (!message) return next()

            // ¿Ya trae teléfono? (esquema clásico) -> no tocar nada.
            const tieneTelefono = typeof message.from === 'string' && /^\d{6,}$/.test(message.from)
            if (tieneTelefono) return next()

            // Sin teléfono: el usuario llega con @username / BSUID (nuevo esquema).
            const username: string | undefined = contact?.profile?.username
            const bsuid: string | undefined = message?.from_user_id ?? contact?.user_id
            const nombrePerfil: string | undefined = contact?.profile?.name
            if (!bsuid) return next() // sin BSUID no hay a quién responder; dejar pasar

            // Usamos el BSUID como IDENTIDAD de la sesión: lo ponemos como
            // `message.from` para que el flujo normal (menú/owner/agente) corra
            // con esa identidad, y el transporte responda por `recipient` (Meta
            // no entrega al BSUID por el campo `to`). El usuario con @ queda
            // atendido igual que uno con teléfono, SIN depender del directorio.
            message.from = bsuid
            if (contact) contact.wa_id = bsuid

            // Pre-registramos/actualizamos la entrada del directorio con el @, el
            // BSUID y el nombre (útil para que un asesor complete teléfono/NIT y
            // para la autenticación owner). No bloquea la atención. Best-effort.
            void repo.prerregistrarEntradaPendiente(username, bsuid, nombrePerfil)
            if (username && bsuid) void repo.completarBsuidSiFalta(username, bsuid)

            log('[identidad] usuario sin teléfono -> identidad BSUID ' + bsuid + ' (@' + (username ?? '?') + ')')
            return next()
        } catch (err) {
            log('[identidad] error (se deja pasar el webhook):', String(err))
            return next()
        }
    })
    log('[identidad] Resolución de identidad por @username/BSUID ACTIVADA.')

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

    // Imagen de facturación electrónica (Vigía). Se sirve desde assets/ para
    // que Meta pueda descargarla por URL pública (WhatsApp no acepta archivos
    // locales, solo enlaces). Requiere que este servidor sea accesible por la
    // URL configurada en FACTURACION_IMG (idealmente HTTPS en producción).
    adapterProvider.server.get('/v1/assets/factura', (_req, res) => {
        try {
            const img = readFileSync(join(process.cwd(), 'assets', 'factura.jpeg'))
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Cache-Control': 'public, max-age=86400',
            })
            return res.end(img)
        } catch (err) {
            log('[assets] No se pudo servir la imagen de factura:', String(err))
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            return res.end('No encontrada.')
        }
    })

    // Salud de la cola de salida (WS-05): contadores por estado + antigüedad del
    // PENDING más viejo. Marca `alert=true` si la cola crece/envejece por encima
    // de umbrales configurables (OUTBOUND_ALERT_*), para monitoreo externo.
    adapterProvider.server.get('/v1/queue', async (_req, res) => {
        try {
            const estado = await repo.estadoCola()
            const maxPending = Number(process.env.OUTBOUND_ALERT_PENDING ?? 50)
            const maxAgeMs = Number(process.env.OUTBOUND_ALERT_AGE_MS ?? 120000)
            const alert =
                estado.pending > maxPending ||
                estado.failed > 0 ||
                estado.oldestPendingAgeMs > maxAgeMs
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            return res.end(JSON.stringify({ status: 'ok', alert, queue: estado }))
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            return res.end(JSON.stringify({ status: 'error', error: String(err) }))
        }
    })

    httpServer(+PORT)
}

main()
