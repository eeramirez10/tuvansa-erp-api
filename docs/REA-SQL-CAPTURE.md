# Capturar y leer SQL de PROSCAI sin OMNIS Studio

Guía operativa vigente para un servidor nuevo. Complementa el historial de [PROSCAI-MIGRATION-HANDOFF](PROSCAI-MIGRATION-HANDOFF.md); no exige acceso al código del ERP. No ejecutar este procedimiento para una tarea que sólo pide documentación.

## Preparar el destino real

El runtime envía consultas al servidor de datos aunque Studio no esté instalado. Verifica qué instancia usa, host/puerto/base, versión, usuario y permisos; no asumas MySQL80, root, proscai_my.ini ni una ruta del servidor anterior. Un botón deshabilitado puede obedecer a permisos, no a una función eliminada.

La cuenta LEGACY_DB_* de la API es de lectura y puede no tener PROCESS ni permisos para general_log. Una cuenta administrativa local distinta se configura por el operador, sin publicarla ni dar permisos a la cuenta de lectura. Si se utiliza .env.capture.local, sus CAPTURE_DB_HOST/PORT/USER/PASSWORD/NAME son sólo administrativos: la aplicación y los scripts históricos no lo cargan automáticamente. No muestres ni copies sus valores; nunca pases la contraseña en la línea de comandos.

Antes de una acción que pueda insertar/actualizar/eliminar, confirma que **ese destino** es una copia aislada y que el usuario autorizó la prueba. Los permisos de una sesión anterior no confirman una base distinta. Las lecturas de metadatos no autorizan una prueba de alta.

En una consola administrativa, comprobar y guardar el resultado privado:

```sql
SELECT VERSION(), DATABASE(), CURRENT_USER();
SHOW GRANTS FOR CURRENT_USER();
SHOW GLOBAL VARIABLES LIKE 'general_log';
SHOW GLOBAL VARIABLES LIKE 'general_log_file';
SHOW GLOBAL VARIABLES LIKE 'log_output';
SHOW GLOBAL VARIABLES LIKE 'log_timestamps';
SHOW VARIABLES LIKE 'time_zone';
SHOW FULL PROCESSLIST;
```

Identifica OMNIS por host, base, usuario y actividad correlacionada. No confundas sus conexiones con el pool Node o la consola. Si existen varios hilos, verifica cuál atiende esta vista; una reconexión invalida el Id previo. Con registro en marcha se puede correlacionar actividad de lectura breve, en su propio intervalo, sin mezclarla con la acción objetivo.

## Una acción y apagado inmediato

1. Autenticar y navegar antes de la captura cuando sea posible. En login: CREDENTIALS_REQUIRED; esperar y no registrar credenciales.
2. Tener preparada una segunda conexión administrativa para apagar el log y una duración máxima breve; comprobar espacio/destino. Si no se puede asegurar el apagado, no activar.
3. Verificar el estado inicial. Si ya estaba ON por un tercero, identificar al responsable antes de interferir: no puede garantizarse este procedimiento y otro uso simultáneo sin coordinación.
4. Ejecutar SET GLOBAL general_log='ON' y verificar ON. Registrar START con fecha ISO y zona inmediatamente antes de un único clic. La etiqueta debe incluir módulo/vista/botón/variante; no juntar clic y Ctrl+clic.
5. Esperar fin de esa acción y registrar END. **Apagar antes de analizar** mediante SET GLOBAL general_log='OFF'. Ejecutar y conservar SHOW GLOBAL VARIABLES LIKE 'general_log'; debe devolver OFF, incluso tras un error o cancelación. Que OMNIS se cierre no apaga el log.
6. Copiar la evidencia y filtrar por intervalo y thread_id confirmado. No truncar logs compartidos. Si se requiere una acción interna Consultar, capturarla por separado y confirmar que sea de lectura.

Los marcadores pueden ser registros privados de control o SELECT literales ejecutados por la conexión administrativa; ese hilo es distinto al de OMNIS. Conserva sus límites por separado: filtrar sólo el hilo OMNIS eliminará los SELECT marcadores administrativos. Usa reloj y zona del servidor/log, no horas locales supuestas.

### Destino TABLE

mysql.general_log.event_time es TIMESTAMP; considera la zona de la sesión usada para extraer. No mezcles UTC de FILE con horas locales de TABLE.

```sql
SET @capture_from = 'FECHA_HORA_CONFIRMADA';
SET @capture_to = 'FECHA_HORA_CONFIRMADA';
SET @omnis_thread = 123;
SELECT event_time, thread_id, command_type, argument
FROM mysql.general_log
WHERE event_time >= @capture_from AND event_time <= @capture_to
  AND thread_id = @omnis_thread
ORDER BY event_time;
```

Los valores anteriores son ilustrativos, no ejecutables sin completar. Si eventos comparten timestamp, esta tabla no ofrece aquí una secuencia verificable para desempatar: no inventes un orden. FILE conserva el orden físico y es preferible cuando esa precisión sea necesaria. No cambies log_output sin revisar permisos y operación del servidor.

### Destino FILE

Conservar copia íntegra, zona del log, intervalo, hilo, formato, encoding y SHA-256. El helper incluido en la skill no se conecta a MySQL y no activa/desactiva logs:

