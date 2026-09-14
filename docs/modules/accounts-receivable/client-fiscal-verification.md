# Clientes: Verifica fiscal

Implementación inicial: 2026-09-14. **Edición disponible; verificación automática pendiente.**

Por decisión del usuario, la conexión al proveedor se pospone. El contrato e inyección del adaptador están preparados; no se requiere configurar credenciales ahora. Ver [punto de integración](fiscal-integration-requirements.md).

La versión nueva de PROSCAI incorpora clic normal y Ctrl + clic sobre **Verifica fiscal** en Catálogo de clientes. El segundo abre una confirmación y el modal **Cliente - Datos Fiscal**. Evidencia local: `captures/sql/new-version/accounts-receivable/verifica-fiscal.md` y `verifica-fiscal-ctrl-confirm.md`; imágenes en `captures/ui/new-version/clients-fiscal-retry/`. Los logs literales permanecen fuera de Git.

## Trazabilidad

Las rutas siguientes llevan el prefijo `/api/accounts-receivable/clients/:clientId/actions/fiscal-verification`; `clientId` es CLISEQ, no CLICOD.

| Vista / botón | Marcador observado | Endpoint implementado | Tablas |
|---|---|---|---|
| Clientes / Verifica fiscal | CLIENT_000001_VERIFICA_FISCAL_CLICK | POST `/verify`: 501 FISCAL_VERIFICATION_UNAVAILABLE | fcli, fyg (lectura de contexto) |
| Clientes / Ctrl + Verifica fiscal | CLIENT_000001_VERIFICA_FISCAL_CTRL_OPEN | Confirmación local Yes/No | Ninguna en la UI web |
| Confirmación / Yes | CLIENT_000001_VERIFICA_FISCAL_CTRL_CONFIRM_YES | GET `/` | fcli, fyg |
| Cliente - Datos Fiscal / OK | CLIENT_000001_VERIFICA_FISCAL_CTRL_SAVE_OK | PATCH `/` | fcli, fyg |
| Cliente - Datos Fiscal / Cancelar | No capturado | Cierre local sin guardar | Ninguna |

## Evidencia y procedencia SQL

- **Capturada:** OMNIS actualiza CLIRFC, CLINOM, CLICP, CLIREGIMEN y CLICFDI4CS por CLISEQ; después recarga `SELECT * FROM fcli ... LIMIT 1`. Clic normal y OK con los valores originales producen el mismo UPDATE. El checksum numérico observado es específico del caso, no una constante utilizable en la API.
- **Capturada:** Yes pone CLICFDI4CS=0 antes de abrir el editor, recarga fcli y consulta fyg por YGKEY='REGIMENES_DE_CAPITAL'. Ctrl abre una confirmación y consulta contexto FUSERS; no se traslada esa consulta de usuarios al endpoint fiscal.
- **Adaptada:** lectura explícita de los siete campos de fcli, parametrizada por CLISEQ; lectura de YGDAT en fyg parametrizada por la clave observada. No hay joins, ordenamiento ni totales en estas acciones. El catálogo mantiene el orden serializado.
- **Derivada:** bloqueo `FOR UPDATE`, transacción y token SHA-256 para detectar edición concurrente. El token no es CLICFDI4CS.
- **Derivada:** PATCH guarda los cuatro campos y pone CLICFDI4CS=0 únicamente cuando cambian. Abrir y cancelar no escriben. Guardar valores idénticos conserva el marcador existente.

SQL de escritura implementado (**derivada**, no sentencia literal capturada):

```sql
UPDATE fcli SET CLIRFC=?, CLINOM=?, CLICP=?, CLIREGIMEN=?, CLICFDI4CS=0 WHERE CLISEQ=?
```

El algoritmo de CLICFDI4CS no está confirmado. No se confirmó una consulta a SAT ni a otro proveedor: general_log sólo muestra MySQL. Por ello POST `/verify` no escribe ni presenta éxito; responde 501. Un marcador legado presente tampoco se anuncia como validación vigente. Para completar la equivalencia hacen falta las reglas o implementación original de verificación, casos de error y pruebas controladas con valores modificados.

## Contrato y diferencias visuales

GET devuelve `{ data: { clientId, code, values, version, verification, capitalRegimes, verificationAvailable } }`. `verificationAvailable` es booleano y actualmente vale false: el adaptador instalado no está configurado. `values` contiene taxId, name (nombre completo), postalCode y fiscalRegime. `verification` distingue `pending` y `legacy-marker-present` sin afirmar validez fiscal. El catálogo separa filas con `||` y código/descripción con `|~|~`; se decodifican bytes UTF-8 o Windows-1252, sin eliminar acentos.

