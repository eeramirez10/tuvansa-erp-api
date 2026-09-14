# Punto de integración: proveedor fiscal

Estado al 2026-09-14: editor y guardado implementados; verificación automática no implementada. POST de verificación devuelve 501, sin fabricar un resultado satisfactorio ni un CLICFDI4CS.

El usuario decidió integrar el proveedor posteriormente. La preparación está implementada y no exige proveedor ni credenciales ahora.

## Contrato preparado

`domain/services/client-fiscal-verification-provider.ts` define `ClientFiscalVerificationProvider`, independiente de Express, MySQL y de cualquier proveedor concreto. Recibe sólo los cuatro valores fiscales y devuelve un resultado interno `validated`, `rejected` o `unavailable`. Este contrato es **derivado** para la aplicación; no pretende documentar un protocolo observado de SEP ni de un PAC.

`infrastructure/services/unconfigured-client-fiscal-verification-provider.ts` implementa el estado predeterminado: no realiza llamadas de red y devuelve `not-configured`. `clients-module.ts` lo inyecta en `ClientFiscalUseCases`. Para conectar el proveedor, implementar un adaptador en esa misma carpeta e inyectarlo en el módulo. El adaptador debe validar la respuesta, limitar el tiempo de espera y convertir errores del proveedor al contrato interno, sin exponer secretos ni respuestas crudas. No se añadieron URLs o variables de configuración ficticias.

POST `/api/accounts-receivable/clients/:clientId/actions/fiscal-verification/verify` mantiene cuerpo `{}`:

| Resultado interno | HTTP | Resultado de la API |
|---|---|---|
| Sin configurar | 501 | FISCAL_VERIFICATION_UNAVAILABLE; integración pendiente |
| Proveedor temporalmente indisponible o excepción | 503 | FISCAL_PROVIDER_UNAVAILABLE; mensaje público sin detalles del transporte |
| Datos rechazados | 422 | FISCAL_DATA_REJECTED |
| Cambios mientras se esperaba el resultado | 409 | FISCAL_DATA_CHANGED; requiere otra consulta |
| Datos validados | 200 | `data: { clientId, version, status: 'provider-validated', legacySync: 'pending' }`, más mensaje explícito de verificación pendiente en PROSCAI |

El último caso sólo se ejercita con un doble de prueba hasta conectar un proveedor real. No escribe campos ni marcadores: un veredicto externo no confirma la generación de CLICFDI4CS. Antes de mostrar rechazo o validación se relee la versión del cliente. La respuesta describe esa versión y no persiste una certificación. El frontend muestra el mensaje devuelto tanto en éxito parcial como en error; nunca convierte `provider-validated` en una verificación legada completada.

GET y PATCH informan `verificationAvailable` según el adaptador configurado. Esto indica disponibilidad de consulta al proveedor, no sincronización completa con PROSCAI. La persistencia del marcador seguirá requiriendo las reglas originales.

## Información técnica necesaria

Se requiere el código accesible del método de verificación de PROSCAI o la documentación de su integración con SEP/servicio fiscal. Debe permitir resolver:

- Operación, protocolo y dirección del servicio o SDK utilizado para validar RFC, nombre, código postal y régimen fiscal.
- Contrato de entrada y salida, códigos de error y comportamiento ante indisponibilidad.
- Mecanismo de autenticación y entorno de pruebas. Las credenciales se configuran localmente, nunca en documentación o Git.
- Generación y vigencia de CLICFDI4CS, incluidos los cambios que invalidan el marcador. Una respuesta de otro proveedor no permite inventar este valor.

No basta el nombre comercial de un PAC ni la confirmación visual de éxito: hacen falta los contratos y reglas ejecutables para reproducir el comportamiento.

## Evidencia disponible

La [documentación del flujo](client-fiscal-verification.md) relaciona botones, capturas y endpoints. Se observaron éxito con los valores originales y rechazo 00504 con un código postal incorrecto; después se restauraron y verificaron los datos originales en la copia de pruebas.

La inspección de Studio Browser en la sesión activa mostró Libraries con cero objetos; no expuso el método para leerlo. Evidencia local: `captures/ui/new-version/fiscal-method/05-libraries.png`. Se cerró únicamente Studio Browser y se conservó OMNIS abierto en Catálogo de clientes. No se modificaron bibliotecas ni registros durante esa inspección; general_log se verificó OFF.

Las referencias de servicios halladas en SEP no establecen cuál utiliza este botón. Las observaciones de red disponibles tampoco identifican un contrato. No se eligió un proveedor por inferencia.

## Implementación después de resolver la dependencia

Incorporar un adaptador del servicio confirmado, mapear errores reales, verificar que los datos no cambiaron durante la petición y persistir únicamente el resultado autorizado por las reglas del legado. Cubrir datos válidos, discrepancias, fallos de conexión y ediciones concurrentes. Conservar las etiquetas capturada/adaptada/derivada para SQL y separar evidencia del proveedor de evidencia MySQL.
