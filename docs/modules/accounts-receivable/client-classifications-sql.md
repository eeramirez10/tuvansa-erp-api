# Captura MySQL de OMNIS: Clasificar cliente

Captura realizada el 26 de agosto de 2026 sobre el MySQL 5.1 local de pruebas,
desde la ventana **Seleccion de parametros** del Catalogo de clientes.

## Correspondencia visual

| Posicion | Boton OMNIS | `fag.AGT` |
| ---: | --- | --- |
| 1 | AGENTE | `1` |
| 2 | GIRO O SECTOR | `2` |
| 3 | SUCURSAL | `3` |
| 4 | STATUS | `4` |
| 5 | CONDUCTO | `5` |
| 6 | MOTIVO | `6` |
| 7 | FLETE | `7` |
| 8 | ORIGEN | `8` |
| 9 | PROYECTO | `9` |

## SQL emitido al cambiar de familia

OMNIS repite el siguiente grupo al hacer clic en cualquiera de los nueve
botones. El ejemplo corresponde a GIRO O SECTOR (`AGT='2'`):

```sql
SELECT AGSEQ
FROM fag
WHERE (AGT='2')&&((AGTIPO=0)||(AGTIPO=1))
ORDER BY AGT,FAG.AGSEQ;
```

Despues recupera las filas completas usando los `AGSEQ` resultantes y llena la
tabla visible con esta consulta:

```sql
SELECT AGTNUM,AGDESCR,AGNUM,AGT
FROM FAG
WHERE (AGT='2')
  AND ((AGT='2')&&((AGTIPO=0)||(AGTIPO=1)))
ORDER BY AGT,FAG.AGSEQ
LIMIT 32767;
```

La API conserva los mismos filtros y orden, pero evita la lectura intermedia y
consulta directamente las columnas requeridas:

```sql
SELECT
  AGSEQ AS id,
  AGTNUM AS code,
  AGDESCR AS description,
  AGNUM AS number,
  AGT AS type
FROM fag
WHERE AGT = ?
  AND AGTIPO IN (0, 1)
ORDER BY AGT, AGSEQ;
```

El parametro `?` es la posicion seleccionada, del 1 al 9. La captura cruda se
mantiene fuera de Git en `captures/client-classify-general.log`.