PATCH recibe `{ expectedVersion, values }`. Valida campos y rechaza propiedades adicionales, incluido cualquier checksum proporcionado por el cliente. Responde 409 si cambió la versión, 404 si no existe y 400 si el contrato es inválido. No proporciona validación fiscal externa.

Frontend: botón Verifica fiscal en Acciones. Ctrl + clic abre Yes/No; Yes carga RFC, Código postal, Régimen fiscal, nombre, catálogo de régimen de capital, Otro, Cancelar y OK. La tabla permite desplazamiento. Se muestran los valores originales y el nombre completo a guardar. La separación por el sufijo más largo `, código` y su recomposición son reglas de presentación **derivadas**, comprobadas sólo contra el caso observado; nombres sin coincidencia se conservan completos. Los asteriscos de OMNIS no se reproducen porque su significado sigue pendiente. Act. queda deshabilitado porque su operación no fue capturada.

La UI avisa que los cambios requieren verificación posterior en PROSCAI. A diferencia de OMNIS, abrir no invalida el marcador y OK no genera uno nuevo. Esta entrega no completa la verificación automática.

## Investigación del proveedor (2026-09-14)

La [documentación oficial de PROSCAI](https://ayuda.proscai.com/hc/es-419/articles/13163887156379-Modifica-y-verifica-los-datos-fiscales-de-clientes) describe la validación de datos del receptor ante el SAT, el flujo Ctrl + clic para actualizarlos y errores por RFC no listado, código postal incorrecto o régimen incompatible. También aclara que los asteriscos señalan los regímenes de capital más comunes; esto resuelve su significado general, aunque no el criterio para asignar cada cantidad. El artículo no publica endpoint, autenticación ni algoritmo de CLICFDI4CS. No equivale a un contrato de API.

En la sesión local reconectada SES 20, el clic normal y Ctrl → Yes → OK con datos originales mostraron éxito. El sondeo de sockets IPv4 durante el clic normal sólo observó conexiones locales en OMNIS, SEP y SOP. Su frecuencia aproximada de 20 ms puede perder conexiones rápidas y no cubre IPv6/UDP ni otros procesos: no demuestra ausencia de validación externa o de caché.

Una captura con PktMon durante OK acabó antes de que se confirmara visualmente el resultado; sus cero paquetes no son evidencia concluyente. Los ejecutables SEP contienen referencias a operaciones fiscales y diversos servicios, pero no se ha vinculado ninguno con este botón. No se deben elegir proveedores a partir de cadenas de un binario.

Evidencia local excluida de Git: `captures/network/fiscal-provider/` y `captures/ui/new-version/fiscal-provider/`. Durante esta investigación general_log permaneció OFF; no hay SQL nuevo clasificado como capturado. Para implementar la verificación completa sigue siendo necesario confirmar el contrato del proveedor y la generación del marcador legado.

Prueba negativa en la copia aislada: Ctrl → Yes, código postal temporal `99999` y OK produjeron **00504 - El código postal no corresponde al RFC**. El formulario permaneció abierto; se restituyó el código original y OK mostró éxito. La lectura de control posterior confirmó los seis campos fiscales/de identificación y marcador originales. PktMon, habilitado para todos los componentes durante 15 segundos alrededor del intento inválido, no registró paquetes; sin una prueba positiva de cobertura, esto no identifica ni descarta un servicio externo. Esta observación es evidencia de interfaz, no SQL capturado ni un contrato de proveedor. La API no debe simular esta comprobación limitándose a validar cinco dígitos.

## Validación

`tests/client-fiscal.test.ts` comprueba rutas HTTP, ausencia de escrituras al leer/verificar, actualización parametrizada, marcador pendiente, conservación sin cambios, conflicto, rollback, rechazo de checksum externo y parser del catálogo. También prueba el contrato futuro del proveedor mediante dobles de prueba: éxito parcial sin sincronización legada, rechazo, indisponibilidad, errores saneados y edición durante la petición. No escribe en la base real. Requests: `http/client-fiscal.http`.

Captura finalizada con general_log OFF, MySQL80 Running y configuración restaurada según la evidencia local. La implementación no requiere modificar la configuración de MySQL.
