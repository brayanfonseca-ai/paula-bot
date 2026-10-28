// ============================================================================
// WS-04 Schema ownership — sincroniza el schema Prisma del bot desde la FUENTE
// CANÓNICA del portal (paula-portal/libs/db/prisma/schema.prisma).
//
// El bot NO mantiene un schema propio a mano: lo DERIVA del canónico. Así hay
// una única fuente de verdad y no puede haber drift silencioso. La única
// diferencia permitida es el bloque `generator` (el bot genera su cliente al
// `@prisma/client` por defecto; el portal usa un `output` propio).
//
// Uso:
//   node scripts/sync-schema.mjs          → copia/normaliza el schema del bot
//   node scripts/sync-schema.mjs --check  → falla si el bot está desincronizado
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BOT_ROOT = join(__dirname, '..')
const CANON = join(BOT_ROOT, '..', 'paula-portal', 'libs', 'db', 'prisma', 'schema.prisma')
const BOT_SCHEMA = join(BOT_ROOT, 'prisma', 'schema.prisma')

const BANNER =
  '// ============================================================================\n' +
  '// ARCHIVO GENERADO — NO EDITAR A MANO.\n' +
  '// Fuente de verdad: paula-portal/libs/db/prisma/schema.prisma\n' +
  '// Regenerar con: node scripts/sync-schema.mjs  (o npm run prisma:generate)\n' +
  '// ============================================================================\n'

// Deriva el schema del bot a partir del canónico:
//  - reemplaza el bloque generator por uno sin `output` (cliente por defecto).
//  - antepone un banner de "archivo generado".
function derivarDesdeCanonico(canon) {
  const generatorBot =
    'generator client {\n  provider = "prisma-client-js"\n}\n'
  const sinGenerator = canon.replace(
    /generator\s+client\s*\{[\s\S]*?\}\s*/m,
    generatorBot,
  )
  return BANNER + '\n' + sinGenerator.trimStart()
}

function main() {
  const check = process.argv.includes('--check')
  if (!existsSync(CANON)) {
    console.error('[sync-schema] No se encontró el schema canónico en:', CANON)
    process.exit(check ? 1 : 0) // en build local sin portal, no bloquea
    return
  }
  const canon = readFileSync(CANON, 'utf8')
  const derivado = derivarDesdeCanonico(canon)
  const actual = existsSync(BOT_SCHEMA) ? readFileSync(BOT_SCHEMA, 'utf8') : ''

  const norm = (s) => s.replace(/\r\n/g, '\n').trim()

  if (check) {
    if (norm(actual) !== norm(derivado)) {
      console.error('[sync-schema] DRIFT: el schema del bot difiere del canónico.')
      console.error('              Ejecuta: node scripts/sync-schema.mjs')
      process.exit(1)
    }
    console.log('[sync-schema] OK: el schema del bot está sincronizado con el canónico.')
    return
  }

  if (norm(actual) !== norm(derivado)) {
    writeFileSync(BOT_SCHEMA, derivado, 'utf8')
    console.log('[sync-schema] schema del bot actualizado desde el canónico.')
  } else {
    console.log('[sync-schema] sin cambios (ya sincronizado).')
  }
}

main()
