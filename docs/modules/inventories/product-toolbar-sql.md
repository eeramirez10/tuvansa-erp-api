# Barra de herramientas del Catalogo de productos

Captura realizada en la copia local MySQL 5.1 de pruebas el 26 de agosto de
2026. F2 abrio Inventarios PT y la clase OMNIS identificada fue `EINV#1`.

Se creo el producto temporal `ZZAPI826ICAPT` (`ISEQ = 63349`), se cambio su
descripcion y se elimino durante la misma captura. El codigo termino con ese
valor porque OMNIS mantuvo el foco en Código al enviar el texto de prueba; esto
no afecta la identificacion de los SQL.

## Correspondencia visual

| Orden | Icono | Accion confirmada | Endpoint |
| ---: | --- | --- | --- |
| 1 | Flecha izquierda | Producto anterior | `GET /api/inventories/products/:productId/previous` |
| 2 | Esfera/lupa | Buscar producto | `GET /api/inventories/products?q=...` |
| 3 | Flecha derecha | Producto siguiente | `GET /api/inventories/products/:productId/next` |
| 4 | Papel | Alta de productos | `POST /api/inventories/products` |
| 5 | Papel con marca | Baja de producto | `DELETE /api/inventories/products/:productId` |
| 6 | Papel con lapiz | Cambio de producto | `PATCH /api/inventories/products/:productId` |

## Navegacion y busqueda

OMNIS navega por `ICOD`; cuando existen codigos repetidos intenta primero la
secuencia anterior o siguiente:

```sql
SELECT ISEQ
FROM finv LEFT JOIN funidad ON finv.USEQ=funidad.USEQ
WHERE ICOD='004212899' AND ISEQ<47087
ORDER BY ISEQ DESC
LIMIT 1;

SELECT ICOD
FROM finv LEFT JOIN funidad ON finv.USEQ=funidad.USEQ
WHERE ICOD<'004212899'
ORDER BY ICOD DESC
LIMIT 1;
```

Para siguiente invierte los operadores y usa orden ascendente. La ventana
“Encuentra producto” muestra Código y Descripción. Al buscar el código capturado
consultó primero `IEAN` y después posicionó el primer código igual o mayor:

```sql
SELECT /* ficha extensa */
FROM finv LEFT JOIN funidad ON finv.USEQ=funidad.USEQ
WHERE IEAN='004212899'
LIMIT 1;

SELECT /* ficha extensa */
FROM finv LEFT JOIN funidad ON finv.USEQ=funidad.USEQ
WHERE ICOD>='004212899'
ORDER BY ICOD
LIMIT 1;
```

La API generaliza `q` sobre `ICOD`, `IDESCR`, `IEAN` e `IUPC`.

## Alta

OMNIS comprobo que el código no existiera y, con los defaults visibles, generó:

```sql
SELECT '1' FROM finv WHERE ICOD='ZZAPI826ICAPT' LIMIT 1;

INSERT INTO finv
  (USEQ,ICOD,ILOTE,ICANTCAJA,IBODEGA,IFAM1,IUM,IFECHACAMBIO,IALTA,
   IUM2,IUM2FACTOR,IRENGLON,IEDIEMP,IPRV,IFECHACAMBIOPR)
VALUES
  (1,'ZZAPI826ICAPT',1,1,1,'1ZZA','PZ','2026-08-26','2026-08-26',
   'PZ',1,'A','BX','ZZA','2026-08-26');
```

El `INSERT` de OMNIS es dinámico. La API agrega únicamente campos de la ficha
recibidos, más los defaults técnicos confirmados; no reproduce valores ocultos
derivados del código como `IFAM1` o `IPRV`.

### Captura en la ficha de Omnis 7

`MCONTROL/5` llama a `MINV/24`. El papel activa **Alta de productos** en
`EINV#1`, con foco en **Código**, tipo **M.P.**, unidad **1 UNO** y monedas
en cero en la biblioteca de pruebas. **OK** y **Cancelar** están en la
misma ficha. Se comprobó en un borrador que **Color y talla**, **Vta 6s**
y **Días Inv.** admiten captura. El borrador se descartó con **Cancelar**.

