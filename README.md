# Cálculo de decaimientos

PWA local de Aplicaciones Tecnológicas para calcular la actividad de fuentes
puntuales y material contaminado en una fecha elegida. La aplicación conserva
los datos en el navegador, funciona sin conexión después de la primera carga y
genera directamente un informe PDF A4 horizontal, descargable y compartible.

## Puesta en marcha

En PowerShell, desde esta carpeta:

```powershell
powershell -ExecutionPolicy Bypass -File .\server.ps1 -Port 8080
```

Después abre `http://127.0.0.1:8080/`. No abras `index.html` directamente: los
módulos JavaScript, el almacenamiento PWA y el service worker necesitan HTTP o
HTTPS. Para usarla desde otros dispositivos se debe publicar mediante HTTPS.

## Funcionamiento

La actividad se calcula con:

```text
A(t) = A0 * 2^(-(t - t0) / T1/2)
```

- Las fechas se tratan como fechas civiles, con resolución de un día y sin
  conversiones de zona horaria.
- Para semividas expresadas en años se usa `1 a = 365,242198 d`, conforme a la
  convención de la Monographie BIPM-5.
- Las incertidumbres indicadas en los certificados y los límites superiores se
  escalan con el mismo factor de decaimiento. La aplicación no crea una
  incertidumbre cuando el documento de referencia no la proporciona.
- Las tolerancias de valores nominales se identifican como tales; no se
  presentan como incertidumbres metrológicas simétricas.
- Para material contaminado se comprueba que `Bq = Bq/g * masa` dentro de una
  tolerancia del 0,5 %.
- Un registro sin fecha de referencia se conserva, pero se muestra como no
  calculable.

Las semividas de partida están en `isotopos.csv` y proceden de DDEP-LNHB. El
inventario original está en `inventario_radiactivo.csv`. Estos ficheros solo
sirven como datos iniciales o de recuperación; la edición cotidiana se realiza
desde los menús de la aplicación.

## Arquitectura

La implementación no usa un framework ni servicios externos de ejecución. Los
recursos necesarios, incluido el motor de generación del PDF, se sirven desde
la propia aplicación para mantener el funcionamiento sin conexión:

- `index.html`: estructura semántica y formularios accesibles.
- `styles.css`: diseño responsive, identidad corporativa, informe A4 horizontal e impresión.
- `app.js`: coordinación de eventos y casos de uso.
- `src/domain.js`: validación, agrupación y cálculo científico puro.
- `src/measurements.js`: interpretación y formato metrológico compartidos por pantalla, PDF y etiquetas.
- `src/repository.js`: persistencia versionada, copia de seguridad, migración y
  detección de conflictos entre pestañas.
- `src/csv.js`: lector CSV estricto para los datos iniciales.
- `src/view.js`: renderizado seguro mediante nodos DOM y `textContent`.
- `src/report.js`: documento HTML interno e información para compartir. El HTML
  intermedio no se muestra al usuario.
- `src/pdf.js`: conversión local de cada página HTML a PDF y descarga del archivo.
- `src/report-layout.js`: medición real de tarjetas y redistribución de contenido extenso.
- `src/pwa.js`: instalación, estado offline, reparación y aceptación de actualizaciones.
- `sw.js`: caché offline versionada y actualización controlada por el usuario.
- `precache-manifest.js`: lista generada de recursos con sus huellas SHA-256.
- `manifest.webmanifest`: instalación PWA e iconos.
- `dev_server.py` y `server.ps1`: servidor local restringido a recursos públicos.

El estado persistido conserva el esquema 2 y la clave `calculo-decaimientos.state.v1`. Antes de
cada modificación se mantiene una copia válida en
`calculo-decaimientos.backup.v1`. Si el estado principal está dañado, se intenta
recuperar la copia; si tampoco es válida, se restauran los datos originales.
Las claves de la versión anterior se migran automáticamente. Antes de persistir
una migración o recuperación se archivan las cadenas originales, incluso si no
son JSON válido, en `calculo-decaimientos.recovery.v1`. Si no hay espacio para
esa copia, la aplicación evita sobrescribir los datos existentes.

