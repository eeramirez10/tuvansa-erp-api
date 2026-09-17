# Tuvansa ERP API

Backend Express + TypeScript para migrar progresivamente el ERP Proscai.

Para continuar la investigación desde otra instalación de Codex CLI, lee
[`AGENTS.md`](AGENTS.md) y la
[`guía de traspaso y captura SQL`](docs/PROSCAI-MIGRATION-HANDOFF.md).

MySQL es el origen heredado de lectura. Las escrituras de **Pedidos** se guardan
en PostgreSQL/Neon mediante datasources separados. Los demás módulos permanecen
en lectura hasta migrar sus adaptadores; la API bloquea sus escrituras heredadas.

Pega la URL de Neon en `NEON_DATABASE_URL` dentro del `.env` local y reinicia la
API. Las migraciones se aplican automáticamente al primer acceso de pedidos.
También puedes comprobarlas con `pnpm db:neon:check`.
Consulta [configuración, arquitectura y alcance](docs/NEON-WRITE-DATABASE.md).

## Arquitectura

Cada modulo se divide en:

- `domain`: entidades y contratos de repositorios y fuentes de datos, sin
  dependencias externas.
- `application`: casos de uso y DTOs.
- `infrastructure`: acceso al origen Proscai e implementaciones tecnicas.
- `presentation`: controladores, validacion y rutas HTTP.

Las dependencias apuntan hacia el dominio. El SQL vive exclusivamente en los
`infrastructure/datasources`; los repositorios de infraestructura solamente
delegan al datasource correspondiente. Esto permite incorporar posteriormente
datasources y repositories PostgreSQL sin cambiar presentacion ni aplicacion.

## Comandos

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Endpoints iniciales

```text
GET /health
GET /api/accounts-receivable/clients
GET /api/accounts-receivable/clients/:clientId
GET /api/accounts-receivable/clients/:clientId/balance
GET /api/accounts-receivable/clients/:clientId/movements
GET /api/accounts-receivable/clients/:clientId/invoices
GET /api/accounts-receivable/clients/:clientId/orders
GET /api/accounts-receivable/clients/:clientId/products/ordered
GET /api/accounts-receivable/clients/:clientId/products/quoted
GET /api/accounts-receivable/clients/:clientId/products/sold
GET /api/accounts-receivable/clients/:clientId/products/sold-detail
GET /api/accounts-receivable/clients/:clientId/sales/annual
GET /api/accounts-receivable/clients/:clientId/sales/annual-summary
GET /api/accounts-receivable/clients/:clientId/sales/by-branch
GET /api/accounts-receivable/clients/:clientId/sales/edi
GET /api/accounts-receivable/clients/:clientId/work-in-progress
GET /api/accounts-receivable/clients/:clientId/ct/products/ordered
GET /api/accounts-receivable/clients/:clientId/ct/products/sold
GET /api/accounts-receivable/clients/:clientId/ct/work-in-progress
GET /api/accounts-receivable/clients/:clientId/actions/classifications
GET /api/accounts-receivable/clients/:clientId/actions/destinations
GET /api/accounts-receivable/clients/:clientId/actions/block-status
GET /api/accounts-receivable/clients/:clientId/actions/discounts
GET /api/accounts-receivable/clients/:clientId/actions/events
GET /api/accounts-receivable/clients/:clientId/actions/branches
GET /api/accounts-receivable/clients/:clientId/actions/photo
GET /api/accounts-receivable/clients/:clientId/actions/contacts
GET /api/inventories/products
POST /api/inventories/products
GET /api/inventories/products/:productId
GET /api/inventories/products/:productId/previous
GET /api/inventories/products/:productId/next
PATCH /api/inventories/products/:productId
DELETE /api/inventories/products/:productId
```

La documentacion detallada de cada pantalla indica cuales endpoints son de
lectura y cuales reproducen los botones de escritura capturados en OMNIS.

## Solicitudes HTTP

La carpeta `http/` contiene solicitudes ejecutables para validar manualmente
los endpoints. Cada modulo tendra su propio archivo `.http`.

## Producción con Docker

El repositorio incluye una imagen multi-stage y una definición de Compose para
Linux. Las credenciales se proporcionan en el servidor mediante
`.env.production` y nunca se incorporan a la imagen.

```bash
cp .env.production.example .env.production
docker compose --env-file .env.production -f compose.production.yml up -d --build
curl --fail http://127.0.0.1:3000/health
```

La guía completa de preparación, actualización, logs y rollback está en
[`docs/deployment/docker-production.md`](docs/deployment/docker-production.md).
