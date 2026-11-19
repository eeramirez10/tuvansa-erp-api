# Inspeccionar PROSCAI.LBS desde otro servidor

El objetivo es identificar las clases y métodos de una acción de PROSCAI, contrastarlos con el código ya publicado y guardar evidencia para migrar esa función. Esta guía parte de una biblioteca que el servidor destino permite abrir con Omnis Studio y de dos repositorios Tuvansa ya clonados. Si el destino solo tiene el runtime, sigue la ruta de observación en [REA-START-HERE](REA-START-HERE.md).

## 1. Actualizar los repositorios

Revisa `git status --short --branch` en ambos repositorios antes de cambiar de rama. Si hay trabajo local, usa un checkout separado. Desde el backend limpio, ejecuta:

```powershell
git fetch origin
git switch --track origin/docs/proscai-lbs-handoff
git pull --ff-only
git log -1 --oneline
```

Si la rama ya existe en local, usa `git switch docs/proscai-lbs-handoff`. En el checkout limpio del frontend ejecuta `git switch main`, `git pull --ff-only origin main` y `git log -1 --oneline`. Registra las ramas y los SHA de ambos. La publicación de referencia para esta guía es el backend `12231bf` más el commit de documentación de esta rama, y el frontend `aed0a36`. Si el remoto avanzó, registra el commit que efectivamente descargaste y comprueba las rutas del módulo.

El mapa de cobertura enlaza los módulos y su documentación publicada. Las modificaciones locales de Pedidos (tipos XA/P, Duplicar y selección de productos) y de las comisiones de Cancún del servidor anterior siguen pendientes de revisión y publicación. Los archivos `captures/`, las bibliotecas, los árboles exportados, los datos y los secretos se mantienen locales. [Mapa de módulos y cobertura](REA-MODULE-MAP.md)

## 2. Preparar las herramientas

| Para qué | Herramientas y versiones verificadas en el servidor anterior |
| --- | --- |
| Exportar el código de una biblioteca | Omnis Studio 10.22 build 31896. Verifica la versión del destino y que su edición exponga **Export Lib to JSON…**. |
| Conectar REA al agente | Node.js 24.13.1 con npm/npx y `rea-agents@6.7.0`. |
| Ejecutar Tuvansa | pnpm 11.24.0 en ambos repositorios. Confirma `packageManager` antes de instalar. |
| Automatizar pantallas de Windows | Python 3.12.10, pywinauto 0.6.9, Pillow 12.3.0 y pywin32 312. Para validar los JSON basta Python estándar. |
| Analizar ejecutables y DLL de Omnis | Ghidra 12.1.4 y un JDK de 64 bits. Aquí se usó OpenJDK 21.0.13+9. Instálalos si la investigación necesita un proveedor nativo de REA. |