El botón **Guardar copia** descarga el modelo actual y las claves de estado,
copia, recuperación y compatibilidad en un JSON. Guarda ese archivo fuera del
navegador. No hay importación automática de JSON: una recuperación manual debe
validar `model` con el repositorio y conservar primero el estado anterior.

En **Generar informe**, elige **Etiquetas de actividades** para generar entre
1 y 100 etiquetas por elemento, con un máximo de 1000 por archivo. Puedes
limitar la selección mediante búsqueda, filtro y **Incluir solo los elementos
visibles**. No se presupone un tamaño de papel adhesivo concreto.

## Alcance del funcionamiento offline

La aplicación no necesita Internet para calcular, editar el inventario ni
generar, descargar o preparar para compartir el PDF. No carga fuentes, imágenes,
scripts ni librerías desde CDN: todos esos recursos están incluidos en este
proyecto. Las direcciones web conservadas en `isotopos.csv` son referencias de
procedencia y la aplicación no las consulta automáticamente.

La instalación del service worker solo se completa cuando HTML,
CSS, módulos, CSV, tipografías, logotipos, iconos, `html2canvas` y `jsPDF` están
guardados en la caché local y sus huellas coinciden con la publicación.
El estado **Lista para usar sin conexión** confirma esa comprobación. Después de esa primera carga completa, la PWA y el
informe funcionan con la conexión desactivada.

Si faltan recursos o se detecta contenido corrupto, **Reparar modo offline**
los vuelve a descargar con conexión. Si la aplicación no puede arrancar offline,
presenta una página de recuperación; no borres los datos del sitio. El código
de una pestaña anterior conserva su propia caché durante una actualización.

Hay dos límites inevitables:

- La primera entrega debe llegar al navegador desde algún origen HTTP/HTTPS. Si
  se usa `server.ps1` en el mismo equipo, ese origen es local y no requiere
  Internet; si la PWA se publica en un servidor remoto, la primera carga sí
  necesita acceso a ese servidor.
- Generar y descargar el PDF es offline. Compartirlo con otra aplicación depende
  del sistema operativo y, para completar el envío, de la conectividad que
  necesite la aplicación de destino.

## Pruebas

Requisitos: Node.js 20 o posterior y Python 3.

```powershell
npm install
$env:PLAYWRIGHT_BROWSERS_PATH='0'
npx playwright install chromium firefox webkit
npm test
```

La batería inicia y detiene su propio servidor local en un puerto libre.
Para usar un servidor existente, define `APP_URL`. Incluye sintaxis, integridad
de publicación, fórmula de decaimiento, fechas, validación de
actividad y masa, integridad de los 27 registros, recuperación del
  almacenamiento, CRUD, búsqueda y filtros, informe PDF A4 vertical, modo sin conexión,
accesibilidad básica, desbordamientos responsive y una matriz en Chromium y
WebKit. Cuando están instalados, también se ejecuta una comprobación en Google
Chrome y Microsoft Edge. Firefox se intenta por defecto con un límite de
arranque; en este equipo su ejecutor de Playwright queda bloqueado y se registra
como no disponible. `RUN_FIREFOX=0` omite ese intento. Un fallo funcional en un
navegador que sí arranca se registra como fallo, nunca como prueba no disponible.

Las pruebas de fallos cubren cuotas, almacenamiento bloqueado, esquemas futuros,
recuperación sin pérdida de copias, escrituras simultáneas, alternativa IndexedDB,
APIs opcionales ausentes, CSV inaccesibles, caché dañada, etiquetas offline y
agrupaciones que necesitan dividir una tarjeta en continuaciones.
Los resultados y muestras visuales se generan en `tests/output/`, un directorio
privado que no se sirve desde la aplicación.

