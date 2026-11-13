# Arquitectura e invariantes

## Flujo de datos

`CSV -> dominio -> repositorio -> modelo -> presentación -> DOM/PDF`.
`app.js` coordina los casos de uso y mantiene referencias a modelos inmutables.
Los formularios capturan el modelo con el que se abrieron. Un cambio externo
invalida su guardado y exige volver a abrirlos, también si no cambia la revisión.

`domain.js` no depende del DOM ni del almacenamiento. Valida identidades,
fechas civiles, valores finitos, coherencia de masa y actividad, agrupaciones y
semividas. `measurements.js` genera las mismas mediciones y detalles para todas
las salidas. `view.js` y `report.js` crean nodos con `textContent`.

## Cálculos y normalización

La fórmula, la convención de año de 365,242198 días, las semividas iniciales y
los 27 registros originales se conservan. No se añade propagación de
incertidumbre de masa ni de semivida porque no hay datos certificados para ello.
El modelo no representa cadenas de desintegración.

Se admite decimal con punto o coma y notación científica. No se interpreta
hexadecimal, booleanos, listas ni texto como cantidades. Un campo opcional
inválido se rechaza, en lugar de tratarse como ausencia de dato. Las cantidades
derivadas y los factores se comprueban frente a desbordamientos y
subdesbordamientos. El formato persistido usa la representación de ida y vuelta
de JavaScript, sin redondear previamente a 15 cifras significativas.

`Bq = Bq/g * masa` usa la tolerancia relativa existente del 0,5 %; no se aplica
un umbral absoluto que permita discrepancias grandes en actividades pequeñas.
Todos los radionuclidos de una muestra comparten su masa. Se deriva una
incertidumbre total o específica solo cuando se ha proporcionado la otra.

Un registro histórico con fecha desconocida puede editarse conservándola
vacía. Sigue siendo no calculable. Una nueva fuente requiere fecha. El editor
conserva el descriptor metrológico original si no se ha modificado su texto.

El formato visual utiliza notación científica si una cantidad positiva quedaría
redondeada a cero, también en masas pequeñas. Esto no cambia el valor guardado.

## Persistencia y recuperación

Se conserva el esquema 2 y las claves existentes. El repositorio lee antes de
decidir si el almacenamiento es utilizable: que una cuota esté llena no debe
ocultar datos legibles. Si la lectura está bloqueada se utiliza memoria, con
aviso permanente y exportación de la sesión disponible.

Si una lectura falla después de resolver el almacenamiento, se bloquean las
escrituras de esa sesión: un error de permisos no equivale a una clave ausente.
La exportación conserva el modelo visible y advierte si no pudo leer todas las
claves. Una historia de recuperación con entradas inválidas se conserva sin
intentar repararla destructivamente. El contador de revisiones no puede superar
el mayor entero seguro de JavaScript.

Cada guardado compara revisión y contenido observado. Antes de sustituir un
estado válido se escribe una copia válida. Un error al escribir la copia
cancela el guardado. La recuperación no elimina esa copia ni la sustituye por
contenido corrupto. Primero archiva las cadenas originales en la clave de
recuperación; si no puede preservarlas, no sobrescribe el original.

Un esquema futuro queda protegido contra escritura. El borrado del estado y
los eventos `storage` con clave nula también se detectan. La exportación JSON
incluye tanto el modelo visible como las cadenas originales de las claves
operativas y de recuperación. No se envía a ningún servidor.

Los guardados y recuperaciones de la aplicación se ejecutan bajo Web Locks.
Cuando esa API falta se usa una transacción exclusiva de IndexedDB. Si ninguna
opción está disponible en un almacenamiento persistente, se impide la escritura
y se ofrece exportar. El método síncrono `save` es interno; los casos de uso
deben invocarlo mediante `withWriteLock`. Versiones antiguas abiertas no
participan necesariamente en estos bloqueos: conviene actualizarlas todas.

