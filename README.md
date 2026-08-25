# Tuvansa ERP API

Backend Express + TypeScript para migrar progresivamente el ERP Proscai.

La primera etapa expone exclusivamente consultas de lectura sobre el origen
legado. Las escrituras se habilitaran despues de crear la nueva base de datos y
migrar la informacion.

## Arquitectura

Cada modulo se divide en:

- `domain`: entidades y contratos sin dependencias externas.
- `application`: casos de uso y DTOs.
- `infrastructure`: acceso al origen Proscai e implementaciones tecnicas.
- `presentation`: controladores, validacion y rutas HTTP.

Las dependencias apuntan hacia el dominio. La implementacion del repositorio
legado puede reemplazarse en el futuro por la nueva base de datos sin cambiar el
contrato HTTP ni los casos de uso.

## Comandos

```bash
npm install
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
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
```

Los endpoints de clientes consultan en modo de solo lectura el origen legado.

## Solicitudes HTTP

La carpeta `http/` contiene solicitudes ejecutables para validar manualmente
los endpoints. Cada modulo tendra su propio archivo `.http`.
