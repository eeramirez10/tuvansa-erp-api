# Captura MySQL real de Pedidos

## Método

Se habilitó temporalmente el general log del MySQL local usado por OMNIS, se
marcó cada interacción y se filtró por la sesión de OMNIS. Al finalizar se
restauró byte por byte el `my.ini` original, se reinició el servicio y se
comprobó `general_log = OFF`.

La UI se contrastó con `P010773` en la compañía 1. La base que usa esa biblioteca
de pruebas es `tuvansa`; la API de desarrollo puede apuntar a otra base mediante
`.env`, por lo que los valores actuales pueden diferir sin cambiar el contrato.

## Lecturas confirmadas

La ficha carga `FPENC` unido a `FCLI`, y después las partidas `FPLIN` unidas a
`FINV`. Dos consultas literales especialmente relevantes fueron:

```sql
-- Botón visible: Auxiliar; ventana: Facturas de pedido
SELECT DNUM, DFECHA
FROM FDOC
WHERE DREFER = 'P010773' AND DEST = 0 AND DMULTICIA = 1
ORDER BY DREFER, FDOC.DSEQ;

-- Botón visible: Piezas
SELECT ICOD, IDESCR, CAJCANT, CAJPZAS, CAJSERIE, FCAJAS.CAJSEQ,
       CAJINV, CAJPEDIDO, CAJALM, CAJREFER, CAJFECHA,
       CAJRECEPCION, CAJFACTURA, CAJMTS
FROM FCAJAS
LEFT JOIN FINV ON FCAJAS.ISEQ = FINV.ISEQ
WHERE CAJPEDIDO = 'P010773'
ORDER BY CAJPEDIDO, FCAJAS.CAJSEQ;
```

**Cajas** consulta `FYG.YGKEY = 'EMP_LTD_P_' + PENUM`. **Monarch** sólo toma
partidas con `PLASIGNADO > 0`. **Clasificar** lee `PEPAR1..PEPAR7` y obtiene las
opciones de `FAG` por `AGT`.

## Alta real observada

La acción **Duplicar** generó el pedido desechable `P019406` y permitió capturar
la secuencia real de escritura:

```sql
INSERT INTO FPENC (...)
VALUES (..., 'P019406', ..., 423.46, '2026-08-26', ..., 365.05,
        '000033', '1212', ..., 16, 58.41, 'SURT', ..., '202', '302', ...);

UPDATE FTIPMV SET TINUM = TINUM + 1 WHERE TISEQ = 2;
UPDATE FCLI SET CLIULTPED = '2026-08-26' WHERE CLISEQ = 15363;

INSERT INTO FPLIN
  (CLISEQ, ISEQ, PESEQ, PLTIPMV, PLCANT, PLPRECI, PLFACTOR, PLUNIDAD, PLFECHA)
VALUES
  (15363, 10590, 179806, 'P', 3, 52.15, 1, 'PZ', '1900-12-31'),
  (15363, 10594, 179806, 'P', 4, 52.15, 1, 'PZ', '1900-12-31');

UPDATE FINV SET IPEDCLI = IPEDCLI + 3 WHERE ISEQ = 10590;
UPDATE FINV SET IPEDCLI = IPEDCLI + 4 WHERE ISEQ = 10594;
UPDATE FPENC
SET PEPZAS = 7, PEBRUTO = 365.05, PEDESC = 0, PEIVA = 58.41, PECANT = 423.46
WHERE PESEQ = 179806;

INSERT INTO FCOMENT (COMSEQFACT) VALUES (10179806);
UPDATE FCOMENT
SET COMLETRA = 'CUATROCIENTOS VEINTITRES 46/100'
WHERE COMSEQ = 356819;
```

La autorización A emitió:

```sql
UPDATE FPENC SET PEPAR9 = '9A' WHERE PESEQ = 179806;
UPDATE FCOMENT
SET COMCAMBIOS = 'AUTORIZACION +A   Usr:   0   26/08/2026 20:57:25\r'
WHERE COMSEQ = 356819;
```

## Edición y baja

El icono hoja/lápiz fue confirmado como **Editar**: OMNIS impide modificar un
pedido ya autorizado. El icono anterior fue confirmado como **Borrar** y mostró
`Está seguro de querer dar de baja el pedido P019406?`.

La biblioteca de pruebas ejecutó primero:

```sql
DELETE FROM FPENC WHERE PESEQ = 179806;
```

Después falló al leer una columna obsoleta de `FPLIN` (`SQL-1054`) y emitió
`ROLLBACK`. Las tablas de este esquema no revirtieron la baja del encabezado, por
lo que quedaron temporalmente partidas y comentarios huérfanos. La limpieza se
hizo de forma acotada al identificador capturado:

- se eliminaron `FPLIN.PESEQ=179806` y `FCOMENT.COMSEQFACT=10179806`;
- se confirmó que no existiera `FPENC.PESEQ=179806` ni `PENUM='P019406'`;
- `FINV.IPEDCLI` de `ISEQ 10590/10594` volvió de `3/4` a `0/0`;
- `FCLI.CLIULTPED` volvió de `2026-08-26` a `2022-11-07`;
- `FTIPMV.TINUM` volvió de `19406` a `19405`.

La verificación final arrojó cero encabezados, cero partidas y cero comentarios
del pedido desechable. No se modificó `P010773`.

## Adaptación de la API

El SQL de la API usa parámetros y nombres explícitos, pero conserva las reglas
observadas: encabezado antes que partidas, actualización de `IPEDCLI`, registro
en `FCOMENT`, actualización de `CLIULTPED`, recálculo de importes y protección
contra baja si existen `FDOC` o cantidades surtidas. La API no replica el error
de columna obsoleta de OMNIS.
