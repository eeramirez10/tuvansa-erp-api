---
name: proscai-rea
description: Preparar o continuar la ingeniería inversa de PROSCAI/OMNIS y el traspaso de Tuvansa ERP a otra instalación, sin depender de OMNIS Studio ni del historial del chat.
---

# Continuar REA de PROSCAI

Usar para incorporación a otro servidor, inventario de una versión o continuidad de un módulo. No convierte una solicitud de revisión en autorización para ejecutar escrituras.

1. Localiza ambos repositorios; sus nombres y rutas pueden cambiar. Lee los AGENTS.md aplicables y [REA-START-HERE](../../../docs/REA-START-HERE.md). Para elegir módulo y fuente de evidencia consulta [REA-MODULE-MAP](../../../docs/REA-MODULE-MAP.md), después sólo sus documentos pertinentes.
2. Distingue revisión local, versión publicada y respaldo del ERP. Registra rama/SHA de los dos repositorios; un clon no contiene cambios sin commit/push, captures/, secretos ni archivos del escritorio. No presentes la ausencia de un log privado como falta de SQL capturado originalmente.
3. Revisa únicamente los nombres de variables requeridas y configura credenciales localmente. Revalida host/base/versión/aislamiento del nuevo destino: autorizaciones y rutas del servidor anterior no se transfieren. Antes de lecturas de Pedidos con Neon configurado, revisa la inicialización automática descrita en la guía.
4. Sin Studio, observa el runtime visible y el SQL en el servidor de base de datos. No intentes obtener bibliotecas, desbloquear licencias o editar código OMNIS. Una ruta interna de método en una captura no demuestra acceso al código fuente.
5. Elige la etapa necesaria:
   - Interfaz nativa: [proscai-desktop-rea](../proscai-desktop-rea/SKILL.md).
   - Captura de SQL: [proscai-sql-capture](../proscai-sql-capture/SKILL.md).
   - Implementación autorizada: [proscai-feature-migration](../proscai-feature-migration/SKILL.md).
6. Antes de cambiar una función, compara pantalla → botón visible → endpoint → datasource → evidencia. Un reporte calculado desde un PDF es derivado; un endpoint existente no prueba que toda su función esté migrada ni autorizada para escribir.

Entrega un estado concreto: qué versión/base se observó, módulo/vista/botón, lectura o escritura permitida, diferencias verificadas, evidencia disponible y próxima acción. Usa [la ficha por acción](../../../docs/REA-WORK-RECORD.md). Si la tarea es sólo inventariar, termina con ese inventario; no actives logs ni pruebes altas por iniciativa propia.
