---
name: proscai-sql-capture
description: Capturar y analizar el SQL enviado por PROSCAI/OMNIS a MySQL o MariaDB para una acción concreta, identificar su conexión y separar SQL literal, adaptación e inferencias con trazabilidad.
---

# Captura SQL de una acción OMNIS

Lee el runbook [REA-SQL-CAPTURE](../../../docs/REA-SQL-CAPTURE.md) antes de activar una captura. El uso de esta skill no autoriza cambios de configuración, reinicios, creación de usuarios ni escrituras de prueba.

## Elegir el método

- Preferencia: general_log durante una ventana breve, con thread_id de OMNIS verificado y marcadores por acción.
- PROCESSLIST es apoyo incompleto, no reemplazo equivalente: el script histórico tiene filtros de usuario/host del servidor anterior y deduplica/normaliza sentencias. No preserva todas las ejecuciones ni su orden literal.
- El proxy sólo sirve si se autoriza redirigir OMNIS y el protocolo real permite observarlo. Sus connectionId son identificadores locales, no thread_id MySQL; no garantiza ver COM_STMT_EXECUTE, tráfico TLS o una conexión fuera del proxy.

## Procedimiento

1. Define módulo, vista, etiqueta visible, variante de teclado, registro y operación permitida. No reutilices códigos ni autorizaciones de otra instalación. Antes de provocar una escritura, confirma aislamiento y autorización para esa acción.
2. Identifica host/base/versión del servidor, destino y estado del log, permisos disponibles y conexión de OMNIS. Una cuenta de consulta de la API no es una cuenta administrativa. Conserva credenciales sólo localmente; no las muestres ni las metas en argumentos de consola.
3. Deja preparado el apagado por una conexión administrativa independiente y un límite de duración/espacio. No empieces si no puedes desactivar el log. Mantén OFF durante login y navegación preliminar, salvo que sea imprescindible capturar la propia apertura: en ese caso usa una ventana distinta y ya autenticada.
4. Inicia, verifica ON, registra START, ejecuta una sola acción, registra END, apaga inmediatamente y verifica SHOW GLOBAL VARIABLES LIKE 'general_log' = OFF, también ante errores. Si el usuario prefiere ejecutar el clic, indica READY sólo cuando conexión, destino, marcadores y apagado estén preparados; al recibir listo, apaga antes de analizar.
5. Extrae el intervalo y thread_id correctos. Si OMNIS se reconectó, reidentifica: no amplíes el filtro a todos los usuarios. Guarda el crudo íntegro y trabaja sobre una copia.
6. Para un archivo general_log con fechas ISO 8601 puedes usar [extract_general_log.py](scripts/extract_general_log.py), con intervalos de zona explícita. Lee su --help y sus límites en el runbook. No controla MySQL ni verifica por sí solo que un hilo pertenezca a OMNIS.
7. Mantén orden y repeticiones. Separa configuración, transacciones, catálogos, detalle, totales y escrituras; elimina ruido sólo en un derivado, sin borrar el crudo. No ejecutes SQL capturado de escritura para analizarlo.

Documenta en [REA-WORK-RECORD](../../../docs/REA-WORK-RECORD.md) SQL capturada/adaptada/derivada, filtros, joins, sentinelas, orden, valores nulos, totales y errores. Un panel puede no emitir SQL funcional. Un resultado de cero filas puede deberse al hilo/intervalo incorrecto: confirma esos datos antes de declarar ausencia de SQL.

La evidencia literal es el log. La consulta implementada vive en infrastructure/datasources y utiliza parámetros; no etiquetes esa reescritura como sentencia literal de OMNIS.
