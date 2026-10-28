# paula-bot

Bot de WhatsApp del sistema **Paula**. Node + TypeScript, framework **BuilderBot** con
provider de Meta (WhatsApp Cloud API), empaquetado con **rollup** a `dist/app.js`. Corre bajo
PM2 en el puerto **3009** y comparte la base PostgreSQL `paula` con el portal.

## Qué hace
Atiende a clientes por WhatsApp: autenticación, consulta de documentos tributarios, entrega
de PDFs, derivación a un asesor humano (handoff) y modo agente IA. Persiste sesiones,
mensajes y auditoría en PostgreSQL (vía Prisma) y drena una cola de salida
(`outbound_messages`) con reintentos.

## Estructura
```text
src/
  app.ts               # punto de entrada (webhook + arranque)
  config.ts            # lectura de variables de entorno
  repository.ts        # acceso a datos (Prisma)
  outbound-worker.ts   # drena la cola de salida y envía por WhatsApp
  session-watchdog.ts  # cierra sesiones inactivas
  wa-transport.ts      # envío por teléfono (to) o BSUID/@username (recipient)
  agente-ia.ts         # integración con el agente IA externo
  tls-setup.ts         # añade la CA corporativa (import de efecto, PRIMERO en app.ts)
prisma/schema.prisma   # copia del esquema que consume el bot (derivada del canónico del portal)
```

## Desarrollo
```powershell
npm install
npm run build          # rollup -> dist/app.js
npm run dev            # arranque con --watch
npm run lint
```

## Configuración
Copia `.env.example` a `.env` y completa las claves de Meta, `DATABASE_URL`, `PORT` y
`NODE_EXTRA_CA_CERTS`. El `.env` no se versiona.

## Más información
La documentación del servidor, el despliegue y las buenas prácticas están en
[`../docs`](../docs/README.md). Para la arquitectura completa, ver
[`../docs/02-ARQUITECTURA-REFERENCIA-PAULA.md`](../docs/02-ARQUITECTURA-REFERENCIA-PAULA.md).
