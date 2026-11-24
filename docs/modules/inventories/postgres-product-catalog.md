# Preparación del catálogo de productos en PostgreSQL

Inventarios P.T. y M.P. comparten la ficha y el contrato de producto. Una vez
conciliada la copia inicial, la API habilita Alta, Cambio, Baja y Bloquear
en PostgreSQL. El catálogo histórico de MySQL suministra las relaciones
y las opciones de la compañía.

| Vista | Control | Contrato existente | Evidencia / tablas |
| --- | --- | --- | --- |
| Catálogo de productos | Buscar | `GET /api/inventories/products?q=...` | Captura de barra, FINV y FUNIDAD, búsqueda PostgreSQL derivada por código, descripción, EAN o UPC |
| Catálogo de productos | Anterior / Siguiente | `GET /api/inventories/products/:productId/previous` y `/next` | Captura de barra, ICOD para buscar un código distinto e ISEQ para resolver empates en destino |
| Catálogo de productos | Alta / Cambio | `POST /api/inventories/products` y `PATCH /api/inventories/products/:productId` | Captura de barra, FINV y FUNIDAD, escritura PostgreSQL derivada |
| Catálogo de productos | Preparar alta / baja | `GET /api/inventories/products/create-options` y `GET /api/inventories/products/:productId/removal` | Unidades conciliadas, existencias, relaciones y revisión de ficha |
| Catálogo de productos | Baja | `DELETE /api/inventories/products/:productId` | Captura de barra, dependencias en FENS, FAXINV, FPLIN, FVANU2 y FCANU2, baja lógica local |
| Catálogo de productos | Bloquear / Desbloquear | `PATCH /api/inventories/products/:productId/actions/block-status` | Adaptación de FINV.IBAJA. Actualiza la disponibilidad para nuevas capturas |

La referencia literal de MySQL está en [captura de la barra](product-toolbar-sql.md).
La importación MySQL es adaptada. El SQL de PostgreSQL y su esquema son derivados.
El datasource conserva el identificador legado, admite códigos históricos
duplicados y reserva desde 5 000 000 000 los identificadores de altas locales.
Las altas y los cambios de código verifican unicidad en la transacción. Las
bajas verifican las relaciones y los documentos de Pedidos, Órdenes de compra,
Recepciones, Gastos múltiples, Facturación e Inventarios en PostgreSQL.

- **Alta** inicia la existencia en cero. Usa UNO como unidad inicial cuando
  está configurada en el catálogo. Pedidos y Compras resuelven el ID y la unidad.
- **Cambio** guarda con revisión de ficha. El cambio de código se habilita
  cuando la ficha carece de referencias que requieren propagar otra clave.
  `MINV/26,125–128` identifica los efectos en ensamble, almacén, lotes,
  trabajo en proceso y descuentos.
- **Baja** requiere existencia cero y ausencia de dependencias. Recibe código
  y revisión de la ficha. El registro retirado conserva su identidad y su código.
- **Otros** permite configurar los productos nuevos. Los movimientos web
  estándar requieren productos sin manejo de capas y en unidad base.

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

Al instalar el catálogo se incorporan las ediciones y los valores compartidos
de los pilotos previos. Las existencias de la ficha y de Almacenes incluyen
ajustes web, recepciones, remisiones y sus cancelaciones. Las pruebas aisladas
usan el mismo registro de migraciones que Pedidos.

Pedidos muestra esas existencias por almacén tanto en la búsqueda como al
cargar el producto. Al asignar un pedido, valida la unidad y la existencia
libre con el mismo bloqueo de almacén que usan los movimientos.

El 19 de noviembre de 2026 se ensayó la carga completa desde la conexión de
lectura en una instancia PGlite en memoria. Se conciliaron 56,873 productos y
las tres sumas de existencias. La búsqueda recuperó el producto `01300958`
desde la copia temporal.

El 24 de noviembre de 2026 se activó el catálogo en el PostgreSQL de pruebas
desde la base MySQL local. La conciliación de esta copia cubrió 49,179
productos. Después se probaron altas, cambios, bajas, búsquedas desde Pedidos
y Compras, entradas, salidas y traspasos entre los almacenes 01 y 11.
