# Captura MySQL real de Facturación

## Método y seguridad

Se habilitó temporalmente el general log del MySQL 5.1 local usado por OMNIS y
se filtró la conexión de OMNIS (`thread id 5`). La captura se hizo con una acción
de UI a la vez. Al terminar:

- el log crudo se copió a `captures/invoicing-2026-08-28.log`;
- `my.ini` se restauró byte por byte desde su respaldo SHA-256;
- se reinició el servicio MySQL;
- se verificó `general_log = 0`.

La biblioteca fue `proscai_German - pruebas.LBR`, compañía 1, con el documento
`0007069`. Los valores pueden variar frente a la base actual de desarrollo, pero
las tablas, relaciones y reglas de elegibilidad son las mismas.

## Navegación y ficha

Al pulsar la flecha derecha desde la pantalla vacía, OMNIS obtuvo el primer
documento elegible y después cargó encabezado y partidas. La selección observada
fue:

```sql
SELECT DNUM
FROM FDOC
LEFT JOIN FCLI ON FDOC.CLISEQ = FCLI.CLISEQ
LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ
WHERE DNUM > ''
  AND (DESFACT = 1 OR DESCXC = 1)
  AND DEST = 0
  AND DMULTICIA = 1
ORDER BY DNUM
LIMIT 1;
```

El encabezado real selecciona los campos de `FDOC` y los datos completos de
`FCLI`/`FPRV` por `FDOC.DSEQ`. La API reduce esa consulta a los campos que
consume la pantalla y conserva la clave `DSEQ` parametrizada.

La consulta literal de partidas fue:

```sql
SELECT ICOD, IDESCR, AICANT, AICANTF, AIDESCTO, AIPRECIO, AIPREBR,
       FAXINV.ISEQ, AISUCURSAL, IEMPAQUE, AISKU, AIPZAS, 0,
       AIAGENTE, AIPAGINA, FAXINV.AISEQ, AIFACTOR, AIUNIDAD,
       AICOSTO, IFAM6
FROM FAXINV
LEFT JOIN FDOC ON FAXINV.DSEQ = FDOC.DSEQ
LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
WHERE FDOC.DSEQ = 244045
ORDER BY FDOC.DSEQ, FAXINV.AISEQ
LIMIT 32767;
```

## Botones confirmados

**Comentarios** emitió:

```sql
SELECT FCOMENT.COMSEQ, COMSEQFACT, COML1, COML2, COML3, COML4,
       COMLETRA, COMCAJA, COML5, COMDNUM, COMDES,
       COMCAJA2, COMCAJA3, COMCAJA4, COMCAMBIOS
FROM FCOMENT
WHERE COMSEQFACT = 244045
ORDER BY FCOMENT.COMSEQ
LIMIT 1;
```

**Piezas** emitió:

```sql
SELECT ICOD, IDESCR, CAJCANT, CAJPZAS, CAJSERIE, FCAJAS.CAJSEQ,
       CAJINV, CAJPEDIDO, CAJALM, CAJREFER, CAJFECHA,
       CAJRECEPCION, CAJFACTURA, CAJPEDIMENTO,
       CAJFECHAIMPORT, CAJADUANA, '', CAJMTS
FROM FCAJAS
LEFT JOIN FINV ON FCAJAS.ISEQ = FINV.ISEQ
WHERE CAJFACTURA = '0007069'
ORDER BY CAJFACTURA, FCAJAS.CAJSEQ
LIMIT 32767;
```

**Auxiliar** mostró los movimientos `FA / P015471` y `K / 0007069` sin emitir
otra consulta porque la relación ya estaba en memoria. Se validó la fuente
subyacente en `FAX.DSEQ=244045`: `ACANT=197.66` y `ACANT=-197.66`. La API lo
expone como cargos y abonos parametrizados.

**CT** y **Lotes** reutilizaron las partidas ya cargadas. La API consulta
`FAXINV` y, para lotes, une `FLOTES` mediante `FAXINV.LOSEQ`. **Cajas/Empaque**
abrió sin registros para este documento. **Clasifica** no emitió una consulta
adicional; la API lee `FDOC.DPAR0..DPAR9` y su catálogo `FAG`.

Los botones **Sellar**, **Tiket > Factura**, **Traspaso**, **Edita pzas** y
**Liquidación camión** pueden modificar datos. No se confirmó ninguna de esas
operaciones: sus endpoints sólo devuelven estado o contexto y marcan la acción
como deshabilitada cuando corresponde.
