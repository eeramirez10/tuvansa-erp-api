# Barra de herramientas del Catalogo de clientes

Captura realizada en la base local de pruebas el 26 de agosto de 2026. La
biblioteca se abrio mediante `PROSCAI.lnk`, que ejecuta la copia aislada de
OMNIS ubicada bajo `C:\PROSCAI\OMNIS\OMD`.

La prueba de escritura uso el cliente temporal `ZZT826` (`CLISEQ = 24177`). El
registro se creo, se modifico y se elimino durante la misma captura. Una
consulta posterior confirmo que ya no existe.

## Correspondencia visual

| Orden | Icono | Accion confirmada en OMNIS | Tipo |
| ---: | --- | --- | --- |
| 1 | Flecha izquierda | Cliente anterior | Lectura |
| 2 | Esfera/lupa | Buscar cliente | Lectura |
| 3 | Flecha derecha | Cliente siguiente | Lectura |
| 4 | Papel | Alta de clientes | Escritura |
| 5 | Papel con marca | Baja de cliente | Escritura |
| 6 | Papel con lapiz | Cambio al cliente actual | Escritura |

## Cliente anterior

OMNIS busca primero por la secuencia anterior y tambien obtiene el codigo
anterior. Para pasar de `000002` a `000001` ejecuto:

```sql
SELECT CLISEQ
FROM fcli
WHERE (CLICOD='000002')
  AND (CLISEQ<15332)
  AND (((CLICURP<>'T')&&(0=0))||(0=1))
  AND ((CLICIA=0)||(0=0)||(CLICIA=0))
  AND (('TUVANSA'='SEFARADI')||(0=0)||(MID(CLIPAR1,2,9)=''))
ORDER BY CLISEQ DESC
LIMIT 1;

SELECT CLICOD
FROM fcli
WHERE (CLICOD<'000002')
  AND (((CLICURP<>'T')&&(0=0))||(0=1))
  AND ((CLICIA=0)||(0=0)||(CLICIA=0))
  AND (('TUVANSA'='SEFARADI')||(0=0)||(MID(CLIPAR1,2,9)=''))
ORDER BY CLICOD DESC
LIMIT 1;
```

Despues carga la ficha completa de `000001` con la misma proyeccion extensa de
`fcli` ya documentada para el detalle del cliente.

## Buscar cliente

Al confirmar el codigo `000001`, OMNIS carga el primer codigo igual o mayor:

```sql
SELECT FCLI.CLISEQ, CLICOD, CLINOM /* mas las columnas de la ficha */
FROM fcli
WHERE (CLICOD>='000001')
ORDER BY CLICOD
LIMIT 1;
```

La ventana tambien permite buscar por nombre. Ese criterio se capturara cuando
se implemente una equivalencia exacta de la ventana; el endpoint GET actual ya
permite buscar por codigo, nombre o RFC mediante `q`.

## Cliente siguiente

Para pasar de `000001` a `000002`, OMNIS invierte los operadores y el orden:

```sql
SELECT CLISEQ
FROM fcli
WHERE (CLICOD='000001')
  AND (CLISEQ>15331)
  AND (((CLICURP<>'T')&&(0=0))||(0=1))
  AND ((CLICIA=0)||(0=0)||(CLICIA=0))
  AND (('TUVANSA'='SEFARADI')||(0=0)||(MID(CLIPAR1,2,9)=''))
ORDER BY CLISEQ
LIMIT 1;

SELECT CLICOD
FROM fcli
WHERE (CLICOD>'000001')
  AND (((CLICURP<>'T')&&(0=0))||(0=1))
  AND ((CLICIA=0)||(0=0)||(CLICIA=0))
  AND (('TUVANSA'='SEFARADI')||(0=0)||(MID(CLIPAR1,2,9)=''))
ORDER BY CLICOD
LIMIT 1;
```

Despues carga la ficha completa de `000002`.

## Alta de clientes

Antes de insertar, valida que el codigo no exista y que la cuenta contable sea
valida:

```sql
SELECT '1' FROM fcli WHERE CLICOD='ZZT826' LIMIT 1;
SELECT * FROM fbenc WHERE BCOD='1105001' LIMIT 1;
```

Con codigo y razon social como unicos datos escritos manualmente, OMNIS genero:

```sql
INSERT INTO fcli
  (CLICOD, CLINOM, CLISTA, CLIALTA, CLIMONEDA, CLICTA, CLIFECHACAMBIO)
VALUES
  ('ZZT826', 'captura sql cliente prueba', 1, '2026-08-26', 1,
   '1105001', '2026-08-26');

SELECT CLISEQ FROM fcli WHERE CLISEQ IS NULL;
```

