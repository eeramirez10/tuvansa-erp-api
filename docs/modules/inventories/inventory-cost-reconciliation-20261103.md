# Conciliación de AICOSTO × AICANT (2026-11-03)

Revisión solicitada por el usuario ante diferencias con sus reportes. Se conserva
la referencia anterior: TCC/B007, México y sus resguardos 01/11/12/13/15, corte
31/08/2026. Es una auditoría de lectura sobre `tuvansa`, MySQL 8.0.21. No es una
nueva captura de OMNIS ni una corrección de datos. No se activó general_log.

| Vista | Etiqueta | Marcador | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Reportes / Inventario por familia | Vista previa / Costo histórico de movimientos | Sin captura nueva; auditoría 2026-11-03 | Derivada | GET /api/inventories/reports/by-family | FAXINV, FINV, FDOC, FUNIDAD |
| Misma vista | Descargar Excel | Sin SQL adicional | Presentación de la respuesta | Mismo GET | Sin origen adicional |

## Resultado verificable

La implementación vigente ya multiplica **AICANT × AICOSTO** por movimiento. No
usa ILISTA4 ni AIPRECIO para el modo histórico y no incorpora AIREVAL a ese neto.
Se comprobó el backend activo en puerto 3000 y el frontend activo en 5173, sin
proxy de pruebas: el modo seleccionado fue Costo histórico de movimientos.

| Lectura | Resultado |
| --- | ---: |
| Suma SQL exacta, movimientos fechados | 34,420,029.46029702 |
| API activa, centavos por producto/almacén | 34,420,029.46 |
| Vista previa y Excel descargado del frontend | 34,420,029.46 |
| Neto SQL exacto sin documento/fecha | −171,083.44115600 |
| Neto SQL exacto incluyendo pendientes | 34,248,946.01914102 |

Se descargaron **13,498 filas** del alcance, sin excluir las de cantidad y
revaluación cero. **11,823** tienen efecto físico o revaluación; **1,675** no
aportan cantidad ni importe ni revaluación. La agregación de los **325** productos/
almacenes coincide, partida por partida, con la API mediante aritmética Decimal.
El redondeo por partida explica un centavo entre el neto sin fecha agregado de la
API (−171,083.45) y redondear una sola vez el SQL global (−171,083.44).

## Cinco costos negativos explican un aporte positivo de 23.1 millones

Los siguientes valores existen literalmente en FAXINV. Cantidad negativa por
costo negativo genera un importe positivo. No se cambió su signo, no se aplicó
ABS y no se descartaron para aproximar el importe esperado por el usuario.

| AISEQ | Producto | Fecha | Documento | AICANT | AICOSTO | Producto exacto |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 6529 | 01300305 | 2018-02-16 | EI0077 | −1920.000 | −1598.84790 | +3,069,787.96800000 |
| 7180 | 01300305 | 2018-02-26 | EI0093 | −960.000 | −5760.79490 | +5,530,363.10400000 |
| 5114 | 01300329 | 2018-01-26 | EI0017 | −51.200 | −59.00500 | +3,021.05600000 |
| 5858 | 01300335 | 2018-02-08 | EI0051 | −2131.200 | −3393.88320 | +7,233,043.87584000 |
| 6496 | 01300335 | 2018-02-16 | EI0075 | −1216.000 | −5973.80900 | +7,264,151.74400000 |

Su aporte combinado es **+23,100,367.74784000**. Esto demuestra una causa concreta
del valor elevado bajo la fórmula literal; no demuestra por sí solo que los datos
sean erróneos. Falta contrastar el tratamiento de esos movimientos con el reporte
de referencia. Excluirlos o volver positivo el costo sería una regla distinta,
sin confirmación, y no se implementó.

Otra señal: el producto 01300335/almacén 01 termina en cantidad cero, pero conserva
un neto literal de **+14,075,083.55223200**. El producto 01300305/01 también termina
en cero y conserva **+8,443,331.89300000**. En conjunto, los productos/almacenes de
cantidad cero aportan **14,050,677.21** después de redondear por partida, porque
otros tienen netos negativos. No se anulan esos importes automáticamente ni se
confunde este neto de movimientos con un inventario contable conciliado.

Se conservan las otras incidencias: 62 movimientos con costo cero y nueve sin
documento/fecha. El importe de referencia aproximado 12,281,029.00 continúa sin
conciliar. No se alteraron AICOSTO, AICANT ni documentos del servidor productivo.

## Filtros y relaciones revisados

