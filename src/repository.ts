// ============================================================================
// Repositorio de persistencia del bot sobre PostgreSQL (base 'paula').
// Concentra toda la lógica de lectura/escritura para que app.ts no dependa
// directamente de Prisma. Estas funciones reemplazan el Map SESIONES en
// memoria y el TODO(BD) de trazas del diseño original.
// ============================================================================
import {
  prisma,
  nuevoSessionId,
  nuevoMessageId,
  nuevoEventId,
  aE164,
  contactIdDe,
} from './db'
import type {
  Session,
  MessageRole,
  MessageDirection,
  MessageType,
  ConversationMode,
  ConversationStatus,
  AuditActorType,
} from '@prisma/client'

// ----------------------------------------------------------------------------
// Contactos
// ----------------------------------------------------------------------------

/** Crea o actualiza el contacto de WhatsApp y devuelve su contact_id. */
export const upsertContacto = async (numero: string, nombrePerfil?: string): Promise<string> => {
  const contactId = contactIdDe(numero)
  const phone = aE164(numero)
  await prisma.contact.upsert({
    where: { contactId },
    create: {
      contactId,
      phoneE164: phone,
      providerProfileName: nombrePerfil,
      lastSeenAt: new Date(),
    },
    update: {
      lastSeenAt: new Date(),
      ...(nombrePerfil ? { providerProfileName: nombrePerfil } : {}),
    },
  })
  return contactId
}

/**
 * Fija el nombre a mostrar del contacto (displayName). Es el nombre autoritativo
 * que el portal muestra (BUG-001), p. ej. el nombre real del propietario devuelto
 * por PhariTech al autenticar. Prevalece sobre el providerProfileName de Meta.
 */
export const fijarNombreContacto = async (numero: string, nombre: string): Promise<void> => {
  const contactId = contactIdDe(numero)
  await prisma.contact.update({
    where: { contactId },
    data: { displayName: nombre },
  })
}

// ----------------------------------------------------------------------------
// Política de tratamiento de datos (aceptación única y permanente por contacto)
// ----------------------------------------------------------------------------

/**
 * Indica si el contacto YA aceptó la política de tratamiento de datos para la
 * versión dada. Permanente: no depende de la sesión. Si la versión aceptada no
 * coincide con la vigente, se considera NO aceptada (para re-solicitar si la
 * política cambia). Ante error de BD devuelve true para no bloquear el flujo.
 */
export const politicaAceptadaDe = async (
  numero: string,
  version: string,
): Promise<boolean> => {
  try {
    const contactId = contactIdDe(numero)
    const c = await prisma.contact.findUnique({
      where: { contactId },
      select: { policyAcceptedAt: true, policyVersion: true },
    })
    if (!c || !c.policyAcceptedAt) return false
    // Si hay versión vigente, exige que coincida; si no se maneja versión, basta la fecha.
    return c.policyVersion === version
  } catch (err) {
    console.error('[politica] no se pudo leer aceptación:', String(err))
    return true // no bloquear el servicio por un fallo de lectura
  }
}

/** Marca la política como aceptada por el contacto (fecha + versión). Permanente. */
export const fijarPoliticaAceptada = async (
  numero: string,
  version: string,
): Promise<void> => {
  const contactId = contactIdDe(numero)
  await prisma.contact.update({
    where: { contactId },
    data: { policyAcceptedAt: new Date(), policyVersion: version },
  })
}

// ----------------------------------------------------------------------------
// Sesiones
// ----------------------------------------------------------------------------

/**
 * Devuelve la sesión abierta (ACTIVE / PENDING_TIMEOUT / CREATED) más reciente
 * de un teléfono, o null si no hay ninguna reutilizable. RF-004.
 */