## Compatibilidad y límites conocidos

La aplicación se diseña y prueba para versiones actuales de Chrome, Edge,
Firefox y Safari/WebKit, incluidos anchos de Android, iPhone y iPad. No existe
una implementación web que pueda garantizar literalmente todos los navegadores
históricos.

- La instalación PWA y el botón de instalación dependen de las capacidades del
  navegador. En iOS/iPadOS se instala desde el menú Compartir del sistema.
- Web Share y el acceso directo al portapapeles requieren soporte y permisos
  del navegador; la alternativa descarga el PDF y usa la copia clásica.
  Si generar el PDF consume la activación del gesto del usuario, se pide pulsar
  Compartir de nuevo sobre el archivo ya preparado, sin repetir la generación.
- Los datos están ligados al perfil, origen y navegador. Borrar los datos del
  sitio o usar navegación privada puede eliminarlos; no existe sincronización
  con servidor ni copia externa automática.
- El servidor incluido es solo para uso local y no incorpora autenticación. En
  una publicación de red, el inventario inicial queda accesible para quien pueda
  abrir la aplicación; si la información es sensible, el alojamiento HTTPS debe
  añadir control de acceso y una política de dispositivos autorizados.
- La descarga del PDF se genera localmente sin enviar inventario ni resultados
  a un servidor. Compartir o enviar el fichero sigue dependiendo de las
  capacidades y permisos del navegador y del sistema operativo.
- WebKit de Playwright aproxima Safari, pero no sustituye una prueba final en un
  iPhone o iPad físico.
- El ejecutor Firefox 157 de Playwright no completa el arranque en este Windows.
  La aplicación evita APIs exclusivas de Chromium, pero queda pendiente una
  comprobación final en una instalación física de Firefox.
- Compartir, instalar y elegir el destino de descarga depende de los diálogos
  del sistema; sus perfiles se prueban de forma automatizada, pero el
  flujo completo requiere una comprobación en cada dispositivo físico objetivo.
- El cálculo aplica decaimiento exponencial independiente a cada isótopo. No
  modela cadenas de desintegración, crecimiento de descendientes ni equilibrio
  secular o transitorio.
- El informe se compone primero como HTML interno y se convierte localmente a
  PDF A4 horizontal, sin abrir una vista previa. Las fuentes puntuales y las
  muestras contaminadas se agrupan en secciones separadas, con tres columnas y
  una tarjeta independiente por elemento. Para mantener la misma
  composición offline en todos los motores, cada página se rasteriza localmente
  a doble resolución: el PDF se imprime con nitidez, pero su texto no es
  seleccionable, buscable ni etiquetado para lectores de pantalla.
- La herramienta realiza cálculo de decaimiento, no una evaluación de seguridad
  radiológica ni una certificación metrológica.

## Criterios de seguridad y mantenimiento

Los datos editables nunca se insertan como HTML. El servidor aplica una política
CSP restrictiva, desactiva el listado de carpetas y no publica la copia de
seguridad ni los ficheros de desarrollo. El service worker solo elimina cachés
propias, mantiene cada versión de código y datos como una unidad coherente y
espera confirmación antes de activar una actualización.

Para publicar una nueva versión, ejecuta `node scripts/release.mjs 50` (sustituye
50 por un número superior al actual) y después `npm test`. El script sincroniza
versiones de módulos, recursos, manifiesto, service worker y paquetes, y regenera
las huellas. Publica todos los recursos juntos; no reutilices una versión ya
distribuida. `npm run release` regenera la publicación durante desarrollo y
`npm run test:release` detecta cambios que no se hayan incorporado a sus huellas.
Al cambiar el formato persistido, añade una migración antes de incrementar
`SCHEMA_VERSION`.

Consulta `docs/ARCHITECTURE.md` para las invariantes y las decisiones de
recuperación, concurrencia, caché y paginación.
