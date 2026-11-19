# Preparación del catálogo de productos en PostgreSQL

Inventarios P.T. y M.P. comparten los contratos de producto. Esta etapa prepara
la copia conciliada y un datasource PostgreSQL para esos contratos. La
composición HTTP y su límite de escritura permanecen en el origen actual
hasta verificar el cambio de bloque con los módulos dependientes.

| Vista | Control | Contrato existente | Evidencia / tablas |
| --- | --- | --- | --- |
| Catálogo de productos | Buscar | `GET /api/inventories/products?q=...` | Captura de barra, FINV y FUNIDAD, búsqueda PostgreSQL derivada por código, descripción, EAN o UPC |
| Catálogo de productos | Anterior / Siguiente | `GET /api/inventories/products/:productId/previous` y `/next` | Captura de barra, ICOD para buscar un código distinto e ISEQ para resolver empates en destino |
| Catálogo de productos | Alta / Cambio | `POST /api/inventories/products` y `PATCH /api/inventories/products/:productId` | Captura de barra, FINV y FUNIDAD, escritura PostgreSQL derivada |
| Catálogo de productos | Baja | `DELETE /api/inventories/products/:productId` | Captura de barra, dependencias en FENS, FAXINV, FPLIN, FVANU2 y FCANU2, baja lógica local |

La referencia literal de MySQL está en [captura de la barra](product-toolbar-sql.md).
La importación MySQL es adaptada. El SQL de PostgreSQL y su esquema son derivados.
El datasource conserva el identificador legado, admite códigos históricos
duplicados y reserva desde 5 000 000 000 los identificadores de altas locales.
Las altas y los cambios de código verifican unicidad en la transacción. Las
bajas verifican las relaciones importadas y los documentos existentes de
Pedidos en PostgreSQL.

## Validación privada del catálogo

Usar una copia consistente de MySQL con las tablas requeridas en **InnoDB** y
un PostgreSQL aislado configurado mediante `NEON_DATABASE_URL`. La herramienta
consulta MySQL en una transacción de sólo lectura con aislamiento REPEATABLE
READ. La migración `002_inventory_product_catalog` se instala explícitamente y
comparte con Pedidos el registro de versión y hash. Pedidos conserva su
migración y sus datos.

```sh
pnpm exec tsx scripts/stage-postgres-product-catalog.ts --stage
```

La copia conserva la ficha, las unidades, las cuentas contables de catálogo y
la primera relación que impide dar de baja cada producto. La instalación se puede
repetir antes de realizar cambios locales en el catálogo. La transacción
compara el conteo y las sumas de existencia actual, anterior y por piezas a seis
decimales. Ante una diferencia o error revierte la copia y conserva la anterior.

Para activar el origen PostgreSQL faltan las referencias y efectos de stock de
Pedidos, las consultas de Inventarios que cruzan productos y movimientos y la
validación del bloque en la versión PROSCAI de referencia. Las pruebas
automatizadas cubren el catálogo con PGlite aislado, además del registro de
migraciones junto con Pedidos.

El 19 de noviembre de 2026 se ensayó la carga completa desde la conexión de
lectura en una instancia PGlite en memoria. Se conciliaron 56,873 productos y
las tres sumas de existencias. La búsqueda recuperó el producto `01300958`
desde la copia temporal.