```powershell
python .agents/skills/proscai-sql-capture/scripts/extract_general_log.py --help
python .agents/skills/proscai-sql-capture/scripts/extract_general_log.py --input captures/ejercicio/raw.log --thread-id 123 --start 2026-11-17T10:00:00-06:00 --end 2026-11-17T10:00:05-06:00 --output-dir captures/ejercicio/extraido
```

Fechas e Id son ejemplos; sustituir por los observados. Admite registros general_log con encabezado ISO 8601 y zona (MySQL moderno); no interpreta slow_query_log, JSON del proxy ni formatos antiguos de MariaDB. Rechaza encabezados ambiguos en lugar de ofrecer una extracción parcial como completa. Se puede indicar --encoding para un encoding verificado. Un formato no soportado requiere un parser validado o extracción manual, no cambiar el servidor sólo para acomodar el helper.

Produce events.jsonl (metadatos, argumento y entrada cruda), queries.sql (presentación de Query/Execute en orden, sin normalizar SQL ni añadir puntos y coma) y metadata.json (hilo, intervalo, hash y conteos). No es un script listo para ejecutar: events.jsonl y la entrada raw conservan la evidencia literal. No elimina repeticiones ni instrucciones transaccionales. Prepare queda en events.jsonl y no se presenta como ejecución. No sobreescribe un directorio existente. Un archivo extraído no demuestra por sí solo que el Id sea OMNIS: esa identificación pertenece a la ficha del ejercicio.

## Si no hay privilegios para controlar general_log

No otorgar permisos, crear usuarios ni reconfigurar la base por iniciativa del agente. Diagnosticar y proponer primero. Una alternativa ya usada en este proyecto fue modificar temporalmente la configuración real del servicio, con **dos reinicios autorizados**; no es el método automático para el servidor nuevo.

Si el operador elige esa alternativa:

- Identificar desde el servicio su ejecutable y opciones reales, versión y archivo cargado (--defaults-file cuando exista); no deducirlo sólo por encontrar un my.ini en disco. Inspeccionar datadir, destino de log, ACL del archivo/directorio y permisos de reinicio.
- Comprobar copia aislada, respaldo y SHA-256 del archivo original, plan de restauración y ventana de mantenimiento. No copiar secretos del archivo a Git ni al chat. Obtener autorización explícita para modificación y ambos reinicios antes de ejecutar.
- Validar la configuración con el mecanismo soportado por esa versión; no asumir que --validate-config existe en todas las versiones MariaDB/MySQL. Activar únicamente el logging necesario en un archivo separado bajo el datadir/directorio permitido.
- Primer reinicio: verificar Running, reconectar PROSCAI y manejar login. Reidentificar hilo. Registrar marcadores y una acción; si no se permite SET GLOBAL OFF, restaurar/reiniciar inmediatamente tras END, sin ponerse a analizar mientras sigue activo.
- Restaurar exactamente el original, comprobar su SHA-256, segundo reinicio y Running. Verificar **por SQL** general_log=OFF; el hash y el estado Running por sí solos no prueban OFF. Si la verificación no es posible, informar estado no verificado, no éxito.

Esta guía no instala servicios ni ofrece un script genérico de reinicio porque las rutas, versión y permisos no son portables. Los scripts antiguos de captures/ son evidencia local, no herramientas que un clon pueda dar por disponibles.

## Límites de los scripts históricos versionados

| Herramienta | Qué hace realmente | Límite para otro servidor |
| --- | --- | --- |
| scripts/capture-omnis-queries.ts | Sondea PROCESSLIST; imprime READY | Filtros fijos consultas/localhost; normaliza espacios y deduplica; pierde consultas rápidas y repeticiones; revisar antes de usar |
| scripts/mysql-query-proxy.ts | Reenvía protocolo y registra COM_QUERY/COM_STMT_PREPARE y errores | Requiere redirección autorizada; Id local del proxy distinto del MySQL; no reconstruye ejecuciones parametrizadas ni tráfico cifrado; encoding latin1 a revisar |
| scripts/summarize-omnis-capture.ts | Lee JSONL del proxy y genera Markdown | No lee general_log FILE; título y rutas por defecto históricos de clientes; revisar/proporcionar rutas explícitas y conservar salida privada hasta sanearla |

Ninguna de estas herramientas equivale a una captura completa automática sin verificar su formato, hilo y ventana.

## Leer y clasificar

Capturada = literal observado en log/tráfico. Adaptada = parametrización/proyección/paginación que conserva el significado observado. Derivada = consulta/regla nueva; incluye cálculos inferidos de PDF o fórmulas aportadas por el usuario. Encontrar una consulta en un datasource no demuestra que OMNIS la haya enviado.

Primero conservar el crudo y el orden. Después separar apertura, catálogos, detalle, totales, configuración y transacciones. No deduplicar el original ni eliminar SET/COMMIT antes de entender los límites. Revisar joins, compañía/sucursal, fechas, estados fiscales, 1900-12-31, null/ceros y diferencias entre cantidad y cantidad facturada. Una llamada a procedimiento no revela su cuerpo ni sus efectos.

Usar [REA-WORK-RECORD](REA-WORK-RECORD.md) y actualizar el documento del módulo. No ejecutar los INSERT/UPDATE/DELETE del log para “ver qué hacen”. Si no se observa SQL funcional, registrar ese hecho con los controles de hilo/intervalo, sin inventar una sentencia.
