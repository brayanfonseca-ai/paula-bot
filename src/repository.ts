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

/** Crea una nueva sesión para el teléfono. RF-003. */
export const crearSesion = async (numero: string): Promise<Session> => {
  const contactId = await upsertContacto(numero)
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
): Promise<{ sesion: Session; creada: boolean }> => {
  const existente = await sesionAbiertaDe(numero)
  if (existente) return { sesion: existente, creada: false }
  const sesion = await crearSesion(numero)
  return { sesion, creada: true }
}

/** Actualiza campos arbitrarios de la sesión (parche) e incrementa version. */
export const actualizarSesion = async (
  sessionId: string,
  data: Partial<{
    flow: string
    mode: ConversationMode
    status: ConversationStatus
    thirdPartyId: string | null
    thirdPartyName: string | null
    conversationSummary: string
  }>,
): Promise<void> => {
  await prisma.session.update({
    where: { sessionId },
    data: { ...data, version: { increment: 1 } },
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

// ----------------------------------------------------------------------------
// Mensajes
// ----------------------------------------------------------------------------

interface GuardarMensajeArgs {
  sessionId: string
  role: MessageRole
  direction: MessageDirection
  type?: MessageType
  content?: string
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

/** Atajo: mensaje entrante del tercero (usuario de WhatsApp). */
export const guardarMensajeEntrante = (
  sessionId: string,
  content: string,
  externalMessageId?: string,
): Promise<string> =>
  guardarMensaje({
    sessionId,
    role: 'user',
    direction: 'INBOUND',
    type: 'text',
    content,
    externalMessageId,
  })

/** Atajo: mensaje saliente que envía el bot (asistente automático). */
export const guardarMensajeSalienteBot = (
  sessionId: string,
  content: string,
  type: MessageType = 'text',
): Promise<string> =>
  guardarMensaje({
    sessionId,
    role: 'assistant',
    direction: 'OUTBOUND',
    type,
    content,
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
// ----------------------------------------------------------------------------

/** Reclama hasta `limite` mensajes PENDING y los marca SENDING (evita doble envío). */
export const reclamarSalientesPendientes = async (limite = 10) => {
  const pendientes = await prisma.outboundMessage.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: limite,
  })
  if (!pendientes.length) return []
  const ids = pendientes.map((p) => p.id)
  await prisma.outboundMessage.updateMany({
    where: { id: { in: ids }, status: 'PENDING' },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  })
  return pendientes
}

/** Marca un saliente como enviado y persiste el mensaje del asesor en el histórico. */
export const marcarSalienteEnviado = async (id: string): Promise<void> => {
  await prisma.outboundMessage.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date() },
  })
}

/** Marca un saliente como fallido con el error. */
export const marcarSalienteFallido = async (id: string, error: string): Promise<void> => {
  await prisma.outboundMessage.update({
    where: { id },
    data: { status: 'FAILED', lastError: error.slice(0, 500) },
  })
}
