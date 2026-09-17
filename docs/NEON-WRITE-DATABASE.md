# PostgreSQL/Neon para escrituras

Implementado el 2026-09-15. MySQL conserva los datos de PROSCAI en lectura. PostgreSQL guarda las altas, modificaciones y eliminaciones locales. **Primer módulo migrado: Pedidos**, incluidos el alta capturada, el POST anterior, edición, eliminación y Cotiz.

## Configuración: una URL

En el `.env` local ya existe esta entrada vacía:

```dotenv
NEON_DATABASE_URL=
```

Pega a la derecha la URL completa que entrega Neon, conservando sus parámetros TLS. No publiques ese archivo ni pegues la URL en solicitudes HTTP. Reinicia la API con `pnpm dev` o su mecanismo habitual. No hace falta cambiar la URL del frontend.

La primera operación de pedidos que necesite PostgreSQL creará automáticamente el esquema **tuvansa** y aplicará las migraciones. La base/proyecto de Neon debe existir: la aplicación crea sus tablas dentro de la base indicada por la URL, no aprovisiona una cuenta o proyecto en Neon.

Comprobación opcional, también útil para ejecutar las migraciones antes de atender tráfico:

```bash
pnpm db:neon:check
# Alias para el mismo procedimiento idempotente:
pnpm db:neon:migrate
```

Sin URL, las lecturas muestran únicamente MySQL y las escrituras devuelven `503 POSTGRES_NOT_CONFIGURED`. Con URL configurada pero inaccesible, pedidos devuelve `503 POSTGRES_UNAVAILABLE`: **no regresa silenciosamente a MySQL**, porque eso podría volver a mostrar registros eliminados localmente. Quitar expresamente la URL cambia a lectura del legado y deja de mostrar las versiones de Neon; no debe usarse como mecanismo de recuperación ante una caída.

