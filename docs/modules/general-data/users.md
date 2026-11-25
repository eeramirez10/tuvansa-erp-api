# Usuarios y permisos

**Proscai → Datos Generales → Catálogos → Usuarios** abre el catálogo de
TUVANSA México. F10 abre Datos Generales y Ctrl+U abre Usuarios en los
navegadores que entregan el evento. La ruta directa es `/datos-generales/usuarios`.

## Procedencia

La biblioteca German de pruebas contiene el vínculo de Datos Generales
con `INICIO13`. El bloque de **Usuarios (Ctrl+U)** contiene `MCATALOGOS8`,
una llamada a `INICIO/30` y una referencia a `EMAIL#1` (ventana **USUARIOS**).
El registro compilado de la ventana contiene `FUSERS` y las etiquetas
**Encuentra**, **Alta**, **Cambio**, **Anterior**, **Siguiente** y **Reinicia Clave**. REA rechazó el
contenedor Omnis 7 `.LBR`. Se conservaron las referencias de la lectura
binaria y se cotejaron las claves con `FHELP`. La lectura del menú
del runtime Windows confirmó **Proscai → Datos Generales (F10)** y la ficha
**Usuarios** con la columna izquierda de acciones y los datos a la derecha. El procedimiento
`INICIO/30` está exportado en
`captures/ui/omnis7-developer-check/20261123-INICIO30-ACCESOS.txt`.
El alcance de la ficha web es el perfil de cuenta y los permisos por grupo.
Queda pendiente el cotejo de ejecución de los botones nativos en una base aislada.

- **Lectura adaptada de German.** `FUSERS` acotado por `USRMULTICIA IN (0,1)`,
  con `USRBAJA='1900-12-31'` como marca de vigencia. Campos de directorio
  `USRSEQ`, `USRCOD`, `USRNAME` y `USRGROUP`. La API consulta sólo estos
  datos y la pertenencia y vigencia en la búsqueda. La consulta exacta
  agrega los campos de referencia de la ficha y **No ver costos**,
  **No ver saldos** y **Solo ver a sus clientes** desde `USRNOCOSTOS`,
  `USRNOSALDOS` y `USRSOLOEL`. Alta y Cambio guardan las modificaciones de
  cada cuenta en PostgreSQL y las cuentas existentes conservan los valores
  heredados para los campos sin modificación web.
- **Permisos.** La matriz se lee de `FHELP.HKEY, HUSER0…HUSER41` y
  `HVALIDACLAVE`. Los valores web pueden conservar el valor de German,
  concederlo o retirarlo. El grupo 0 requiere un permiso efectivo web como
  los demás grupos. La API verifica que México conserve el modo de visión
  por grupo en `FCIA.CIACOMPORTA[39]`. La solicitud de supervisor devuelve
  acceso denegado.
- **Escritura derivada.** Altas, cambios, activaciones, sesiones y permisos
  locales se registran en PostgreSQL. MySQL es de lectura. El permiso
  `INICIO13` habilita Datos Generales, `MCATALOGOS8` y el rol de
  administrador habilitan Usuarios, y `MPED5` habilita Autorizar en
  Pedidos. Las demás claves están en el catálogo de grupos.

## Restricciones en operación

Los módulos de negocio requieren la sesión del mismo origen y verifican
el perfil vigente en cada petición. La baja desde **Eliminar** revoca
las sesiones de la cuenta y deja el historial disponible.

- **No ver costos.** Oculta columnas e importes de costo y protege las
  consultas con costos o valuaciones. Pedidos conserva su validación de
  precio frente al costo en el servidor.
- **No ver saldos.** Oculta saldos, disponible y límite en las fichas e
  impide abrir los paneles y reportes de saldos.
- **Solo ver a sus clientes.** Usa el clasificador `USRES` y el valor
  `USRPAR`. German compara `mid(fld('CLIPAR',CIAUSRES),2,9)` con
  `CIAUSRPAR`. La API aplica el filtro a Cliente, Pedidos y Facturación,
  incluidos los accesos por identificador y la navegación. Las consultas
  globales con datos de otros clientes requieren una cuenta sin este filtro.
- **Proveedores y capturas.** El clasificador de proveedores se comprueba
  al autorizar una orden de compra o cambiar proveedor desde autorización.
  La API comprueba los límites Del y Al en las fechas de documentos
  enviadas por los módulos de captura.

Los datos de la ficha, incluidos impresora, SIP, observaciones y nómina,
se conservan por perfil. Para conectar **Accesos POS**, **Huellas digitales**,
correo e impresión directa se requieren los servicios y dispositivos
correspondientes.

## Puesta en marcha

Configurar PostgreSQL mediante `NEON_DATABASE_URL` y, en producción, la
URL pública HTTPS en `WEB_SESSION_ORIGIN`. El dominio público debe enviar
`/api/**` a la API antes de aplicar la regla de rutas React. En desarrollo,
Vite usa el proxy local hacia el puerto 3000, configurable con
`ERP_API_PROXY_TARGET`. Configurar el origen explícito si el servidor web
de desarrollo usa un nombre distinto de localhost o una IP no local.

Ejecutar en la API con la conexión del entorno revisada.

```powershell
pnpm users:admin create <USRSEQ> [identificación-web]
```

El comando vincula un registro activo de German, concede al grupo los
permisos de entrada que le falten y entrega un enlace de 24 horas. Dar el
enlace al titular por un canal privado. En desarrollo, abrir la ruta
relativa en el frontend. El administrador puede crear y habilitar cuentas
desde Usuarios. Para recuperar un administrador existente desde la
consola, ejecutar `pnpm users:admin reset <ID web>`. El ID de un usuario
vinculado es `g-<USRSEQ>`.

## API web

| Método | Ruta relativa a `/api` | Operación |
| --- | --- | --- |
| GET, POST, DELETE | `/session` | Consultar, iniciar o cerrar sesión |
| POST | `/session/activation` | Consumir enlace y establecer contraseña |
| GET, POST | `/general-data/users` | Listar o crear cuentas |
| GET | `/general-data/users/:userId` | Consultar la ficha exacta, los valores efectivos y el vencimiento del enlace pendiente |
| PATCH | `/general-data/users/:userId` | Guardar la ficha con su revisión |
| POST | `/general-data/users/:userId/activation` | Emitir enlace y revocar sesiones previas |
| GET, PATCH | `/general-data/permission-groups/:group` | Consultar o cambiar permisos con revisión |

La ficha usa **Encuentra** para ubicar cuentas por código o nombre.
En la lista, `anchor` y `direction` (`previous` o `next`) solicitan un
vecino del usuario seleccionado aplicando los mismos filtros. Ese
resultado incluye su posición en la lista ordenada.

Las sesiones vencen a los 30 minutos de inactividad o a las 8 horas de
iniciadas. La contraseña web debe tener entre 6 y 128 caracteres.
**Restablecer** invalida las sesiones y la contraseña anteriores
al generar el enlace. La gestión de cuentas y permisos usa el actor de
la sesión y conserva los cambios en `tuvansa.web_access_changes`.