El conjunto de columnas del `INSERT` es dinamico: al llenar mas controles,
OMNIS agrega sus columnas correspondientes. Los valores que no se capturan se
resuelven con defaults de la tabla o del formulario.

## Cambio al cliente actual

El formulario valida nuevamente la cuenta contable. Al cambiar solamente la
razon social, OMNIS actualizo exclusivamente esa columna:

```sql
SELECT * FROM fbenc WHERE BCOD='1105001' LIMIT 1;

UPDATE fcli
SET CLINOM='captura sql cliente editado'
WHERE CLISEQ=24177;

SELECT * FROM fcli WHERE CLISEQ=24177 LIMIT 1;
```

El `UPDATE` tambien es dinamico: debe construirse con una lista blanca de los
campos modificables, nunca concatenando nombres o valores recibidos del cliente
HTTP.

## Baja de cliente

Antes de preguntar si se desea borrar, OMNIS busca relaciones por `CLISEQ` en
las tablas `fdoc`, `fax`, `faxinv`, `fpenc`, `fplin`, `fvanu2` y `fcenso`, y
consulta claves relacionadas en `fyg`.

La biblioteca intento proyectar `fplin.PLUMXXXX`, columna ausente en esta copia
de la base, recibio el error MySQL 1054, hizo `ROLLBACK` y repitio la validacion
de `fplin` con una proyeccion compatible. El dialogo de confirmacion aparecio y
la baja pudo completarse.

Al confirmar la eliminacion del cliente temporal ejecuto:

```sql
DELETE FROM fcli WHERE CLISEQ=24177;
COMMIT;
```

Despues consulto configuracion `HUE_DIG_0ZZT826`, busco contactos asociados y
trato de posicionarse en el siguiente codigo disponible.

## Marcadores de la captura cruda

El archivo local ignorado por Git
`captures/accounts-receivable-writes-2026-08-25.log` conserva todas las
proyecciones literales y el orden real de ejecucion. Los marcadores relevantes
son:

- `TOOLBAR_PREVIOUS_CLIENT`
- `TOOLBAR_NEXT_CLIENT`
- `TOOLBAR_SEARCH_CLIENT_000001`
- `TOOLBAR_NEW_CLIENT_INSERT_ZZT826`
- `TOOLBAR_EDIT_CLIENT_UPDATE_ZZT826`
- `TOOLBAR_DELETE_CLIENT_OPEN_ZZT826`
- `TOOLBAR_DELETE_CLIENT_CONFIRM_ZZT826`

## Escrituras web

| Control | Endpoint | Fuente |
| --- | --- | --- |
| Alta | `POST /api/accounts-receivable/clients` | Derivada de `MCLI/21` y `/27`. `FCIA`, `FBENC`, `FCLI` y `tuvansa.client_catalog` |
| Cambio | `PATCH /api/accounts-receivable/clients/:clientId` | Derivada de `MCLI/23` y `/27`. `FCLI`, `FBENC`, `FCIA` y `tuvansa.client_catalog` |
| Baja | `DELETE /api/accounts-receivable/clients/:clientId` | Derivada de `MCLI/22`. Siete relaciones nativas, licencias de `FYG` y relaciones web |
| Bloquear / Desbloquear | `PATCH /api/accounts-receivable/clients/:clientId/actions/block-status` | Derivada de `ECLI#1/43`, `/354` y `CLIENT_000001_ACTION_BLOQUEAR_CONFIRM`. `tuvansa.client_catalog`, `tuvansa.client_block_events` |

Los cambios se guardan en PostgreSQL y se leen sobre el registro original.
La ficha conserva los acumulados de la fuente y refleja los documentos web.
El alta hereda la cuenta `FCIA.CIACTACXC` y la configuración contable.
El cambio valida la cuenta vigente cuando aplica y guarda únicamente los
campos recibidos. La API normaliza la lista fuera del rango 1–13 a 1 al editar.

La baja se confirma en la ficha y conserva una marca local que excluye al
cliente del catálogo. Las siete relaciones nativas, licencias y documentos
web se vuelven a comprobar antes de grabar. Si existe una relación, se
devuelve `409 CLIENT_IN_USE`. Los códigos con dependencias, sucursales
o un evento de bloqueo quedan protegidos frente a su cambio mientras las
referencias correspondientes se consulten de su origen.