Referencias: [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
y [transacciones IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction).

## Publicaciones offline

`scripts/release.mjs` genera el inventario de recursos y sus SHA-256. El worker
descarga y valida todos los recursos antes de escribirlos, y solo completa su
instalación cuando termina la caché. Una publicación incompleta o mezclada se
rechaza. Las huellas comprueban coherencia de la publicación; no sustituyen TLS
ni constituyen una firma del proveedor.

`.gitattributes` fija LF en los archivos de texto para que las huellas coincidan
entre Windows, el commit y GitHub Pages. Las imágenes, fuentes y copias ZIP
conservan sus bytes binarios. Se comprueban también los recursos del índice Git
antes de publicar.

Las descargas de reparación tienen un límite de 15 segundos y se cancelan si
el servidor no responde. Comprobar o reparar una caché íntegra sin conexión no
la marca como dañada solo porque falle la búsqueda de actualizaciones de red.

La navegación comprueba presencia e integridad del shell. Ante corrupción
intenta repararlo con conexión; offline utiliza una publicación anterior
completa con metadatos verificables o presenta una página de recuperación.
Las cachés de v48 y anteriores carecen de esos metadatos y no se usan como
recuperación automática del shell. Sus recursos exactos siguen disponibles para
las pestañas antiguas mientras se conservan sus cachés.

La activación mantiene las cachés antiguas mientras hay clientes abiertos.
En una activación sin clientes, se conserva la versión actual y una anterior.
Solo se eliminan nombres de caché propios. Un recurso de una versión anterior
ausente no se sustituye por el código actual del servidor. Una falta de cuota
para reparar un recurso no impide devolver la respuesta verificada de red.
Ninguna operación del service worker modifica localStorage.

La actualización necesita aceptación y se pospone si hay un diálogo, un
guardado o una generación PDF activos. Las otras pestañas conservan su estado.
`pwa.js` busca actualizaciones al arrancar y al pulsar el botón de búsqueda.
Espera a que el worker termine la instalación y comprueba los recursos antes
de ofrecer **Actualizar y reiniciar**. **Más tarde** oculta el aviso durante esa
sesión. Una búsqueda manual o un nuevo arranque vuelve a ofrecer la versión.
La búsqueda tiene un límite de 30 segundos y deja el botón disponible para
reintentar. Las búsquedas repetidas se agrupan mientras hay una en curso.
El estado de actualización se muestra separado del estado de la caché offline.

El permiso solo autoriza el reinicio de la pestaña que lo acepta. Se vuelve a
comprobar si está ocupada cuando cambia el controlador, porque se puede abrir
un formulario durante la activación. Si otra pestaña activó la versión nueva,
el aviso ofrece recargar esta pestaña con el mismo permiso y comprobaciones.
La instalación PWA, el envío real por Web Share y los permisos del sistema
requieren validación final en los dispositivos de destino.

Referencia: [ciclo de vida de Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers).

## PDF, etiquetas e impresión

Se conserva A4 horizontal, tres columnas, secciones separadas por categoría,
tipografías, logotipos y colores corporativos. El inventario inicial ocupa tres
páginas. Una estimación inicial distribuye las tarjetas; si el contenido real
desborda, se miden sus alturas y se vuelve a paginar. Los grupos demasiado altos
se dividen por registros con un encabezado de continuación, sin reducir letra.
Las etiquetas incluyen actividad actual, incertidumbre o límite, unidades,
masa e información metrológica, con cantidad configurable y un límite explícito
de 1000 por archivo para evitar agotar la memoria del dispositivo.

`labels.js` repite referencias a grupos sin modificar el inventario y reutiliza
la composición del informe. La selección, los isótopos y la fecha se capturan
antes de cualquier espera: PDF y texto compartido pertenecen al mismo modelo
aunque otra pestaña guarde cambios durante la generación.

Cada página se rasteriza por separado a escala 2 con html2canvas y se incorpora
a jsPDF. CSS, imágenes y tipografías se incrustan en el documento de captura:
el iframe `about:blank` de html2canvas puede carecer de controlador service
worker y perder esos recursos offline aunque la página principal sí los tenga.
La CSP admite fuentes `data:` para esta copia local y sigue excluyendo fuentes
externas. El capturador comprueba que se conservan dimensiones y tres columnas;
la prueba offline comprueba píxeles del logotipo. Se libera el lienzo antes de
capturar la siguiente. Un fallo conserva
el diálogo, muestra cómo actuar y limpia el escenario de captura. El PDF es
rasterizado: conserva la presentación, pero no ofrece texto seleccionable ni
estructura accesible. La pantalla HTML proporciona la alternativa textual.

El archivo preparado se reutiliza dentro del diálogo. Web Share puede necesitar
una segunda pulsación porque requiere activación transitoria del usuario;
véase [Navigator.share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share).
La impresión del navegador usa el mismo documento paginado y una hoja de estilo
específica. Se siguen comprobando los diálogos nativos en dispositivos físicos.

## Pruebas y mantenimiento

`npm test` comprueba sintaxis, huellas de publicación, dominio, datos, repositorio,
worker aislado y navegador. La auditoría usa perfiles temporales de Playwright;
nunca abre ni borra el perfil habitual del usuario. Las simulaciones de fallos
se aíslan por contexto y el servidor de pruebas se inicia en un puerto libre.
Las pruebas de motor no equivalen a certificación de un dispositivo físico.

Las copias del proyecto están en `.backups/`. Ni las copias, ni los scripts,
ni las pruebas se publican mediante el servidor incluido.
