// ============================================================================
// Acceso a la base de datos PostgreSQL compartida (paula).
// El bot persiste aquí contactos, sesiones, mensajes y trazas de auditoría,
// y lee la cola de salida (outbound_messages) que el portal encola.
//
// Reemplaza el estado en memoria (Map SESIONES) y el TODO(BD) de trazas.
// El cliente se conecta usando DATABASE_URL del .env.
// ============================================================================
import { PrismaClient } from '@prisma/client'

// Singleton para evitar múltiples pools con nodemon/tsx (hot reload).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// ----------------------------------------------------------------------------
// Utilidades de identificadores (equivalente relacional a los prefijos ULID
// del data-model: SES#, MSG#, EVT#). Usamos ids ordenables por tiempo.
// ----------------------------------------------------------------------------
const rand = () => Math.random().toString(36).slice(2, 10)

/** Id de sesión ordenable: SES#<fecha>#<rand>. */
export const nuevoSessionId = (): string => {
  const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `SES#${fecha}#${Date.now().toString(36)}${rand()}`
}

export const nuevoMessageId = (): string => `MSG#${Date.now().toString(36)}${rand()}`
export const nuevoEventId = (): string => `EVT#${Date.now().toString(36)}${rand()}`

/** Normaliza un teléfono de WhatsApp (BuilderBot entrega sin '+') a E.164. */
export const aE164 = (numero: string): string => (numero.startsWith('+') ? numero : `+${numero}`)

/** contact_id canónico para WhatsApp: WA#<E164>. */
export const contactIdDe = (numero: string): string => `WA#${aE164(numero)}`

export default prisma
