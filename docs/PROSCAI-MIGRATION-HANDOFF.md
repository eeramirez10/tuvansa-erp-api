# Traspaso de contexto: migración PROSCAI / OMNIS

Este documento permite que una sesión nueva de Codex CLI continúe el trabajo en
otro servidor sin depender del historial del chat original. Debe leerse junto a
`AGENTS.md` y a la documentación específica de cada módulo.

La documentación oficial recomienda conservar las instrucciones permanentes en
`AGENTS.md` o en documentación versionada. Referencias:

- `https://learn.chatgpt.com/es-419/docs/agent-configuration/agents-md`
- `https://learn.chatgpt.com/es-419/docs/projects`

## Objetivo

Migrar gradualmente PROSCAI, desarrollado con OMNIS, hacia:

- una API Express + TypeScript modular y preparada para cambiar el origen MySQL
  heredado por PostgreSQL;
- un frontend React que conserve el flujo y distribución funcional de OMNIS,
  usando componentes modernos y reutilizables.

Repositorios:

- Backend: `https://github.com/eeramirez10/tuvansa-erp-api`
- Frontend: `https://github.com/eeramirez10/tuvansa-erp-frontend`

El sistema del nuevo servidor contiene una versión más reciente de PROSCAI con
pocas funciones adicionales. La primera misión allí es identificar y documentar
las diferencias antes de modificar la API o el frontend.

## Estado heredado que debe conservarse

Existen implementaciones y documentación para estos dominios, con alcances
distintos según lo que OMNIS expuso durante cada captura:

- cuentas por cobrar: catálogo de clientes, barra, acciones, consultas y reporte
  analítico de sucursal 01 México;
- inventarios: catálogo de productos de producto terminado, barra y paneles;
- ventas: pedidos y facturación;
- tesorería: bancos;
- cuentas por pagar: proveedores;
- compras: órdenes de compra y recepciones;
- contabilidad: pólizas.

No supongas que un módulo está completo sólo por existir. Revisa su documento en
`docs/modules/`, sus rutas, tests y requests `.http`. Inventarios M.P. se trató
como navegación hacia Inventarios P.T. porque la versión anterior presentaba la
misma vista.

## Arquitectura del backend

Cada módulo sigue Clean Architecture:

```text
src/modules/<module>/
  domain/
    entities/
    datasources/
    repositories/
  application/
    dtos/
    use-cases/
  infrastructure/
    datasources/       # SQL y mapeo MySQL
    repositories/      # delegación al datasource
  presentation/
    http/              # controladores y rutas
```

El SQL no debe aparecer en controllers, casos de uso o repositories. Los
contratos separados de datasource/repository son intencionales: más adelante se
agregarán adaptadores PostgreSQL.

## Tres niveles de procedencia SQL

Toda consulta documentada o implementada debe indicar su procedencia:

1. **Capturada**: SQL literal enviado por OMNIS y registrado por MySQL.
2. **Adaptada**: versión segura para la API. Conserva la semántica capturada,
   pero usa parámetros, proyección explícita, paginación y puede consolidar N+1.
3. **Derivada**: consulta nueva inferida a partir del modelo de datos para una
   función que no existía en OMNIS. Debe declararse como nueva.

Ejemplo: los filtros `fdoc.DEST = 0`, `DMULTICIA = 1` y `DESCXC = 1` del saldo
de clientes fueron capturados. El reporte analítico de clientes es derivado y
está documentado como tal.

## Runbook para capturar SQL real de OMNIS

### 1. Preparar una captura segura

Antes de tocar el servidor:

1. Confirma host, versión de MySQL, nombre de base y si se trata de una copia de
   pruebas. No copies credenciales a documentación ni al chat.
2. Si la base no está confirmada como aislada, no pruebes altas, cambios, bajas
   ni botones que puedan guardar automáticamente.
3. Comprueba espacio libre y localización del log. `general_log` puede crecer
   rápidamente.
4. Crea una rama para el módulo, por ejemplo
   `capture/<module>-new-proscai-version`.
5. Abre PROSCAI en la pantalla exacta y selecciona un registro representativo
   con datos. No abras otras ventanas durante la acción capturada.

Registra el estado inicial:

