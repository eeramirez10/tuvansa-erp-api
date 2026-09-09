# Tuvansa ERP API - instrucciones para Codex

## Contexto obligatorio

- Este repositorio migra gradualmente un ERP PROSCAI desarrollado con OMNIS hacia una API Express + TypeScript.
- Antes de investigar una versión de PROSCAI, lee `docs/PROSCAI-MIGRATION-HANDOFF.md` y la documentación del módulo en `docs/modules/`.
- El frontend relacionado está en `https://github.com/eeramirez10/tuvansa-erp-frontend`.
- La base heredada y la interfaz visible pueden pertenecer a respaldos de fechas distintas. No supongas que los importes deben coincidir; compara estructura, filtros y comportamiento.

## Flujo Git

- Crea una rama por módulo o cambio independiente y usa commits enfocados.
- Indica al usuario cuando detectes una oportunidad para abrir otra rama.
- No mezcles a `main` ni publiques `main` hasta recibir una indicación expresa.
- Conserva cambios ajenos y archivos locales sin seguimiento.

## Arquitectura

- Mantén los módulos separados bajo `src/modules/<module>`.
- `domain`: entidades y contratos de repositories/datasources; sin Express ni MySQL.
- `application`: casos de uso y DTOs.
- `infrastructure/datasources`: única ubicación permitida para SQL y lógica de acceso al origen.
- `infrastructure/repositories`: sólo conecta/delega hacia el datasource.
- `presentation`: validación Zod, controladores y rutas Express.
- Diseña contratos que permitan reemplazar MySQL por PostgreSQL sin cambiar los casos de uso ni HTTP.
- Usa consultas parametrizadas. No concatentes valores proporcionados por el cliente.

## Evidencia y procedencia SQL

- Nunca afirmes que una consulta es SQL real de OMNIS sin haberla observado en el log de MySQL o en el tráfico MySQL.
- Etiqueta la procedencia como una de estas:
  - `capturada`: sentencia literal que OMNIS envió a MySQL.
  - `adaptada`: conserva tablas, joins, filtros y significado capturados, pero parametriza, pagina, elimina `SELECT *` o evita N+1.
  - `derivada`: consulta nueva diseñada para la API; no existe como SQL confirmado de OMNIS.
- Relaciona siempre vista, etiqueta visible del botón, marcador de captura, endpoint y tablas.
- El nombre visible del botón manda sobre el nombre interno de la función de OMNIS.
- Si una acción no emite SQL funcional, documéntalo; no inventes una consulta.

## Captura en PROSCAI

- Sigue el runbook de `docs/PROSCAI-MIGRATION-HANDOFF.md`.
- Prefiere el `general_log` de MySQL en ventanas breves y filtra el `thread_id` de OMNIS.
- Usa `scripts/capture-omnis-queries.ts` sólo como apoyo; el sondeo de `PROCESSLIST` puede perder consultas rápidas.
- Usa `scripts/mysql-query-proxy.ts` como alternativa sólo si es seguro redirigir la conexión de OMNIS al proxy.
- Coloca un marcador antes de cada clic y captura una sola acción a la vez.
- Al terminar, ejecuta y registra `SHOW GLOBAL VARIABLES LIKE 'general_log';`; el valor debe ser `OFF`.
- Guarda logs crudos bajo `captures/`. Esa carpeta está excluida de Git y puede contener datos sensibles de prueba.

## Seguridad de datos

- No incluyas `.env`, contraseñas, tokens, logs crudos ni datos personales en Git.
- Antes de provocar un `INSERT`, `UPDATE` o `DELETE`, confirma que la base es una copia aislada y que el usuario autorizó esa prueba.
- En una base no confirmada como prueba, realiza exclusivamente acciones de lectura.
- Activar `general_log` requiere privilegios y puede consumir disco; úsalo sólo durante la captura y apágalo incluso si algo falla.

## Validación y documentación

- Usa `pnpm`; no generes `package-lock.json`.
- Antes de entregar cambios ejecuta `pnpm lint`, `pnpm build` y `pnpm test`.
- Agrega requests reproducibles en `http/` para endpoints nuevos.
- Actualiza el documento del módulo con la tabla vista/botón/endpoint/captura/tablas.
- Conserva fechas, códigos y suposiciones verificadas; separa hechos de inferencias.
