# Continuar este proyecto en otro servidor

Actualizado 2026-11-19. Punto de entrada para revisar PROSCAI/OMNIS y continuar el desarrollo de Tuvansa ERP en otro servidor.

- Si Omnis Studio puede abrir una copia de `PROSCAI.LBS`, sigue la [guía de instalación de REA, exportación a JSON e inspección de clases](REA-OMNIS-LBS.md).
- Si sólo tienes el runtime, sigue la [ruta de observación de pantallas y SQL](#primera-sesión-sin-studio).

## Qué revisar primero

1. AGENTS.md de ambos repositorios: permisos, arquitectura, UI y flujo Git.
2. Esta guía y [mapa de módulos y cobertura](REA-MODULE-MAP.md).
3. El documento del módulo elegido en docs/modules/ y su equivalente frontend; para un cambio de interfaz, también el endpoint-map del frontend.
4. [Runbook de captura SQL](REA-SQL-CAPTURE.md) sólo si vas a capturar. Consulta el [handoff histórico](PROSCAI-MIGRATION-HANDOFF.md) para el contexto y los ejercicios, y comprueba las referencias contra esta guía y el código vigente.

## Skills del repositorio

Los archivos están dentro del repositorio para que se transporten con su versión publicada; no dependen de la carpeta personal de skills del agente anterior.

| Skill | Usar para |
| --- | --- |
| [proscai-rea](../.agents/skills/proscai-rea/SKILL.md) | Incorporación a una instalación, inventario y selección de la etapa |
| [proscai-desktop-rea](../.agents/skills/proscai-desktop-rea/SKILL.md) | Inspección/navegación Win32, UIA y coordenadas verificadas del runtime |
| [proscai-sql-capture](../.agents/skills/proscai-sql-capture/SKILL.md) | Hilo OMNIS, general_log, extracción y procedencia |
| [proscai-feature-migration](../.agents/skills/proscai-feature-migration/SKILL.md) | Pasar una función observada a contratos, datasource y frontend |

Si el cliente no descubre las skills en su catálogo, pídele que abra el SKILL.md por su ruta. El conector REA se prepara por separado con los comandos de la [guía de bibliotecas](REA-OMNIS-LBS.md#conectar-rea). La misma guía incluye las dependencias de la automatización visual en Windows. El extractor de log usa Python estándar. La API y el frontend usan pnpm.

## Qué viaja con Git y qué no

Un checkout contiene el contenido versionado del commit seleccionado. Las guías originales están en `docs/proscai-rea-transfer` de ambos repositorios. Para continuar desde una biblioteca accesible, sigue los [comandos de actualización para el servidor destino](REA-OMNIS-LBS.md#1-actualizar-los-repositorios).

Viajan código, documentos, tests, scripts versionados y ejemplos .env sin secretos. No viajan .env, .env.capture.local, contraseñas, certificados privados, captures/, bases, scripts locales dentro de captures/, PDFs/Excel del escritorio ni sesiones del runtime. Tampoco la configuración Firebase local del frontend. Los datos de PostgreSQL/Neon no se transportan con el código.

Para comprobar qué versión llegó, ejecutar en **cada repositorio** git branch --show-current, git log -1 --oneline y git status --short. Para que este proyecto sea reproducible hay que publicar también los cambios funcionales pendientes que se quieran llevar, después de su revisión; no basta publicar sólo los documentos que los describen. No añadir todo el working tree indiscriminadamente.

## Preparación del nuevo equipo

Clonar ambos repositorios preferiblemente como carpetas hermanas. Las rutas de este documento son relativas; no copiar rutas C:\Users\... de capturas antiguas.

```powershell
git clone --branch main https://github.com/eeramirez10/tuvansa-erp-api.git
git clone --branch main https://github.com/eeramirez10/tuvansa-erp-frontend.git
```

Seleccionar en ambos la rama publicada que contenga los cambios revisados; el nombre de una rama local no prueba que exista en origin. Verificar Node y pnpm contra package.json y packageManager de ambos proyectos. Instalar con pnpm install --frozen-lockfile desde cada raíz.

Crear los archivos de entorno **localmente** a partir de los ejemplos. El operador introduce secretos; no copiarlos al chat ni imprimir el archivo. Backend requiere LEGACY_DB_HOST, LEGACY_DB_PORT, LEGACY_DB_USER, LEGACY_DB_PASSWORD, LEGACY_DB_NAME y la opción SSL apropiada. HOST/PORT/API_PREFIX/CORS se configuran para ese entorno. Frontend requiere VITE_API_BASE_URL con /api. .env.capture.local es una conexión administrativa opcional para el ejercicio, distinta de la cuenta de lectura de la API; los scripts históricos no la cargan automáticamente.

Antes de conectar, confirmar si la base que usa el runtime es la misma que la API y a qué respaldo/año pertenece cada una. Registrar versión, base y aislamiento por separado sin contraseñas. Una diferencia de montos puede deberse a respaldos o periodos distintos. No asignar clientes/productos del servidor anterior como casos de prueba sin verificarlos.

### Precaución específica con Pedidos y Neon

MySQL es lectura. **Pedidos tiene un modelo local de escritura PostgreSQL/Neon**, no una réplica de las tablas heredadas ni sincronización de vuelta al ERP. La composición híbrida y postgresWriteBoundary son la referencia vigente; los datasources antiguos conservan métodos de escritura como evidencia, pero eso no los habilita por HTTP.

NEON_DATABASE_URL es opcional. Dejarla sin configurar permite revisar lecturas del legado y hace que las escrituras locales se rechacen. Si se configura, la primera operación de Pedidos que inicialice el overlay puede crear/aplicar migraciones, incluso desde un GET. pnpm db:neon:check y pnpm db:neon:migrate llaman a esa inicialización: **no son una comprobación exclusivamente de lectura**. Verificar destino y autorización antes de ejecutarlos o abrir Pedidos con una URL nueva.

No quitar una URL en uso como remedio automático a una caída: ocultaría las versiones locales y volvería a mostrar sólo el legado. Revisar [NEON-WRITE-DATABASE](NEON-WRITE-DATABASE.md) y el código vigente. Las credenciales y autorizaciones de una base de desarrollo anterior no autorizan cambios en una base de producción distinta.

## Primera sesión sin Studio

1. Identificar el runtime y su ventana/proceso. Revalidar conexión y esquema del nuevo servidor mediante lectura. No reiniciar servicios ni activar logs durante el inventario inicial.
2. Si aparece login: CREDENTIALS_REQUIRED. El usuario introduce credenciales; no se registran ni se capturan mientras escribe.
3. Inventariar los botones y comparar con frontend/documentación. Empezar por una función de lectura con registro representativo; una acción aparentemente de consulta puede guardar datos.
4. Preparar una captura breve con general_log y el hilo correcto. Seguir el runbook y verificar OFF al terminar. Sin privilegios, diagnosticar y proponer; no conceder permisos ni editar configuración por iniciativa propia.
5. Registrar literales, diferencias y procedencia. Sólo después implementar lo solicitado. Una función nueva no obliga a rehacer todos los módulos.

La ventana Windows necesita una sesión interactiva accesible. Se puede alojar la API en Ubuntu, pero eso no da control sobre la interfaz de un runtime Windows remoto; la inspección debe ejecutarse donde esté accesible la sesión.

## Estado y pendientes que no deben perderse

Consulta la matriz de módulos para encontrar la documentación y el código disponibles. Verifica en el commit descargado qué acciones de Pedidos están implementadas, en especial tipo XA/P, Duplicar y búsqueda y precio por cliente. El proveedor de validación fiscal sigue pendiente.

Los cambios funcionales más recientes de Pedidos y del reporte de comisiones de Cancún permanecen locales en el servidor anterior. Consulta la [referencia de commits publicados](REA-OMNIS-LBS.md#1-actualizar-los-repositorios) antes de usar el comportamiento actual como punto de partida.

Los documentos históricos pueden contener alcances superados. Priorizar la especificación más reciente verificada, los AGENTS.md y la composición/rutas actuales. Si el código y la documentación difieren, registrar la diferencia antes de cambiarla. Una captura antigua no prueba los botones o permisos de la versión nueva.

## Registro y validación

Usar [REA-WORK-RECORD](REA-WORK-RECORD.md) por acción. Datos sensibles y capturas bajo captures/ en el backend; sólo resumen saneado y referencias en Git. Para transferir evidencia privada, el operador debe proporcionar por un canal apropiado únicamente lo necesario; no agregar logs a Git para “completar” un clon.

Backend: pnpm lint, pnpm build, pnpm test. Frontend: pnpm lint, pnpm typecheck, pnpm build. Extractor offline: python -m unittest discover -s tests/rea -p test_*.py. Verificar la interfaz web con pruebas que distingan mocks, lectura real y escrituras autorizadas de prueba. El hecho de que /health responda no verifica la base ni concede permisos para una prueba de escritura.

## Texto para el agente cuando sólo hay runtime

```text
Lee AGENTS.md de ambos repositorios y docs/REA-START-HERE.md del backend.
Usa .agents/skills/proscai-rea/SKILL.md y la documentación del módulo que trabajemos.
En este equipo trabajaremos con el runtime visible de PROSCAI/OMNIS.
Primero identifica versión, ventana, conexiones y diferencias mediante lectura.
No supongas que las rutas, usuarios, permisos, respaldos ni autorizaciones del
servidor anterior siguen siendo válidos. No imprimas credenciales.
No actives general_log, reinicies servicios ni pruebes escrituras hasta preparar
el ejercicio autorizado. Una captura = una acción con START/END y el hilo OMNIS.
Al terminar verifica general_log OFF. Distingue SQL capturada/adaptada/derivada.
No implementes ni publiques cambios si sólo te estoy pidiendo observar.
```

Si el servidor tiene una biblioteca accesible desde Studio, usa el [mensaje inicial de la guía de bibliotecas](REA-OMNIS-LBS.md#mensaje-para-el-agente-del-otro-servidor).

## Validación de este paquete de continuidad

Revisión 2026-11-17: cinco SKILL.md (cuatro backend y uno frontend) válidos con el validador de skill-creator; diez archivos Markdown de entrada/skills sin enlaces locales rotos en la organización actual de carpetas. El extractor pasó ocho pruebas con logs sintéticos (hilo/intervalo/zona, orden/repeticiones, SQL multilínea, formato/encoding, cero resultados y no sobreescritura), más una ejecución de su CLI. No se usó el log de una base real para validar esta herramienta nueva ni se probó todavía la automatización del runtime del servidor destino.

Backend: pnpm lint, pnpm build y pnpm test correctos, 296 pruebas en 26 archivos. Frontend: pnpm lint, pnpm typecheck y pnpm build correctos. No se activó general_log, no se reinició MySQL y no se modificaron registros. Esto valida el paquete de continuidad y los checks actuales, no certifica la cobertura de cada consulta histórica ni la compatibilidad con una versión aún no inspeccionada.

El paquete de continuidad original se publicó en `docs/proscai-rea-transfer` de ambos repositorios e incluye las guías, las skills y el extractor.
