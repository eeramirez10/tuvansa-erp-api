# Inicio y selección de multicía

## Flujo de Omnis 7

En `PROSCAI_GERMAN - PRUEBAS`, un clic en la portada abre **Usuario**.
**Cancelar** muestra **Seleccion de multicia**. Un doble clic en **MEXICO**
abre TUVANSA con UBI 0. La lista visible contiene MEXICO, MONTERREY, VERACRUZ,
MEXICALI, QUERETARO y CANCUN, en ese orden.

| Vista o botón | Procedimiento y evidencia | Contrato web |
| --- | --- | --- |
| PROSCAI / Usuario | `STARTUP/0` llama a `STARTUP/311` y prepara los valores de `FCIA`. Usuario y el resultado de Cancelar se observaron en ejecución. Capturas locales `multicia-07`, `multicia-09`, `multicia-61-startup`, `multicia-62-startup`. | `/inicio`, campos deshabilitados y Cancelar activo |
| Selección de multicía | `ECIAS#1/0 → /240` forma la lista con `FALMCAT.CATCOD`, `CATDESCR` y `CATCOMENTARIO`, carga `CATTIPO='CIA'` y ordena por `CATCOD`. El alias visible viene de `CATCOMENTARIO`. Capturas `multicia-52` y `multicia-55-load`. | `GET /api/companies` |
| Doble clic en México | `ECIAS#1/99` toma `CATCOD` como `LVMULTICFD`. `MMULTICIAS/21` carga la ficha de compañía por `CATKEY`, asigna `LVCIA` según el comportamiento activo y copia cliente, almacén, lista de costo y tipos de movimiento. Capturas `multicia-45-find` y `multicia-58-confirm`. | `GET /api/companies/1/context` |

La ficha `CIA1` de `FALMCAT` en los respaldos MySQL consultados tiene
`CATMCIAALM='01'`, `CATMCIACLI=''`, `CATMCIALCOSTO=5` y los tipos de
movimiento `RA`, `NA` y `P` en `CATMCIATMR`, `CATMCIATMDR` y
`CATMCIATMP`. El almacén del contexto web sale de `CATMCIAALM`. La
verificación de esos campos fue una lectura derivada del procedimiento,
independiente de las consultas de reportes.

## API

El catálogo es una proyección de las seis filas del selector de la biblioteca
de pruebas. La API entrega la descripción completa de `CATDESCR`. Ambos
endpoints usan datos de referencia fijados para esta fase y no consultan bases
en tiempo de ejecución. La presencia de otras compañías en respaldos distintos
no afecta el selector aprobado.

- `GET /api/companies` responde `{data: [{id, alias, description, enabled}]}`.
- `GET /api/companies/:id/context` responde para México con
  `{data: {company, databaseAlias, warehouseCode, locationId}}`, con
  `databaseAlias='TUVANSA'`, `warehouseCode='01'` y `locationId=0`.
- Compañía conocida deshabilitada devuelve `403 COMPANY_DISABLED`. ID
  desconocido devuelve `404 COMPANY_NOT_FOUND`. Un ID mal formado devuelve
  `400 VALIDATION_ERROR`.
- El contexto es de navegación. Los endpoints existentes conservan sus
  contratos y la autenticación se incorporará en otra fase.

Los ejemplos de petición están en `http/companies.http`.