Instala [Node.js](https://nodejs.org/dist/v24.13.1/) y [Python](https://www.python.org/downloads/release/python-31210/) desde sus sitios oficiales si hacen falta. Verifica `node --version`, `npm --version`, `pnpm --version` y `py -3.12 --version`. Para instalar pnpm con la versión de referencia, usa `npm install --global pnpm@11.24.0`. Desde cada raíz de Tuvansa, ejecuta `pnpm install --frozen-lockfile` cuando vayas a validar o levantar esa aplicación.

### Conectar REA

Desde PowerShell, para Codex:

```powershell
npx -y rea-agents@6.7.0 doctor --client codex --format json
npx -y rea-agents@6.7.0 setup --client codex --dry-run --format json
```

Si falta el registro MCP o necesita corregirse, revisa las rutas y los cambios del plan y aplica el mismo alcance con `npx -y rea-agents@6.7.0 setup --client codex --yes`. Para otro cliente, consulta `doctor --help` y `setup --help` y usa su identificador. Reinicia o reconecta el cliente y comprueba que el agente enumere herramientas de REA, por ejemplo `inspect_pe_resources` para un archivo PE. Si `doctor` confirma el registro y el agente sigue sin herramientas, revisa el error de arranque de MCP en el cliente. Para tareas que tengan equivalente en CLI puedes usar `npx -y rea-agents@6.7.0 --help`. [Paquete REA](https://www.npmjs.com/package/rea-agents/v/6.7.0)

### Automatización de ventanas y análisis nativo

Para automatizar el escritorio, usa una sesión Windows interactiva. Desde el backend:

```powershell
py -3.12 -m venv captures/omnis-venv
$python = '.\captures\omnis-venv\Scripts\python.exe'
& $python -m pip install pywinauto==0.6.9 Pillow==12.3.0 pywin32==312
& $python -c "import pywinauto, PIL, win32gui; print('Importaciones Windows OK')"
```

Para analizar binarios, instala el JDK y extrae Ghidra en una ruta local. Define `JAVA_HOME` con la raíz del JDK y `GHIDRA_INSTALL_DIR` con la raíz de Ghidra en el entorno desde el que arranca REA. Verifica `& (Join-Path $env:JAVA_HOME 'bin/java.exe') -version` y `Test-Path (Join-Path $env:GHIDRA_INSTALL_DIR 'support/analyzeHeadless.bat')`. Usa `npx -y rea-agents@6.7.0 providers --format json` para confirmar que figure Ghidra. Si probaste las variables en una terminal, reinicia el cliente desde un entorno donde también estén disponibles. Haz la primera prueba sobre un PE pequeño y una función concreta. [Ghidra 12.1.4](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1.4_build) · [JDK Temurin 21](https://adoptium.net/temurin/releases/?version=21)

La vía para leer los métodos de la biblioteca es la exportación nativa de Omnis. En el servidor anterior, REA devolvió `file_format_rejected` al abrir tanto `PROSCAI.LBS` como una biblioteca de ejemplo de Omnis. Ghidra pudo analizar funciones nativas de `omnis.exe` y una DLL. Esa evidencia corresponde al motor.

## 3. Exportar la copia de PROSCAI.LBS

1. Registra la versión y build de Omnis Studio, la ruta local de la biblioteca autorizada y su SHA-256. Con la biblioteca fuera de uso, crea una copia con el mismo nombre en `captures/omnis-lbs/input/` y compara el SHA-256 de ambos con `Get-FileHash -LiteralPath <ruta> -Algorithm SHA256`. Si la biblioteca activa está bloqueada, coordina una copia en reposo o usa una copia de desarrollo ya disponible.
2. Abre Studio y confirma que la sesión de prueba no cargó el ERP original. En **Studio Browser → Libraries → Open Library**, selecciona la copia. Mantén **Alt** al abrirla en Windows para omitir su tarea de arranque.
3. Selecciona el nodo de la biblioteca y pulsa **Export Lib to JSON… → Export…**. Elige una carpeta vacía bajo `captures/omnis-lbs/export/`. Omnis crea una subcarpeta con el nombre de la biblioteca. Usa una exportación nueva para conservar la evidencia de intentos anteriores.
4. Verifica el mensaje de éxito y la presencia de `library.json`, `class.json`, `methods.json` y métodos `.omh` legibles. Al terminar, compara el SHA-256 del original con el del inicio y registra los resultados.

Si el navegador indica `The library is always private and cannot be opened by the browser`, guarda el mensaje. Busca una copia de desarrollo autorizada o un árbol JSON que el proveedor ya haya generado. Si la biblioteca aparece pero falta la opción de exportar, registra la edición y sigue el manual de Omnis. Con la biblioteca de ejemplo `listboxes.lbs`, Omnis 10.22 produjo 72 JSON válidos y 31 archivos `.omh`. En el servidor anterior, la biblioteca desplegada de PROSCAI se declaró privada incluso con una sola instancia de Studio. [Exportación de bibliotecas](https://www.omnis.net/developers/resources/onlinedocs/Programming/02libsandclasses.html#exporting-libraries-to-json) · [Atajos de Studio](https://www.omnis.net/developers/resources/onlinedocs/Programming/01omnistools.html#shortcut-keys-and-mouse-usage) · [Bibliotecas privadas](https://www.omnis.net/developers/resources/onlinedocs/Programming/03programming.html#private-libraries)

Para validar el árbol local, ajusta la ruta de salida al nombre que Omnis creó:

```powershell
$tree = (Resolve-Path -LiteralPath 'captures/omnis-lbs/export/PROSCAI').Path
@'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
if not (root / "library.json").is_file():
    raise SystemExit("Falta library.json")
json_files = list(root.rglob("*.json"))
methods = list(root.rglob("*.omh"))
for file in json_files:
    with file.open(encoding="utf-8-sig") as stream:
        json.load(stream)
if not methods:
    raise SystemExit("El resultado no contiene archivos .omh")
print(f"Archivos JSON: {len(json_files)}. Archivos .omh: {len(methods)}.")
'@ | py -3.12 - $tree
```

## 4. Primer ejercicio para el agente

Usa **Pedidos → Duplicar** para documentar cómo una cotización XA pasa a un pedido P. Empieza por el código exportado. Mantén el ejercicio de escritura en OMNIS para una prueba posterior con base aislada y autorización explícita.

1. Busca el texto visible en `object.json`, `class.json` y las cadenas exportadas. Usa `rg -n -i -g '*.json' -g '*.omh' 'Duplica Pedido|FTIPMV|FPENC|FPLIN' $tree` como punto de partida. Confirma la clase por el objeto y su etiqueta visibles.
2. Ubica el `$event.omh` del control y su evento `On evClick`. Usa `methods.json` para los parámetros y variables. Sigue las llamadas hacia los métodos de destino y anota rutas y líneas. Si una llamada se resuelve dinámicamente, deja pendiente esa relación hasta tener evidencia.
3. Registra dónde se elige el tipo, cómo se obtiene el consecutivo, qué datos se copian, qué validaciones se ejecutan y cuándo se guardan los cambios. Comprueba el encabezado, las partidas y los comentarios en los contratos del backend y en la pantalla React. [Pedidos en la API](modules/sales/orders.md) · [Captura publicada del alta](modules/sales/orders-create-sql-new-version.md)
4. Marca los hallazgos del fuente como **observación estática**. Un SQL armado por el código necesita una captura del hilo OMNIS para etiquetarse como `capturada`. Usa `adaptada` para una consulta equivalente basada en una captura y `derivada` para una consulta nueva de la API. Si hace falta ejecutar el ejercicio, aplica el runbook, captura una acción por intervalo y verifica `general_log=OFF` al final. [Captura SQL](REA-SQL-CAPTURE.md)

El primer resultado debe incluir versión y SHA-256 de la biblioteca, versiones de herramientas, ramas y commits, recuentos de la exportación y al menos una clase y un método legible del flujo con ruta y línea. Separa las diferencias verificadas de las preguntas pendientes. Guarda el árbol y el código exportado localmente, y comparte en Git un resumen sin datos sensibles. [Ficha por acción](REA-WORK-RECORD.md)

## Mensaje para el agente del otro servidor

```text
Lee los AGENTS.md de ambos proyectos, docs/REA-START-HERE.md y
docs/REA-OMNIS-LBS.md del backend. Usa .agents/skills/proscai-rea/SKILL.md.
En este servidor hay una biblioteca de PROSCAI que podemos abrir en Omnis.
Identifica su versión, prepara REA y exporta una copia a captures/.
Valida los JSON y localiza la clase y el método de Pedidos → Duplicar
para convertir una cotización XA en un pedido P. Compara ambos proyectos
y reporta las reglas observadas, su evidencia y cualquier dato pendiente.
Conserva privado el código exportado. Este ejercicio empieza con lectura.
```
