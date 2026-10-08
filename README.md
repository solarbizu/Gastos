# Gastos

Formulario para cargar gastos e ingresos desde el celular y ver el tablero del mes. Es la mitad pública de un sistema de finanzas personales: este repositorio tiene **solo el formulario**, sin ningún dato.

## Cómo funciona

- Es una página estática: HTML, CSS y JavaScript, sin servidor y sin dependencias.
- Cada carga se guarda como un archivo JSON en la carpeta `inbox/` de un repositorio privado de GitHub, usando la API de GitHub y una llave (token) que se escribe una sola vez y queda guardada solo en el navegador de ese teléfono.
- Si no hay señal, la carga queda en cola en el teléfono y se envía sola cuando vuelve.
- La pestaña Tablero muestra el archivo `reportes/tablero.html` del repositorio privado.

## Seguridad

- La llave nunca sale del teléfono salvo hacia `api.github.com`. La política de seguridad de la página (CSP) impide conectarse a cualquier otro sitio y ejecutar código que no sea `app.js`.
- Usá una llave de tipo *fine-grained*, con acceso a un único repositorio y solo el permiso **Contents: Read and write**.
- La app se niega a conectarse a un repositorio público.
- "Desconectar este teléfono", en Ajustes, borra la llave y todo lo guardado en el navegador.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html`, `app.css`, `app.js` | La app |
| `sw.js`, `manifest.webmanifest`, íconos | Para instalarla en la pantalla de inicio y que abra sin señal |
| `fonts/` | Tipografías Instrument Sans y Azeret Mono (licencia SIL OFL 1.1) |

Si cambiás algún archivo, subí el número de `CACHE` en `sw.js` para que los teléfonos tomen la versión nueva.