El alta web carga el catálogo de unidades con
`GET /api/inventories/products/:productId/edit-options` desde el registro
visible. El POST existente admite `classification.usesColorAndSize`,
`accumulated.salesLastSixWeeks` y `accumulated.inventoryDays`, que el
datasource MySQL mapea a `ICT`, `IVTA` e `IDIASSTK`.
La API principal rechaza el POST de alta con `MODULE_WRITES_NOT_MIGRATED`
hasta que la creación se implemente en PostgreSQL.

## Cambio

Al escribir solamente la descripción:

```sql
SELECT * FROM fens WHERE EPRO='ZZAPI826ICAPT' LIMIT 1;

UPDATE finv
SET IDESCR='captura sql producto editado', finv.USEQ=1
WHERE ISEQ=63349;
```

### Comportamiento comprobado en Omnis 7

El papel con lápiz ejecuta `MCONTROL/7` → `MINV/26`. Omnis abre de nuevo
`EINV#1` con el título **Cambio de producto** y habilita **OK** y **Cancelar**
en la misma ficha. Las acciones laterales quedan ocultas durante la edición.
En `Z26` se comprobó que **Vta 6s** y **Días Inv.** aceptan captura. La
prueba terminó con **Cancelar**. `MINV/26` sólo llama al guardado cuando
la captura se confirma con **OK**.

`MBASE/144` toma los valores iniciales de `FINV`. Después de **OK**,
`MINV/26` guarda la unidad mediante el `UCOD` y su `USEQ`, prepara los
campos modificados con `MBASE/148` y actualiza el producto. Revisa si el
producto tiene componentes en `FENS` y asigna **Juego** cuando lo exige
la configuración. El procedimiento registra la fecha y el operador.
La fecha de la edición web se toma de PostgreSQL. El operador de Omnis
se conserva hasta que la sesión web pueda identificarse con él.

El cambio de código de Omnis también modifica las referencias de ensamble
y las claves de almacén y llama a `MINV/125` para los efectos en lotes,
producción en proceso y descuentos. En el piloto PostgreSQL **Código**
es de sólo lectura mientras esas relaciones se consulten desde MySQL.

El `UPDATE` mostrado arriba fue capturado en MySQL de la copia local.
`PATCH /api/inventories/products/:productId` guarda la edición del piloto
en PostgreSQL. Los cambios de familia y los campos compartidos con
**Otros** se reflejan al abrir esos paneles. El guardado verifica la
revisión de la ficha para detectar ediciones simultáneas.

El GET de la ficha devuelve `editing.revision` y `editableFields` para
los productos habilitados. `GET /api/inventories/products/:productId/edit-options`
entrega las unidades. El PATCH recibe la revisión y los campos modificados
del catálogo. Una revisión desactualizada devuelve `409`.

La edición se habilita por producto en PostgreSQL de pruebas con
`INVENTORY_PRODUCT_EDIT_PILOT_PRODUCTS` después de aplicar la migración.

```powershell
pnpm exec tsx scripts/migrate-postgres-inventory-product-edit.ts
```

## Baja

OMNIS comprobó relaciones en `fens`, `faxinv`, `fplin`, `fvanu2` y `fcanu2`.
La primera validación de `fplin` volvió a referirse a la columna inexistente
`PLUMXXXX`; tras el error MySQL 1054 repitió la consulta con una proyección
compatible y mostró “¿Lo doy de baja?”. La API consulta sólo existencia y no
arrastra ese defecto.

Al confirmar ejecutó, en este orden:

```sql
DELETE FROM falm
USING falm LEFT JOIN finv ON falm.ISEQ=finv.ISEQ
WHERE FINV.ISEQ='63349';

DELETE FROM finv WHERE ISEQ=63349;
```

La API ejecuta ambas bajas en una sola transacción y responde
`409 PRODUCT_IN_USE` si encuentra una relación bloqueante.

La captura cruda ignorada por Git está en
`captures/inventory-pt-2026-08-26.log`.
