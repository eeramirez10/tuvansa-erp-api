# Alta desde cero P / X: intento del 2026-11-11

Objetivo: contrastar el alta P y el alta X en la misma pantalla de Pedidos,
incluidos tipo, folio, partidas, comentarios y efectos de escritura. El usuario
confirmó en esta sesión que OMNIS usa una copia aislada de pruebas. Se eligieron
cliente 000001, producto 01300938 y almacén 01; no se modificó código de aplicación.

## Estado y evidencia

MySQL local 8.0.21, base `tuvansa`. Se respaldaron my.ini/proscai_my.ini y sus
SHA-256. La cuenta de .env.capture.local no tiene PROCESS ni control de variables
globales; se utilizó el mecanismo temporal de configuración y dos reinicios de
MySQL80 autorizado previamente. No se otorgaron permisos ni se crearon usuarios.
Un watchdog limitado a veinte minutos garantizaba restauración aun sin cierre
manual. La restauración se solicitó antes de su vencimiento.

El primer reinicio invalidó la sesión original. Tras reconectar manualmente,
OMNIS mostró SES 12 (PID 16424). **thread_id=12** se confirmó por las lecturas
funcionales de FCIA, FALMCAT y FTIPMV durante la navegación marcada, no sólo
por la etiqueta SES. Se excluyó de la extracción el intervalo de autenticación.

Nuevo es el icono hoja en la posición relativa (897,155) de esta geometría de
ventana. Los intentos sobre el icono contiguo no abrieron una captura; no se
clasifican como altas ni se reutilizan sus coordenadas sin nueva inspección.
La selección 01 abrió Captura de pedido con P — PEDIDO MEX. Al intentar cargar
el cliente, la aplicación mostró:

> El T.M. no está permitido para el usuario.

Se detuvo el ejercicio. El folio **P021069** sólo apareció como orientativo;
**no se observó INSERT, UPDATE ni DELETE ejecutado** en el intervalo del intento
de la conexión 12. No se guardó un documento P ni se probó el alta X. No se
infiere que X esté bloqueado por el mismo motivo: sigue pendiente de comprobar.
Después se detectó otra sesión de OMNIS (SES 18, PID 11136); se suspendieron los
clics en vez de reutilizar el handle de la sesión anterior.

| Vista | Control / acción | Marcador | Procedencia | Endpoint relacionado | Tablas / resultado |
| --- | --- | --- | --- | --- | --- |
| Menú | Pedidos | OPEN_PEDIDOS_LABEL | Capturada, lectura | Catálogos del alta | FCIA, FTIPMV, FALMCAT, FUSERS |
| Pedidos | Hoja / Nuevo | P_NEW_SHEET_ICON | Capturada, apertura | POST /api/sales/orders/capture, sólo referencia funcional | FALMCAT |
| Captura | Almacén 01 | P_WAREHOUSE_01 | Capturada, lectura | Mismo flujo | FTIPMV y validaciones |
| Captura | Cliente 000001 + Tab | P_CUSTOMER_000001 | Capturada, intento bloqueado | Mismo flujo | Validación de tipo de movimiento; sin alta |
| Captura | Guardar P / X | Sin marcador | No capturada en este intento | Tipo P existente; X pendiente | No ejecutado |

La evidencia previa de alta real P permanece en
[orders-create-sql-new-version.md](orders-create-sql-new-version.md). Este intento
no demuestra equivalencia entre P y X ni que sólo cambie el prefijo. La API
continúa admitiendo typeCode=P; la persistencia nueva sigue siendo Neon/PostgreSQL.

## Cierre comprobado

El 2026-11-11 a las 18:29:37 UTC se restauró proscai_my.ini. SHA-256 original y
restaurado: `9193373D6A7BD039DD0517FDB7A1F4A833AC65294A5DDBCCB2903D3FFB7617A2`.
my.ini permaneció sin cambios. MySQL80 quedó **Running**. Se ejecutó otra vez
`SHOW GLOBAL VARIABLES LIKE 'general_log'` y devolvió **OFF**; la ruta de log
volvió a su valor original. No se reconfiguró la conexión de la API ni Neon.

Evidencia privada excluida de Git:
`captures/sql/new-version/sales/orders-p-x-20261111/`: metadatos, respaldos,
marcadores, log crudo, `attempt-events.json`, `blocked-attempt.json`, capturas y
`restoration.json`. Los eventos de ese JSON son **capturados**; no se generó SQL
adaptado ni derivado para una escritura X no observada. El log crudo debe
permanecer privado y no publicarse; la extracción funcional evita autenticación.

## Continuación necesaria

Comprobar primero, con general_log OFF, una sesión autorizada para usar P y X
en almacén 01. Después preparar otra captura limitada, correlacionar de nuevo
el thread_id y observar ambos guardados. No editar permisos, folios ni tablas
para eludir la validación. Sólo después comparar escrituras de P/X y completar
los contratos de alta en Neon. No se ejecutaron pruebas de código porque este
trabajo sólo registra evidencia y documentación; no cambió backend/frontend.
