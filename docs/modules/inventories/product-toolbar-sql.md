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

## Cambio

Al escribir solamente la descripción:

```sql
SELECT * FROM fens WHERE EPRO='ZZAPI826ICAPT' LIMIT 1;

UPDATE finv
SET IDESCR='captura sql producto editado', finv.USEQ=1
WHERE ISEQ=63349;
```

La API construye el `UPDATE` con lista blanca y parámetros enlazados.

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
