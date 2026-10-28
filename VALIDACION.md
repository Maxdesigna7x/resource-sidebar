# Validación de Resource Sidebar 3 · 28 de octubre de 2026

## Entorno y método

Zorin OS 18.1, GNOME Shell 46, Wayland y hardware real del usuario. Pruebas en un compositor GNOME 46 separado, modo `user`, monitor virtual 1280 × 900, wallpaper del usuario y configuración de prueba independiente con backend `keyfile`.

Una copia temporal de prueba habilitó evaluación JavaScript para inspeccionar geometría, crear dispositivos de entrada virtuales, mover una ventana GTK real y capturar imágenes. Esa modificación no está en el código entregado ni instalado. La sesión principal conserva sus restricciones normales de evaluación.

## Medidas

| Elemento | Medición al 100 % de escala |
| --- | --- |
| Compacto | 44 × 213 px |
| Grande | 156 × 293 px con las lecturas observadas |
| Gráfica grande | 60 × 24 px |
| Gráfica compacta | 26 × 13 px |
| Separación entre gráfica y valores | 6 px en las cinco filas |

El ancho grande se calcula a partir de las anchuras naturales de los textos, con un mínimo de 156 px. Puede crecer si una lectura necesita más espacio; las pruebas comprueban que los textos quedan dentro del margen derecho. En la versión 2 eran 196 px: se recortaron 40 px sin reducir la altura ni quitar métricas.

Las capturas de detalle se generaron directamente mediante `Shell.Screenshot.screenshot_area`, sin redimensionar ni reconstruir el panel.

## Pruebas funcionales aprobadas

Se usaron eventos de ratón virtual reales sobre la interfaz, no solo llamadas directas a los cambios de estado:

1. Con una ventana GTK situada lejos del borde, el cursor en un punto de escritorio expuesto abre el compacto.
2. Clic en una métrica: cambia a grande y la preferencia `pinned` permanece en `false`.
3. Retirar el cursor de ese grande sin anclar lo oculta. Volver al borde recupera el tamaño grande.
4. Clic en el fondo de la cabecera: cambia a compacto sin anclar.
5. Clic en la chincheta del compacto: ancla el compacto sin expandirlo.
6. Cambiar compacto → grande → compacto estando anclado conserva el anclado.
7. Retirar el cursor de un compacto anclado lo mantiene visible.
8. Desactivar y activar la extensión conserva compacto + anclado.
9. Soltar el compacto y retirar el cursor lo oculta.
10. Mover la ventana para cubrir solo la parte inferior de la banda: el punto superior abre; el punto inferior cubierto no abre y permite la ocultación del panel temporal.
11. Mover la ventana para cubrir el punto superior también: no abre por hover.
12. Shift + Espacio funciona sobre esa ventana y a pantalla completa, respetando el tamaño recordado.
13. Ocultar y volver a mostrar mediante teclado no cambia la preferencia de anclado.
14. Desactivar y activar conserva grande + anclado.
15. Las etiquetas de disco empiezan por `R` y `W`.
16. No se registraron errores de extensión ni errores JavaScript en la prueba final.

La detección local consulta el cursor cada 80 ms y contrasta el punto con los marcos de las ventanas visibles del espacio activo. Ya no hay un actor transparente sobre el borde que intercepte eventos destinados a aplicaciones.

El lector Python no se modifica en esta versión. Se conservan las pruebas de regresión de métricas y el comportamiento del atajo previamente validado. Las nuevas preferencias separan `expanded` y `pinned`; solo la chincheta cambia el anclado durante el uso de la interfaz.

## Instalación y límites

El instalador respalda la versión anterior, copia la versión 3, compila el esquema con la nueva preferencia `expanded` y conserva las demás extensiones. Los archivos instalados se cotejan con los entregados.

**Para cargar el nuevo JavaScript se necesita cerrar sesión y volver a entrar.** No se cerró la sesión automáticamente; el escritorio activo conserva la versión importada hasta entonces. Las pruebas descritas se realizaron en el compositor aislado con el hardware real.

No se validaron físicamente otras versiones de GNOME, otros escritorios, múltiples monitores, escalado fraccional, escalado de texto diferente, GPU AMD o sistemas de disco raíz complejos. Los marcos de ventanas se tratan como rectángulos opacos a efectos de activar el hover; no se intenta detectar transparencia por píxel.


## Actualización 3.1 · Shift + Alt

Se cambió el atajo predeterminado a `['<Shift>Alt_L', '<Alt>Shift_L', '<Alt>Shift_R']`, sin modificar el código de la interfaz. Alt izquierdo más Shift, en cualquier orden, activa el panel; también se admite Shift derecho. AltGr queda libre.

Se comprobaron las opciones XKB del equipo (`xkb-options=[]`) y los atajos de cambio de idioma (Ctrl + Espacio / Ctrl + Shift + Espacio), sin asignación de Shift + Alt al cambio de idioma.

Prueba nueva en GNOME 46 aislado con una aplicación GTK real y eventos de teclado virtuales:

- Shift + Espacio no cambia el estado del panel.
- Shift → Alt izquierdo abre el panel.
- Alt izquierdo → Shift lo cierra.
- Alt izquierdo → Shift derecho vuelve a abrirlo.
- Repetir la combinación vuelve a cerrarlo.
- Sin errores de extensión ni avisos de aceleradores inválidos.

El cambio se aplica también a la preferencia GSettings de la instalación actual; GNOME escucha los cambios de este atajo sin requerir nuevo código JavaScript. El esquema del paquete y la documentación contienen el nuevo valor para futuras instalaciones.