```sql
SELECT VERSION();
SHOW GLOBAL VARIABLES LIKE 'general_log';
SHOW GLOBAL VARIABLES LIKE 'general_log_file';
SHOW GLOBAL VARIABLES LIKE 'log_output';
SHOW FULL PROCESSLIST;
```

Identifica la conexión de OMNIS por usuario, host, base y actividad. Anota su
`Id`/`thread_id`; no confundas la conexión de Codex con la de OMNIS.

### 2. Método preferido: `general_log`

El usuario administrativo de MySQL debe tener los privilegios necesarios. Usa
una ventana de captura breve:

```sql
SET GLOBAL general_log = 'ON';
SHOW GLOBAL VARIABLES LIKE 'general_log';
```

Anota inmediatamente en un archivo de control:

```text
2026-09-09T10:00:00-06:00 START <MODULO>_<REGISTRO>_<BOTON>
```

Después:

1. Realiza exactamente un clic o una acción completa en OMNIS.
2. Espera a que la ventana termine de cargar.
3. Anota `END <mismo_marcador>` con fecha y hora.
4. Apaga el log antes de analizar:

```sql
SET GLOBAL general_log = 'OFF';
SHOW GLOBAL VARIABLES LIKE 'general_log';
```

El último resultado debe ser `OFF`. Haz esta verificación también cuando la
captura falle o OMNIS se cierre.

Si `log_output` incluye `TABLE`, extrae sólo el intervalo y `thread_id` de OMNIS
desde `mysql.general_log`. Si usa `FILE`, copia el intervalo del archivo que
indique `general_log_file`. No cambies `log_output` ni la ruta sin revisar antes
la configuración y permisos del servicio MySQL.

Ejemplo de lectura manual cuando el destino es tabla:

```sql
SET @capture_from = '2026-09-09 10:00:00';
SET @capture_to = '2026-09-09 10:00:30';
SET @omnis_thread = 123;

SELECT event_time, thread_id, command_type, argument
FROM mysql.general_log
WHERE event_time >= @capture_from
  AND event_time <= @capture_to
  AND thread_id = @omnis_thread
ORDER BY event_time;
```

No vacíes ni trunques logs compartidos. Copia el resultado a
`captures/<module>-<fecha>.log`; `captures/` está ignorada por Git.

### 3. Alternativa: sondeo de `PROCESSLIST`

`scripts/capture-omnis-queries.ts` consulta `information_schema.PROCESSLIST` a
alta frecuencia. Antes de usarlo, revisa que el usuario, host y base que filtra
coincidan con el nuevo servidor.

PowerShell:

```powershell
$env:CAPTURE_WATCHERS = '4'
$env:CAPTURE_DURATION_MS = '15000'
pnpm tsx scripts/capture-omnis-queries.ts
Remove-Item Env:CAPTURE_WATCHERS, Env:CAPTURE_DURATION_MS
```

Bash:

```bash
CAPTURE_WATCHERS=4 CAPTURE_DURATION_MS=15000 pnpm tsx scripts/capture-omnis-queries.ts
```

Inicia el script, espera `READY` y ejecuta una sola acción. Es un respaldo útil,
pero puede perder sentencias que duran menos que el intervalo de observación;
no es evidencia suficiente si el resultado está incompleto.

### 4. Alternativa: proxy del protocolo MySQL

`scripts/mysql-query-proxy.ts` escucha en un puerto local, reenvía el tráfico al
MySQL real y registra paquetes `COM_QUERY`, `COM_STMT_PREPARE` y errores. Úsalo
sólo si puedes cambiar de forma segura el host/puerto de la conexión de OMNIS.

PowerShell:

```powershell
$env:MYSQL_PROXY_HOST = '127.0.0.1'
$env:MYSQL_PROXY_PORT = '3307'
$env:MYSQL_TARGET_HOST = '127.0.0.1'
$env:MYSQL_TARGET_PORT = '3306'
$env:MYSQL_PROXY_LOG = 'captures/new-proscai.log'
pnpm tsx scripts/mysql-query-proxy.ts
```

Con el proxy activo, escribe en su entrada estándar antes de cada acción:

```text
MARK ORDERS_P010773_COMENTARIOS
```

El proxy no debe dejarse como configuración permanente de PROSCAI. Restaura la
conexión original y verifica que OMNIS vuelva a operar normalmente.

## Secuencia de investigación por pantalla

Para cada módulo nuevo o actualizado:

1. Captura una referencia visual de la pantalla base: distribución, etiquetas,
   campos, tablas, botones y barras de scroll.
2. Registra la consulta al abrir el módulo y al cargar un registro conocido.
3. Recorre la barra: anterior, búsqueda, siguiente y, sólo con autorización en
   base aislada, nuevo, eliminar y editar.
4. Captura cada botón de Acciones, Acciones secundarias, Consultas u otros
   paneles por separado.
5. Dentro de cada ventana registra columnas en orden, totales, controles y
   botones internos, aunque todavía no tengan endpoint.
6. Prueba búsquedas con un valor que sí exista y otro que no exista.
7. Cuando una ventana tenga información fuera del ancho/alto visible, registra
   que necesita scroll X, Y o XY.
8. Repite sólo la acción dudosa; no mezcles varios clics bajo un marcador.

## Cómo analizar una captura

- Descarta `SET`, `USE`, `COMMIT` y consultas de configuración sólo después de
  conservarlas en el log crudo; pueden delimitar transacciones.
- Separa consultas de apertura, catálogos auxiliares, detalle y totales.
- Conserva joins, ordenamiento, límites, rangos, sentinelas como `1900-12-31` y
  reglas de compañía/sucursal.
- Detecta procedimientos almacenados y revisa si la sentencia visible sólo los
  invoca; no inventes su contenido.
- Compara el estado antes/después para escrituras. Documenta `ROLLBACK`, errores
  y reintentos de OMNIS.
- Si OMNIS ejecuta `SELECT *` repetidos, documenta el literal y permite que la
  API lo adapte a una consulta explícita más eficiente.
- Los valores reales de la captura se sustituyen por `?` en la implementación.
- No publiques logs crudos: pueden contener clientes, documentos o credenciales
  indirectas.

## Entregable obligatorio por botón

Actualiza o crea un documento bajo `docs/modules/<module>/` con esta tabla:

| Vista | Etiqueta visible | Marcador | Procedencia | Endpoint | Tablas | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Ejemplo | Comentarios | `ORDERS_P010773_COMENTARIOS` | Capturada/adaptada | `GET /api/...` | `fcoment` | Verificado |

Incluye además:

- SQL literal relevante, sin datos sensibles innecesarios;
- diferencias contra la versión anterior;
- parámetros y forma de la respuesta;
- columnas y totales en el orden visual;
- evidencia cuando no se emitió SQL;
- requests reproducibles en `http/`;
- pruebas automatizadas y comandos ejecutados.

## Integración en la API

Una vez documentada la diferencia:

1. Define o amplía entidades y contratos de dominio.
2. Implementa SQL sólo en `infrastructure/datasources`.
3. Delega desde `infrastructure/repositories`.
4. Agrega caso de uso, DTO, controller, validación Zod y route.
5. Declara rutas estáticas antes de rutas `/:id` para evitar colisiones.
6. Añade `.http`, documentación y tests.
7. Ejecuta:

```bash
pnpm lint
pnpm build
pnpm test
```

No mezcles a `main` hasta la revisión y orden expresa del usuario.

## Prompt inicial recomendado para el nuevo servidor

```text
Lee completamente AGENTS.md y docs/PROSCAI-MIGRATION-HANDOFF.md. Revisa la
documentación existente del módulo antes de actuar.

Este servidor contiene una versión más reciente de PROSCAI. Primero inspecciona
la pantalla ya abierta y compara sus campos, botones y ventanas con lo
documentado. Captura una sola acción SQL a la vez con marcadores. Clasifica cada
consulta como capturada, adaptada o derivada. No realices escrituras hasta
confirmar que la base es una copia aislada de pruebas. Al terminar cualquier
captura verifica que general_log esté OFF.

Crea una rama para este módulo. Documenta diferencias y evidencia antes de
modificar la API. No mezcles a main sin autorización expresa.
```

## Índice útil

- `README.md`: arquitectura, comandos y despliegue.
- `docs/modules/`: trazabilidad funcional y SQL por módulo.
- `http/`: requests manuales por endpoint.
- `scripts/mysql-query-proxy.ts`: proxy/registrador MySQL.
- `scripts/capture-omnis-queries.ts`: capturador auxiliar por `PROCESSLIST`.
- `scripts/check-query-tracing.ts`: inspección del estado de trazabilidad.
- `captures/`: evidencia cruda local excluida de Git.
