# Tuvansa ERP API

Backend Express + TypeScript para migrar progresivamente el ERP Proscai.

La primera etapa consulta el origen legado y reproduce, modulo por modulo, las
operaciones confirmadas mediante captura de OMNIS. Las credenciales configuradas
determinan si los endpoints de escritura pueden ejecutarse contra la base de
pruebas. Al crear la nueva base de datos, los adaptadores se reemplazaran sin
cambiar los casos de uso ni el contrato HTTP.

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