export const sesionAbiertaDe = async (numero: string): Promise<Session | null> => {
  const phone = aE164(numero)
  return prisma.session.findFirst({
    where: {
      phoneE164: phone,
      status: { in: ['CREATED', 'ACTIVE', 'PENDING_TIMEOUT'] },
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Ventana de REACTIVACIÓN (horas): tras cerrarse por inactividad (TIMEOUT), la
 * MISMA sesión puede reutilizarse si el cliente vuelve a escribir dentro de esta
 * ventana (contada desde su último mensaje). Alineada con la ventana de servicio
 * de WhatsApp/Meta (24h). Debe coincidir con REACTIVATION_WINDOW_HOURS del portal.
 */
const VENTANA_REACTIVACION_MS =
  Number(process.env.REACTIVATION_WINDOW_HOURS ?? 24) * 60 * 60 * 1000

/**
 * Devuelve la última sesión cerrada por inactividad (TIMEOUT) de un teléfono que
 * todavía esté dentro de la ventana de reactivación (24h desde el último mensaje
 * del cliente), o null. NO toca el watchdog ni los 10 min: esto solo permite
 * RETOMAR la conversación previa en vez de abrir una nueva.
 */
export const sesionReactivableDe = async (numero: string): Promise<Session | null> => {
  const phone = aE164(numero)
  const corte = new Date(Date.now() - VENTANA_REACTIVACION_MS)
  return prisma.session.findFirst({
    where: {
      phoneE164: phone,
      status: 'CLOSED',
      closeReason: 'TIMEOUT',
      OR: [
        { lastUserActivityAt: { gte: corte } },
        { lastUserActivityAt: null, closedAt: { gte: corte } },
      ],
    },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * Reabre una sesión cerrada por inactividad para reutilizarla (mismo sessionId),
 * conservando todo el historial. Vuelve a ACTIVE y limpia los marcadores de
 * cierre. NO cambia el modo (si el asesor ya la tomó en MANUAL, sigue MANUAL;
 * si el cliente escribe primero, sigue en su modo previo). RF-004 extendido.
 */
export const reabrirSesion = async (sessionId: string): Promise<void> => {
  await prisma.session.update({
    where: { sessionId },
    data: {
      status: 'ACTIVE',
      closedAt: null,
      closeReason: null,
      lastUserActivityAt: new Date(),
      version: { increment: 1 },
    },
  })
  await registrarEvento({
    sessionId,
    eventType: 'SESSION_REOPENED',
    actorType: 'SYSTEM',
    entityType: 'SESSION',
    entityId: sessionId,
    reason: 'REACTIVATION_WINDOW',
  })
}

/** Crea una nueva sesión para el teléfono. RF-003. */
export const crearSesion = async (numero: string, nombrePerfil?: string): Promise<Session> => {
  const contactId = await upsertContacto(numero, nombrePerfil)
  const phone = aE164(numero)
  const sessionId = nuevoSessionId()
  const sesion = await prisma.session.create({
    data: {
      sessionId,
      contactId,
      phoneE164: phone,
      flow: 'MENU',
      mode: 'AUTOMATIC',
      status: 'ACTIVE',
      lastUserActivityAt: new Date(),
      lastMessageAt: new Date(),
    },
  })
  await prisma.contact.update({ where: { contactId }, data: { lastSessionId: sessionId } })
  await registrarEvento({
    sessionId,
    eventType: 'SESSION_CREATED',
    actorType: 'BOT',
    entityType: 'SESSION',
    entityId: sessionId,
  })
  return sesion
}

/**
 * Obtiene la sesión abierta del teléfono o crea una nueva. Punto de entrada
 * para cada mensaje entrante. Devuelve { sesion, creada }.
 */
export const obtenerOCrearSesion = async (
  numero: string,
  nombrePerfil?: string,
): Promise<{ sesion: Session; creada: boolean }> => {
  const existente = await sesionAbiertaDe(numero)
  if (existente) {
    // Aprovecha para completar el nombre de perfil si aún falta (BUG-001).
    if (nombrePerfil) await upsertContacto(numero, nombrePerfil)
    return { sesion: existente, creada: false }
  }
  const sesion = await crearSesion(numero, nombrePerfil)
  return { sesion, creada: true }
}

/** Actualiza campos arbitrarios de la sesión (parche) e incrementa version. */
export const actualizarSesion = async (
  sessionId: string,
  data: Partial<{
    flow: string
    flowContext: Record<string, unknown> | null
    mode: ConversationMode
    status: ConversationStatus
    thirdPartyId: string | null
    thirdPartyName: string | null
    conversationSummary: string
  }>,
): Promise<void> => {
  await prisma.session.update({
    where: { sessionId },
    data: { ...(data as object), version: { increment: 1 } },
  })
}

/** Marca actividad del usuario: reactiva PENDING_TIMEOUT y limpia advertencia. RF-007. */
export const marcarActividadUsuario = async (sessionId: string): Promise<void> => {
  await prisma.session.update({
    where: { sessionId },
    data: {
      lastUserActivityAt: new Date(),
      status: 'ACTIVE',
      warningSentAt: null,
    },
  })
}

/** Cierra una sesión con motivo. RF-018/RF-023. */
export const cerrarSesion = async (
  sessionId: string,
  closeReason: 'USER_FINISHED' | 'AGENT_FINISHED' | 'TIMEOUT' | 'MANUAL' | 'SYSTEM_ERROR',
): Promise<void> => {
  await prisma.session.update({
    where: { sessionId },
    data: { status: 'CLOSED', closedAt: new Date(), closeReason, version: { increment: 1 } },
  })
  await registrarEvento({
    sessionId,
    eventType: 'SESSION_CLOSED',
    actorType: 'BOT',
    entityType: 'SESSION',
    entityId: sessionId,
    reason: closeReason,
  })
}

/**
 * Devuelve las sesiones abiertas cuya última actividad del usuario es anterior
 * al umbral dado (candidatas a cierre por inactividad). FUNC-002.
 */
export const sesionesInactivas = async (limiteMs: number): Promise<Session[]> => {
  const corte = new Date(Date.now() - limiteMs)
  return prisma.session.findMany({
    where: {
      status: { in: ['CREATED', 'ACTIVE', 'PENDING_TIMEOUT'] },
      OR: [
        { lastUserActivityAt: { lt: corte } },
        { lastUserActivityAt: null, createdAt: { lt: corte } },
      ],
    },
    orderBy: { lastUserActivityAt: 'asc' },
    take: 50,
  })
}

/**
 * Cierra una sesión por inactividad e invalida el contexto temporal (flow_context)
 * conservando el historial. FUNC-002.
 */
export const cerrarSesionPorInactividad = async (sessionId: string): Promise<void> => {
  await prisma.session.update({
    where: { sessionId },
    data: {
      status: 'CLOSED',
      closeReason: 'TIMEOUT',
      closedAt: new Date(),
      flowContext: undefined,
      version: { increment: 1 },
    },
  })
  // Invalida también el hilo del agente IA (si lo había): al reabrir, el usuario
  // arrancará una conversación nueva con el agente, no reanudará la vieja.
  await prisma.agentSession.deleteMany({ where: { sessionId } }).catch(() => undefined)
  await registrarEvento({
    sessionId,
    eventType: 'SESSION_CLOSED_INACTIVITY',
    actorType: 'SYSTEM',
    entityType: 'SESSION',
    entityId: sessionId,
    reason: 'TIMEOUT',
  })
}

// ----------------------------------------------------------------------------
// Mensajes
// ----------------------------------------------------------------------------

interface GuardarMensajeArgs {
  sessionId: string
  role: MessageRole
  direction: MessageDirection
  type?: MessageType
  content?: string
  /** Texto legible cuando `content` es un payload técnico (BUG-003). */
  displayText?: string
  externalMessageId?: string
  clientMessageId?: string
  authorId?: string
  authorName?: string
  correlationId?: string
}

/**
 * Persiste un mensaje y actualiza el resumen de la sesión (preview, contadores,
 * last_message_*). Mantiene el histórico completo (RF-006).
 */
export const guardarMensaje = async (args: GuardarMensajeArgs): Promise<string> => {
  const messageId = nuevoMessageId()
  const ahora = new Date()
  const preview = (args.content ?? '').slice(0, 160)

  await prisma.$transaction([
    prisma.message.create({
      data: {
        messageId,
        sessionId: args.sessionId,
        role: args.role,
        direction: args.direction,
        type: args.type ?? 'text',
        content: args.content,
        displayText: args.displayText,
        externalMessageId: args.externalMessageId,
        clientMessageId: args.clientMessageId,
        authorId: args.authorId,
        authorName: args.authorName,
        correlationId: args.correlationId,
      },
    }),
    prisma.session.update({
      where: { sessionId: args.sessionId },
      data: {
        lastMessageAt: ahora,
        lastMessagePreview: preview,
        lastMessageDirection: args.direction,
        messageCount: { increment: 1 },
        // La actividad del USUARIO solo cuenta para mensajes entrantes.
        ...(args.direction === 'INBOUND' ? { lastUserActivityAt: ahora } : {}),
      },
    }),
  ])

  return messageId
}

/** Atajo: mensaje saliente que envía el bot (asistente automático). */
export const guardarMensajeSalienteBot = (
  sessionId: string,
  content: string,
  type: MessageType = 'text',
  displayText?: string,
): Promise<string> =>
  guardarMensaje({
    sessionId,
    role: 'assistant',
    direction: 'OUTBOUND',
    type,
    content,
    displayText,
  })

// ----------------------------------------------------------------------------
// Auditoría (reemplaza persistirTraza / TODO(BD))
// ----------------------------------------------------------------------------

interface RegistrarEventoArgs {
  sessionId: string
  eventType: string
  actorType: AuditActorType
  entityType: string
  entityId?: string
  actorId?: string
  actorName?: string
  reason?: string
  newValue?: Record<string, unknown>
  correlationId?: string
}

/** Inserta un evento de auditoría de dominio. */
export const registrarEvento = async (args: RegistrarEventoArgs): Promise<void> => {
  try {
    await prisma.auditEvent.create({
      data: {
        eventId: nuevoEventId(),
        sessionId: args.sessionId,
        eventType: args.eventType,
        actorType: args.actorType,
        actorId: args.actorId,
        actorName: args.actorName,
        entityType: args.entityType,
        entityId: args.entityId,
        reason: args.reason,
        newValue: args.newValue as object | undefined,
        correlationId: args.correlationId,
        source: 'BOT',
      },
    })
  } catch (err) {
    // La auditoría nunca debe tumbar el flujo conversacional.
    console.error('[audit] no se pudo registrar evento:', String(err))
  }
}

// ----------------------------------------------------------------------------
// Cola de salida (portal -> bot). El portal encola aquí; el bot pollea PENDING.
// WS-05 (fiabilidad):
//   - Claim ATÓMICO con `FOR UPDATE SKIP LOCKED` (dos workers no reclaman el
//     mismo mensaje; sin ventana de carrera del viejo findMany+updateMany).
//   - Reintentos con backoff exponencial vía next_attempt_at + MAX_ATTEMPTS.
//   - Recuperación de SENDING huérfanos (proceso caído a mitad de envío).
//   - Idempotencia por clientMessageId (no duplicar mensaje del asesor).
//   - Al enviar OK, marca message.deliveryStatus = SENT.
// ----------------------------------------------------------------------------

/** Nº máximo de intentos antes de marcar FAILED de forma definitiva. */
export const MAX_OUTBOUND_ATTEMPTS = Number(process.env.OUTBOUND_MAX_ATTEMPTS ?? 5)
/** Backoff base (ms). El intento n espera BASE * 2^(n-1), con techo. */
const OUTBOUND_BACKOFF_BASE_MS = Number(process.env.OUTBOUND_BACKOFF_BASE_MS ?? 5000)
const OUTBOUND_BACKOFF_MAX_MS = Number(process.env.OUTBOUND_BACKOFF_MAX_MS ?? 300000)
/** Un SENDING más viejo que esto se considera huérfano y se reencola. */
const OUTBOUND_SENDING_TIMEOUT_MS = Number(process.env.OUTBOUND_SENDING_TIMEOUT_MS ?? 120000)

/** Forma mínima de un outbound reclamado (evita depender del tipo Prisma en el worker). */
export interface SalientePendiente {
  id: string
  sessionId: string
  phoneE164: string
  messageId: string | null
  clientMessageId: string | null
  kind: string
  content: string | null
  mediaUrl: string | null
  filename: string | null
  attempts: number
  enqueuedBy: string | null
}

/**
 * Reencola los SENDING huérfanos: mensajes que quedaron "en vuelo" porque el
 * proceso murió tras marcarlos SENDING pero antes de resolverlos. Se devuelven
 * a PENDING para que el ciclo normal los vuelva a reclamar. Idempotente.
 */
export const recuperarSalientesHuerfanos = async (): Promise<number> => {
  const corte = new Date(Date.now() - OUTBOUND_SENDING_TIMEOUT_MS)
  const r = await prisma.outboundMessage.updateMany({
    where: { status: 'SENDING', createdAt: { lt: corte } },
    data: { status: 'PENDING' },
  })
  return r.count
}

/**
 * Reclama hasta `limite` mensajes elegibles y los marca SENDING de forma
 * atómica con `FOR UPDATE SKIP LOCKED`. Elegible = PENDING y (next_attempt_at
 * es NULL o ya venció). Incrementa attempts en el mismo movimiento.
 */
export const reclamarSalientesPendientes = async (limite = 10): Promise<SalientePendiente[]> => {
  const ahora = new Date()
  // CTE: selecciona candidatos con lock de fila saltando los ya bloqueados,
  // y los actualiza a SENDING atómicamente. RETURNING para trabajarlos.
  const filas = await prisma.$queryRaw<SalientePendiente[]>`
    WITH candidatos AS (
      SELECT id
      FROM "outbound_messages"
      WHERE status = 'PENDING'
        AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${ahora})
      ORDER BY created_at ASC
      LIMIT ${limite}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "outbound_messages" o
    SET status = 'SENDING', attempts = o.attempts + 1
    FROM candidatos c
    WHERE o.id = c.id
    RETURNING
      o.id                AS "id",
      o.session_id        AS "sessionId",
      o.phone_e164        AS "phoneE164",
      o.message_id        AS "messageId",
      o.client_message_id AS "clientMessageId",
      o.kind              AS "kind",
      o.content           AS "content",
      o.media_url         AS "mediaUrl",
      o.filename          AS "filename",
      o.attempts          AS "attempts",
      o.enqueued_by       AS "enqueuedBy"
  `
  return filas
}

/**
 * Marca un saliente como enviado y, si referencia un mensaje persistido,
 * actualiza su deliveryStatus a SENT (reconciliación de entrega). WS-05.
 */
export const marcarSalienteEnviado = async (
  id: string,
  messageId?: string | null,
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    await tx.outboundMessage.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date(), lastError: null },
    })
    if (messageId) {
      await tx.message.updateMany({
        where: { messageId },
        data: { deliveryStatus: 'SENT' },
      })
    }
  })
}

/**
 * Registra un fallo de envío. Si aún quedan intentos, reprograma con backoff
 * exponencial (vuelve a PENDING con next_attempt_at futuro). Si se agotaron,
 * lo deja FAILED de forma definitiva y marca el mensaje asociado como FAILED.
 */
export const marcarSalienteFallido = async (
  id: string,
  error: string,
  attempts: number,
  messageId?: string | null,
): Promise<void> => {
  const agotado = attempts >= MAX_OUTBOUND_ATTEMPTS
  const err = error.slice(0, 500)
  if (agotado) {
    await prisma.$transaction(async (tx) => {
      await tx.outboundMessage.update({
        where: { id },
        data: { status: 'FAILED', lastError: err },
      })
      if (messageId) {
        await tx.message.updateMany({
          where: { messageId },
          data: { deliveryStatus: 'FAILED', deliveryErrorCode: err.slice(0, 64) },
        })
      }
    })
    return
  }
  const esperaMs = Math.min(
    OUTBOUND_BACKOFF_BASE_MS * 2 ** (attempts - 1),
    OUTBOUND_BACKOFF_MAX_MS,
  )
  const proximo = new Date(Date.now() + esperaMs)
  await prisma.outboundMessage.update({
    where: { id },
    data: { status: 'PENDING', lastError: err, nextAttemptAt: proximo },
  })
}

/** Estadísticas de la cola de salida para visibilidad/alertas (WS-05 tarea 7). */
export interface EstadoCola {
  pending: number
  sending: number
  sent: number
  failed: number
  /** Antigüedad (ms) del PENDING más viejo; 0 si no hay ninguno. */
  oldestPendingAgeMs: number
  /** Marca de tiempo de la medición (ISO). */
  at: string
}

/**
 * Devuelve contadores por estado de `outbound_messages` y la antigüedad del
 * PENDING más viejo. Sirve para exponer en un endpoint de salud y para alertar
 * si la cola crece o envejece por encima de un umbral.
 */
export const estadoCola = async (): Promise<EstadoCola> => {
  const [grupos, masViejo] = await Promise.all([
    prisma.outboundMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.outboundMessage.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ])
  const conteo = (s: string) =>
    grupos.find((g) => g.status === s)?._count._all ?? 0
  return {
    pending: conteo('PENDING'),
    sending: conteo('SENDING'),
    sent: conteo('SENT'),
    failed: conteo('FAILED'),
    oldestPendingAgeMs: masViejo ? Date.now() - masViejo.createdAt.getTime() : 0,
    at: new Date().toISOString(),
  }
}

// ----------------------------------------------------------------------------
// Reportes pendientes (WS-08). Reemplaza logs/pendientes.json por la tabla
// pending_reports: sobrevive reinicios/despliegues y es la fuente única. El bot
// recupera los pendientes al arrancar y reanuda el polling del PDF.
// ----------------------------------------------------------------------------

/** Forma de un reporte pendiente (equivale al viejo ReportePendiente en disco). */
export interface ReportePendienteRow {
  reportId: string
  phoneE164: string
  label: string
  filename: string
  caption: string
  successText: string
}

/** Registra (o refresca) un reporte pendiente. Idempotente por reportId. */
export const agregarReportePendiente = async (r: ReportePendienteRow): Promise<void> => {
  await prisma.pendingReport.upsert({
    where: { reportId: r.reportId },
    create: {
      reportId: r.reportId,
      phoneE164: r.phoneE164,
      label: r.label,
      filename: r.filename,
      caption: r.caption,
      successText: r.successText,
    },
    update: {
      phoneE164: r.phoneE164,
      label: r.label,
      filename: r.filename,
      caption: r.caption,
      successText: r.successText,
    },
  })
}

/** Elimina un reporte pendiente ya resuelto (entregado o terminal). Idempotente. */
export const quitarReportePendiente = async (reportId: string): Promise<void> => {
  await prisma.pendingReport.deleteMany({ where: { reportId } })
}

/** Lista los reportes pendientes (para recuperar al arrancar), más antiguos primero. */
export const listarReportesPendientes = async (): Promise<ReportePendienteRow[]> => {
  const filas = await prisma.pendingReport.findMany({ orderBy: { createdAt: 'asc' } })
  return filas.map((f) => ({
    reportId: f.reportId,
    phoneE164: f.phoneE164,
    label: f.label,
    filename: f.filename,
    caption: f.caption,
    successText: f.successText,
  }))
}

// ----------------------------------------------------------------------------
// Sesiones del agente IA (Bedrock vía la API orquestadora).
// Relaciona 1:1 la conversación de Paula con el sessionId que mantiene la
// memoria del agente en AWS. El hilo CADUCA (expiresAt): pasado ese momento el
// vínculo se considera vencido y el siguiente turno arranca uno nuevo. El bot
// NO guarda credenciales de AWS; aquí solo se persiste el id de conversación.
// ----------------------------------------------------------------------------

/** Vínculo vigente (no vencido) de la conversación con el agente IA, o null. */
export interface AgentSessionVigente {
  bedrockSessionId: string | null
  actorId: string | null
}

/**
 * Crea o reinicia el vínculo de agente IA para una conversación. Se llama al
 * activar el modo agente: fija actorId (teléfono) y la ventana de expiración.
 * Si ya existía, lo reinicia (nuevo expiresAt, limpia el bedrockSessionId para
 * empezar un hilo fresco salvo que se pase uno).
 */
export const iniciarAgentSession = async (
  sessionId: string,
  actorId: string,
  ttlMs: number,
): Promise<void> => {
  const expiresAt = new Date(Date.now() + ttlMs)
  await prisma.agentSession.upsert({
    where: { sessionId },
    create: { sessionId, actorId, bedrockSessionId: null, lastActivityAt: new Date(), expiresAt },
    update: { actorId, bedrockSessionId: null, lastActivityAt: new Date(), expiresAt },
  })
}

/**
 * Devuelve el vínculo del agente IA SOLO si sigue vigente (no vencido). Si no
 * existe o ya expiró, devuelve null (el caller arranca un hilo nuevo sin
 * reenviar el bedrockSessionId viejo).
 */
export const agentSessionVigente = async (
  sessionId: string,
): Promise<AgentSessionVigente | null> => {
  const row = await prisma.agentSession.findUnique({ where: { sessionId } })
  if (!row) return null
  if (row.expiresAt.getTime() <= Date.now()) return null
  return { bedrockSessionId: row.bedrockSessionId, actorId: row.actorId }
}

/**
 * Refresca la actividad del vínculo (bump de lastActivityAt + expiresAt) y, si
 * se indica, guarda el bedrockSessionId devuelto por la API (para los próximos
 * turnos). Mantiene vivo el hilo mientras el usuario sigue conversando.
 */
export const refrescarAgentSession = async (
  sessionId: string,
  ttlMs: number,
  bedrockSessionId?: string | null,
): Promise<void> => {
  const expiresAt = new Date(Date.now() + ttlMs)
  await prisma.agentSession.update({
    where: { sessionId },
    data: {
      lastActivityAt: new Date(),
      expiresAt,
      ...(bedrockSessionId ? { bedrockSessionId } : {}),
    },
  })
}

/** Borra el vínculo del agente IA de una conversación (fin de modo IA). */
export const borrarAgentSession = async (sessionId: string): Promise<void> => {
  await prisma.agentSession.deleteMany({ where: { sessionId } })
}

/**
 * Borra los vínculos de agente IA ya vencidos (barrido periódico). Devuelve el
 * número de filas eliminadas. El hilo del agente en AWS caduca por su cuenta;
 * aquí solo limpiamos nuestra tabla para no reanudar hilos viejos.
 */
export const purgarAgentSessionsVencidas = async (): Promise<number> => {
  const r = await prisma.agentSession.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  return r.count
}

// ----------------------------------------------------------------------------
// Directorio de teléfonos (@username/BSUID -> teléfono + NIT).
// Soporta a los usuarios que llegan SIN teléfono (esquema username/BSUID de
// Meta): a partir del @username (o del BSUID) resolvemos su teléfono para poder
// autenticarlos (owner/PhariTech) y seguir el flujo normal. El directorio lo
// administra un humano desde el portal.
// ----------------------------------------------------------------------------

/** Resultado de resolver una identidad de WhatsApp a un teléfono. */
export interface PhoneDirectoryMatch {
  phoneE164: string
  nit: string | null
  username: string
  displayName: string | null
}

/**
 * Resuelve el teléfono a partir del @username (preferido) y/o el BSUID. Busca
 * primero por BSUID (estable) y, si no, por @username (normalizado a MAYÚSCULAS,
 * sin '@'). Devuelve null si no hay registro.
 */
export const resolverTelefonoPorIdentidad = async (
  username: string | null | undefined,
  bsuid: string | null | undefined,
): Promise<PhoneDirectoryMatch | null> => {
  try {
    let row = null as Awaited<ReturnType<typeof prisma.phoneDirectory.findFirst>> | null
    if (bsuid) {
      row = await prisma.phoneDirectory.findUnique({ where: { bsuid } })
    }
    if (!row && username) {
      const u = username.trim().replace(/^@/, '').toUpperCase()
      row = await prisma.phoneDirectory.findUnique({ where: { username: u } })
    }
    // Si existe pero AÚN no tiene teléfono (entrada pendiente), no se puede
    // resolver: devolvemos null para que el bot pida completar el registro.
    if (!row || !row.phoneE164) return null
    return {
      phoneE164: row.phoneE164,
      nit: row.nit,
      username: row.username,
      displayName: row.displayName,
    }
  } catch (err) {
    console.error('[directorio] error resolviendo identidad:', String(err))
    return null
  }
}

/**
 * Si una entrada existe por @username pero aún no tiene BSUID guardado, lo
 * completa (para poder re-vincular por BSUID aunque el usuario cambie el @).
 * Best-effort: nunca lanza.
 */
export const completarBsuidSiFalta = async (
  username: string,
  bsuid: string,
): Promise<void> => {
  try {
    const u = username.trim().replace(/^@/, '').toUpperCase()
    const row = await prisma.phoneDirectory.findUnique({ where: { username: u } })
    if (row && !row.bsuid) {
      await prisma.phoneDirectory.update({ where: { id: row.id }, data: { bsuid } })
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Pre-registra en el directorio una entrada PENDIENTE para un usuario que llegó
 * sin teléfono y que aún no estaba registrado: deja el @username, el BSUID y el
 * nombre YA insertados, SIN teléfono. Así el asesor lo ve en el directorio con
 * el @ listo y solo completa el teléfono + NIT (no tiene que teclear el @, lo
 * que evita errores de tipeo). Idempotente: si ya existe (por @ o BSUID), no
 * duplica y completa datos que falten. Best-effort: nunca lanza.
 *
 * Devuelve true si la entrada quedó pre-registrada (o ya existía), false si no
 * se pudo (p. ej. sin @ ni BSUID).
 */
export const prerregistrarEntradaPendiente = async (
  username: string | null | undefined,
  bsuid: string | null | undefined,
  displayName: string | null | undefined,
): Promise<boolean> => {
  try {
    const u = username ? username.trim().replace(/^@/, '').toUpperCase() : null
    const b = bsuid ? bsuid.trim() : null
    if (!u && !b) return false

    // ¿Ya existe por @username o por BSUID?
    const existente = await prisma.phoneDirectory.findFirst({
      where: {
        OR: [
          ...(u ? [{ username: u }] : []),
          ...(b ? [{ bsuid: b }] : []),
        ],
      },
    })
    if (existente) {
      // Completa datos que falten (BSUID/nombre), sin pisar lo que ya hay.
      const data: { bsuid?: string; displayName?: string } = {}
      if (b && !existente.bsuid) data.bsuid = b
      if (displayName && !existente.displayName) data.displayName = displayName.trim()
      if (Object.keys(data).length > 0) {
        await prisma.phoneDirectory.update({ where: { id: existente.id }, data })
      }
      return true
    }

    // No existe: crea la entrada pendiente (sin teléfono). El @ es obligatorio
    // como clave; si no tenemos @ pero sí BSUID, usamos el BSUID como @ provisional.
    const usernameFinal = u ?? `BSUID_${b}`
    await prisma.phoneDirectory.create({
      data: {
        username: usernameFinal,
        phoneE164: null,
        bsuid: b,
        displayName: displayName?.trim() || null,
      },
    })
    return true
  } catch (err) {
    console.error('[directorio] no se pudo pre-registrar entrada pendiente:', String(err))
    return false
  }
}
