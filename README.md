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
GET /api/accounts-receivable/clients/:clientCode
```

Los endpoints de clientes quedan preparados, pero el repositorio de Proscai no
se conectara hasta documentar la pantalla y confirmar el origen de los datos.
