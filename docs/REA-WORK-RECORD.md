# Ficha de trabajo REA por acción

Copiar a docs/modules/<dominio>/<función>-<fecha>.md; no rellenar con hechos supuestos. Evidencia cruda y datos personales sólo en captures/.

- Fecha, versión visible del runtime y versión del servidor de base de datos:
- Repositorios, rama y SHA backend/frontend; diferencias locales que no están publicadas:
- Módulo, vista, sección y etiqueta exacta del botón:
- Variante: clic normal, Ctrl, atajo o botón interno; una acción por marcador:
- Registro de prueba y origen de sus datos (en el crudo privado si es sensible):
- Destino MySQL/MariaDB identificado; aislamiento confirmado por quién y acción autorizada:
- Destino PostgreSQL/Neon, si corresponde; distinguirlo del origen heredado:
- Método FILE/TABLE/proxy/PROCESSLIST y sus limitaciones:
- thread_id de OMNIS y cómo se verificó; conexiones administrativas separadas:
- START/END con fecha, zona y precisión; reconexiones:
- Archivo crudo local, SHA-256, archivos extraídos y captura visual:
- Estado inicial/final general_log; evidencia final literal OFF. Servicio/configuración restaurados sólo si se tocaron:

| Vista | Etiqueta visible | Marcador | Endpoint | Tablas | Procedencia | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Completar con el ejercicio real | Completar | START/END verificados | Ruta existente/propuesta o sin HTTP | Tablas observadas | capturada/adaptada/derivada | observado/implementado/probado/pendiente |

## SQL y comportamiento

Conservar literales relevantes en orden y sin secretos; anonimizar datos personales en la copia versionada y conservar el original privado. Separar explícitamente literal, versión parametrizada y consultas nuevas. Describir joins, filtros, fechas/sentinelas, orden, repeticiones, catálogos, detalle, totales y transacciones. Si no hubo SQL funcional, registrar cómo se confirmó hilo/intervalo y qué pudo resolverse desde memoria/interfaz.

## Interfaz y diferencias

Título, campos/etiquetas, pestañas, botones internos, columnas en orden, filas, importes/totales, filtros/fechas, scroll X/Y, foco/teclado, estados vacíos/errores y regreso normal. Comparar con documento y frontend anterior: existente, renombrado, movido, nuevo, ausente o no observable por permisos.

## Validación y continuación

Requests HTTP, pruebas/comandos ejecutados, datos simulados frente a origen real, ausencia o autorización de escrituras, límites y próxima acción concreta. No marcar una función completa cuando una regla financiera, proveedor o permiso sigue sin confirmar.