- Todos los movimientos identificados de TCC tienen AIMES=1. No hay otra serie
  de meses excluida por ese filtro en esta lectura.
- Los documentos encontrados tienen DEST=0; los faltantes son los nueve ya
  identificados. No se encontró otra categoría de estado excluida para TCC.
- Se conservan entradas y salidas, devoluciones, traslados y costos negativos.
- FDOC.DSEQ y FINV.ISEQ son llaves primarias. El catálogo de familia se agrupa
  antes del join; la comparación individual no mostró duplicación de importes.
- No se encontraron movimientos físicos del alcance con ISEQ ausente de FINV.
- En esta base IFAMB existe en FINV; FAXINV tiene AIFAM1/AIFAM2, ambos vacíos
  para los movimientos revisados. No hay una familia histórica distinta que
  permita asignar otras filas a TCC sin inferirla.
- El corte es inclusivo y no hay fecha inicial que recorte 2018–2026. Las filas
  posteriores al corte se cuantificaron aparte, no se introdujeron en el neto.
- Los almacenes 00/97/99 no se adjudican a México sin propietario confirmado.
  Para TCC, tránsito 99 tiene saldo físico cero y neto −8.01382000 al corte: no
  explica la diferencia de millones.

## SQL reproducible (derivado)

Valores enlazados: `['B007','01','11','12','13','15','2026-09-01']`.

```sql
SELECT a.AISEQ,a.DSEQ,a.ISEQ,i.ICOD,i.IDESCR,u.UCOD,
       a.AIALMACEN,a.AITIPMV,a.AIMES,
       CAST(a.AICANT AS CHAR) AICANT,
       CAST(a.AICOSTO AS CHAR) AICOSTO,
       CAST(a.AICANT*a.AICOSTO AS CHAR) importe,
       CAST(a.AIREVAL AS CHAR) AIREVAL,
       d.DFECHA,d.DNUM,d.DEST,d.DMULTICIA
FROM faxinv a
JOIN finv i ON i.ISEQ=a.ISEQ
LEFT JOIN fdoc d ON d.DSEQ=a.DSEQ
LEFT JOIN funidad u ON u.USEQ=i.USEQ
WHERE i.IFAMB=?
  AND a.AIALMACEN IN (?,?,?,?,?)
  AND (d.DFECHA<? OR d.DFECHA IS NULL)
ORDER BY i.ICOD,a.AIALMACEN,d.DFECHA,a.AISEQ;
```

La extracción es deliberadamente más amplia que el reporte para clasificar cada
fila por fecha, AIMES y estado, incluidas las de efecto cero. El neto fechado
usa las filas AIMES=1, DEST=0 y fecha válida hasta el corte. Los documentos
ausentes se mantienen como pendientes, sin inventar fecha.

## Evidencia local, fuera de Git

Directorio `captures/sql/new-version/inventories/scope-audit-20261103/`:

- `all-movements.json`, `enriched-movements.json` y CSV: todas las filas y valores
  originales; sumas exactas de ocho decimales, sin convertir a otro costo.
- `reconciliation.json`, `negative-costs.json`: conciliación y cinco incidencias.
- `runtime-127-0-0-1.json`, `browser-response.json`: API realmente utilizada.
- `frontend-actual.png`, `reporte-frontend-tcc-20260831.xlsx`: vista y descarga reales.
- `conciliacion-tcc-mexico-20260831.xlsx`: hojas Conciliación, Movimientos, Costos
  negativos, Por producto, Sin documento, Por año y Consulta SQL. Fórmulas visibles
  AICANT × AICOSTO, valores SQL literales como texto para preservar precisión.
- `general-log.json`: OFF. No hubo activación, reinicio ni escritura a MySQL.

Para resolver la diferencia con el reporte del usuario hace falta comparar cómo
presenta 01300335 y cómo trata EI0051/EI0075 (y los tres restantes). La igualdad
SQL/API/Excel ya está comprobada; falta esa correspondencia funcional con el
reporte de referencia, no otra sustitución de costo o un ajuste de cifras.

Validación: lint/build/test aprobados (174 pruebas). Excel nativo recalculó las
fórmulas de los 13,498 movimientos, con diferencia API/Excel cero y sin errores.
El archivo se abrió de sólo lectura y su SHA-256 no cambió. MySQL80 Running y
general_log OFF al terminar. Los cambios versionados de esta revisión son sólo
documentación; no se cambió el cálculo ni se escribieron datos productivos.
