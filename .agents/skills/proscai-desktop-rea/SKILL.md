---
name: proscai-desktop-rea
description: Inspeccionar y recorrer PROSCAI/OMNIS Runtime en Windows con pywinauto, capturas y coordenadas verificadas para comparar pantallas o preparar capturas SQL, incluso sin OMNIS Studio.
---

# Interfaz nativa de PROSCAI sin Studio

Lee AGENTS.md y la documentación del módulo. Requiere una sesión Windows interactiva accesible; una sesión bloqueada, desconectada o un servidor Linux sin escritorio no sirve para automatizar el runtime. No presupongas que el agente tiene permisos de escritorio aunque una terminal funcione.

## Primera inspección en una instalación

- Verifica Python, pywinauto y Pillow en el intérprete elegido. Se pueden instalar en un entorno virtual de herramientas; no cambies dependencias de la API para esto.
- Localiza procesos candidatos por nombre/ruta y confirma PID, ventana y aplicación. No reutilices el PID, handle, acceso directo ni coordenadas del servidor anterior. Si falta una dependencia o hay varias sesiones, explica qué falta sin cerrar procesos.
- Si la aplicación está cerrada y abrirla forma parte de la tarea, usa el acceso directo real identificado en ese escritorio. No busques ni abras Studio. Conserva tamaño/posición de la ventana existente.
- Localiza y enfoca con backend Win32. Prueba UIA y Win32 para identificar qué nombres/AutomationId existen; los controles dibujados por OMNIS a menudo no son accesibles. No afirmes que una enumeración vacía signifique que no hay botones visibles.
- Si aparece login, deja al usuario introducir credenciales. No leas valores de campos, no registres credenciales ni captures mientras se escriben. Responde exactamente CREDENTIALS_REQUIRED y espera la confirmación antes de seguir.
- Captura la ventana completa o el escritorio necesario bajo captures/ui/. Inspecciona visualmente la imagen antes de seleccionar coordenadas. Enumera título, vista, campos, pestañas, botones, columnas, totales y scroll; anota qué nombres son accesibles.

## Navegación

Prefiere un control accesible si corresponde inequívocamente al botón visible. Si no existe, calcula coordenadas relativas al rectángulo actual de la ventana: punto de pantalla = origen actual + punto relativo observado. Recalcula después de cualquier cambio de DPI, resolución, posición, vista o reconexión. Una captura antigua no verifica un clic nuevo.

Toma capturas antes y después de cada navegación. Haz un solo clic y espera una condición observable (ventana/título/control o contenido visual estable), no una sucesión ciega de clics con pausas. Si no llegas a la pantalla esperada, captura el estado, vuelve usando el mecanismo visible normal y recalcula; no encadenes intentos sobre controles desconocidos.

Para consultar datos, conserva el texto visible de los botones y separa abrir un panel de pulsar su Consultar interno. Un botón que parezca consulta puede modificar datos. Registra los campos que exigen un caso de prueba; no inventes códigos del nuevo servidor.

Para una captura SQL, prepara primero [proscai-sql-capture](../proscai-sql-capture/SKILL.md), coloca START inmediatamente antes de la acción y END cuando termine. Recorre filtros, filas, totales y ambos scrolls sin ejecutar botones internos de escritura. No cierres OMNIS; cierra sólo el modal autorizado. No cambies MySQL desde esta skill.

Guarda el inventario y la evidencia privada bajo captures/. Traslada únicamente el resumen sin datos sensibles a la ficha del módulo. En una migración web se conservan las posiciones funcionales y etiquetas observadas, con el sistema de ventanas y componentes del frontend.