Se usa `pg` con un pool de cinco conexiones y una conexión dedicada durante cada transacción. Los bloqueos de las migraciones y modificaciones son transaccionales; el SQL usa nombres de esquema explícitos, sin depender de `search_path` ni de bloqueos de sesión. Esto permite usar una URL directa o de conexión agrupada de Neon. Referencias: [transacciones node-postgres](https://node-postgres.com/features/transactions), [pool de conexiones de Neon](https://neon.com/docs/connect/connection-pooling). La URL no se registra y los errores públicos no exponen credenciales ni parámetros SQL.

## Comportamiento de los datos

| Operación | MySQL | PostgreSQL |
| --- | --- | --- |
| Consultar pedido heredado intacto | Lee encabezado y partidas | Comprueba si existe una versión local |
| Crear pedido | Lee cliente, producto, agente, almacén e impuestos | Guarda documento, historial y cantidades locales en una transacción |
| Editar pedido heredado | Lee el original, referencias y restricciones | Conserva una copia base y guarda la versión local con el mismo ID |
| Eliminar pedido heredado | No elimina ni actualiza el original | Marca la versión local como eliminada; la API la oculta |
| Editar/eliminar pedido nuevo | Sólo referencias/restricciones cuando corresponda | Modifica o marca como eliminado el documento local |
| Cotiz | No cambia FPENC/FINV/FALM | Cambia cotización a pedido y recalcula las diferencias locales |

Las eliminaciones son lógicas para conservar trazabilidad. Los folios eliminados permanecen reservados. Las consultas por ID, número, búsqueda, totales de paginación y navegación anterior/siguiente reconocen las versiones locales; no duplican original y copia.

Los pedidos nuevos reciben IDs desde **5 000 000 000**, fuera del rango de los IDs MySQL de 32 bits, y folios **NP5000000000**, etc. No se toca FTIPMV.TINUM. La secuencia PostgreSQL puede dejar huecos después de una operación fallida. El POST heredado permite un número explícito y verifica que no exista en ninguno de los dos orígenes; no coordina escrituras simultáneas de OMNIS con ese folio manual, por lo que se recomienda el alta con folio automático.

Los documentos locales conservan el DTO de pedidos y añaden:

```json
{ "storage": { "source": "postgres", "legacyId": null, "revision": 1 } }
```

Una modificación de un pedido heredado incluye su ID en `legacyId`. Las revisiones son de auditoría; no implementan todavía precondiciones HTTP If-Match. Las operaciones se serializan por pedido y aplican sus campos sobre la última versión local. Si se vuelve a editar el mismo campo, prevalece la última escritura.

La copia base se conserva al crear la primera versión local. Cambios posteriores de OMNIS no se fusionan automáticamente con ella: **la versión de Neon prevalece para ese pedido**. Tampoco hay sincronización de Neon hacia PROSCAI.

## Esquema y arquitectura

- `tuvansa.schema_migrations`: versión, SHA-256 y fecha. Repetir no reaplica una migración; un checksum distinto produce error. Los cambios futuros requieren otra migración.
- `tuvansa.orders`: ID, folio único sin distinción de mayúsculas, documento canónico JSONB con partidas, copia base, revisión y fechas. Es un modelo de escritura propio, no una reproducción de FPENC/FPLIN.
- `tuvansa.order_changes`: historial de creación, modificación, eliminación y conversión.
- `tuvansa.order_stock_deltas`: diferencia de cantidades pendientes por pedido/producto/almacén respecto a su copia MySQL. Una eliminación heredada registra la diferencia negativa; una conversión redistribuye pedido/cotización sin duplicar cantidades.

Contratos sin drivers en `domain/datasources`; casos de uso y DTOs sin PostgreSQL; repositories limitados a delegar. `HybridOrdersDataSource` combina lecturas y usa únicamente el puerto de PostgreSQL para mutaciones. `PostgresOrderOverlayDataSource` contiene el SQL de documentos/historial/diferencias. Las migraciones están bajo `shared/infrastructure/datasources` y el pool bajo `shared/infrastructure/database`. No hay SQL en controllers ni repositories.

La búsqueda excluye IDs locales en MySQL **antes** de contar y paginar; combina sólo la ventana necesaria del legado con los documentos locales coincidentes. La navegación usa límites por folio/ID. La implementación carga los documentos locales para filtrarlos; al crecer mucho esa base, deberá trasladarse ese filtrado a índices/consultas PostgreSQL. No carga todo el catálogo MySQL en memoria.

Todas las consultas nuevas de PostgreSQL, sus migraciones y las exclusiones de lectura son **derivadas**. La lectura de referencias y las reglas confirmadas parten de la [captura real de Pedidos](modules/sales/orders-create-sql-new-version.md); no se afirma que OMNIS emita el SQL PostgreSQL.

## Alcance y límites

- Sólo Pedidos tiene datasource de escritura PostgreSQL en esta entrega. El límite de escritura HTTP rechaza mutaciones de otros módulos con `503 MODULE_WRITES_NOT_MIGRATED`, antes de llegar a sus datasources MySQL. No es una capa de autenticación o autorización.
- Los datasources heredados de escritura se conservan como referencia, pero los endpoints de Pedidos ya no los usan. Los scripts de mantenimiento/captura independientes no pasan por el límite HTTP; deben seguir usando las credenciales de lectura y el runbook correspondiente.
- Los paneles locales de Comentarios y Cotiz están conectados; otros paneles de un pedido modificado en Neon se declaran no disponibles, en lugar de mostrar datos incoherentes del original.
- Las consultas de clientes, inventarios, facturación y otros módulos siguen mostrando el legado. Aún no combinan `order_stock_deltas` ni pedidos locales. Esa integración requerirá sus propios adaptadores; los cambios no afectan existencias ni saldos de PROSCAI.
- Se conservan los límites del alta capturada: precio en PESOS, códigos de impuesto validados, sin IEPS ni reglas automáticas de descuentos aún pendientes de validar. La edición/eliminación se bloquea si el pedido está autorizado, asignado, surtido o facturado.
- No hay transacción distribuida con MySQL ni reintentos automáticos de altas. Si se pierde una respuesta después del commit, se debe buscar el pedido antes de reenviar. Cotiz repetido no duplica cantidades; queda registrado en el historial.

## Verificación

Las pruebas usan **PostgreSQL real embebido en PGlite**, en memoria y sin credenciales. Cubren migraciones idempotentes/checksum, CRUD, contratos HTTP nuevos y anteriores, modificaciones/bajas de registros heredados, búsquedas y paginación intercaladas, navegación, revisiones, rollback, folios duplicados, diferencias de cantidades, ausencia de URL y caída de PostgreSQL sin regreso al legado. Los métodos de escritura MySQL de prueba lanzan una excepción si alguien intenta invocarlos.

El 2026-09-15 se verificó la conexión real con la URL local del usuario mediante `pnpm db:neon:check`. PostgreSQL respondió con versión 18.6; se aplicó la migración `001_orders_overlay` y se comprobaron por lectura las tablas `tuvansa.orders`, `tuvansa.order_changes` y `tuvansa.order_stock_deltas`. La API respondió `200` a una búsqueda de pedidos sin coincidencias. La URL y las credenciales no se mostraron.

El usuario confirmó que Neon es una base de desarrollo y autorizó escrituras de prueba. Con cliente `000001` y producto `01300958`, la API creó la cotización local **NP5000000000** (ID `5000000000`), la leyó, editó una partida de 1 a 2 unidades (total `137.00`), la convirtió con **Cotiz** y la dio de baja lógica. Los códigos HTTP fueron `201`, `200`, `200`, `200` y `204`; las búsquedas posteriores por ID y folio devolvieron `404`. PostgreSQL conserva las revisiones `create`, `update`, `convert`, `delete` en ese orden y ninguna diferencia de inventario pendiente para el registro eliminado. Evidencia reproducible local: `captures/neon-live-order-smoke.ts` (excluida de Git). Los pedidos originales de MySQL sólo aportaron referencias y no fueron modificados.

El driver avisó que `sslmode=require` podría cambiar de significado en una versión mayor. El pool ahora lo normaliza en memoria a `sslmode=verify-full`, conservando los demás parámetros y sin mostrar la URL; se comprobó otra vez la conexión sin el aviso. No se modificaron servicios MySQL; `SHOW GLOBAL VARIABLES LIKE 'general_log';` devolvió `OFF`. Validación de entrega: `pnpm lint`, `pnpm build` y `pnpm test`.

## Siguientes módulos

Para migrar otro módulo: definir sus contratos de almacenamiento local, crear una migración nueva, implementar su datasource PostgreSQL y composición de lecturas, conectar los repositories, cubrir las pruebas de ausencia de escrituras MySQL y entonces habilitar sus rutas en `postgresWriteBoundary`. No habilitar rutas mientras sigan delegando a un datasource de escritura heredado.
