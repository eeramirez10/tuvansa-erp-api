---
name: proscai-feature-migration
description: Replicar una función observada de PROSCAI en la API y el frontend Tuvansa, usando evidencia SQL, Clean Architecture, escrituras en PostgreSQL y componentes shadcn con Base UI.
---

# Migrar una función verificada

Usa sólo cuando el usuario solicite implementar o ajustar la réplica. Una petición de explorar o capturar no autoriza cambiar API/frontend. Lee ambos AGENTS.md, [REA-MODULE-MAP](../../../docs/REA-MODULE-MAP.md), documentos del módulo y el endpoint-map del frontend. Localiza el segundo repositorio, sin depender de una ruta de usuario de Windows.

## Contrato y origen

Relaciona vista/botón visible, variante normal/Ctrl, captura y tablas con el endpoint actual. Reutiliza contratos existentes antes de crear rutas. Si la evidencia no resuelve una regla financiera o una escritura, formula la duda concreta y avanza en lo independiente; no conviertas null o una regla desconocida en cero, 100% o un permiso global.

Conserva sentinelas, compañía/almacén, filtros fiscales y fechas de pago/documento/movimiento según la función. No apliques reglas de un reporte a otro por compartir tablas. Para ejercicios con respaldo distinto, contrasta estructura y significado, no igualdad forzada de importes. En reportes Excel comprueba fórmulas, signos, redondeo, totales y pendientes contra la API.

## Backend

- Contratos/entidades en domain; casos de uso y DTOs en application; validación Zod/rutas en presentation. SQL sólo en infrastructure/datasources; repositories delegan.
- Distingue lectura MySQL de escritura local PostgreSQL. Comprueba postgresWriteBoundary y la composición real del módulo: existen métodos legacy de escritura que no están habilitados por HTTP.
- Pedidos usa overlay Neon y folios locales independientes. No aumentes FTIPMV ni escribas en MySQL para replicar el alta web. Si extiendes otro módulo, primero conecta su adaptador PostgreSQL y sus pruebas; habilitar una ruta no migra sus escrituras.
- Las migraciones y el primer acceso a Pedidos con Neon configurado pueden escribir DDL. Verifica el destino antes de probar. No hay sincronización automática de Neon hacia PROSCAI.
- SQL parametrizado; clasificación adaptada o derivada explícita. Añade requests en http/ para endpoints nuevos y actualiza la ficha del módulo.

## Frontend

Mantén features/<dominio>/<función>: model, services Axios, logic/query keys y componentes/página. No guardes datos remotos en Zustand. La caché incluye todos los filtros que cambian resultados.

Reutiliza shadcn con Base UI, ErpDataDialog y el administrador de ventanas. Conserva etiquetas, columnas, proporciones, foco, Enter/OK, Escape/Cancelar y scroll observados. Las búsquedas independientes pasan al frente y no se mueven junto con la ventana de captura. No vuelvas a introducir diálogos aislados ni controles alternativos.

Actualiza docs/endpoint-map.md y el documento de la vista. Comprueba acceso directo, navegación, carga/error/vacío, filtros, paginación y exportación vigente. No publiques Firebase, despliegues ni main salvo que formen parte del encargo autorizado.

## Entrega

Backend: pnpm lint, pnpm build, pnpm test. Frontend: pnpm lint, pnpm typecheck, pnpm build. Distingue pruebas con mocks, lectura real y escritura real aislada. Conserva cambios ajenos y captures/ excluido. Informa qué quedó probado, la procedencia SQL y cualquier regla todavía pendiente; no anuncies réplica completa si falta una condición material.
