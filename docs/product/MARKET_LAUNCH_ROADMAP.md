# PLANO — Plan completo para salir al mercado

**Estado:** plan de lanzamiento  
**Prioridad actual:** terminar el producto antes de añadir funciones grandes  
**Última actualización:** 2026-08-08

Este documento reúne, en orden de ejecución, todo lo necesario para lanzar PLANO como un producto público confiable. El objetivo no es seguir agregando funciones: es convertir el producto actual en una aplicación instalable, recuperable, comprensible y fácil de mantener.

## Definición de lanzamiento

PLANO estará listo para una beta pública cuando una persona nueva pueda:

1. Encontrar y descargar la aplicación sin advertencias alarmantes.
2. Instalarla y actualizarla sin ayuda manual.
3. Abrir una carpeta y ejecutar su primer agente sin conocer la arquitectura interna.
4. Cerrar y volver a abrir PLANO sin perder su trabajo.
5. Entender qué hacer cuando algo falla.
6. Reportar un problema con información suficiente para reproducirlo.

---

## Fase 1 — Distribución profesional

**Objetivo:** publicar, instalar y actualizar PLANO con un flujo gratuito y repetible.

### Tareas

- [ ] Crear un repositorio o canal de GitHub Releases para binarios y metadatos de actualización.
- [ ] Integrar `electron-updater` con comprobación manual y automática.
- [ ] Mostrar los estados: buscando, disponible, descargando, lista para instalar y error.
- [ ] Generar `latest.yml` junto con cada release.
- [ ] Crear un workflow de GitHub Actions que compile y publique una versión etiquetada.
- [ ] Evitar que claves, tokens o certificados aparezcan en el repositorio o los logs.
- [ ] Generar un paquete MSIX compatible con Microsoft Store.
- [ ] Probar dentro del MSIX: `node-pty`, Agent Host, WebGL, voz, recursos y conexión móvil.
- [ ] Crear y verificar la cuenta gratuita de Partner Center.
- [ ] Reservar el nombre PLANO.
- [ ] Preparar ficha, iconos, capturas, descripción, soporte y política de privacidad.
- [ ] Enviar el MSIX a certificación.
- [ ] Mantener el instalador NSIS directo como canal beta secundario.

### Terminado cuando

- [ ] Una versión nueva puede publicarse desde un tag sin editar archivos manualmente.
- [ ] Una instalación anterior detecta, descarga e instala la actualización.
- [ ] La versión estable se instala desde Microsoft Store sin SmartScreen.
- [ ] Workspaces, configuración y sesiones compatibles sobreviven a la actualización.

---

## Fase 2 — Recuperación y protección del trabajo

**Objetivo:** ningún cierre inesperado debe destruir o esconder el espacio del usuario.

### Tareas

- [ ] Guardar atómicamente workspaces y configuración.
- [ ] Conservar una copia automática del último estado válido.
- [ ] Detectar JSON incompleto o corrupto al arrancar.
- [ ] Restaurar automáticamente desde el backup cuando sea seguro.
- [ ] Informar al usuario cuando se haya usado una copia de recuperación.
- [ ] Crear un modo seguro que arranque sin restaurar paneles problemáticos.
- [ ] Detectar ciclos de fallos repetidos durante el inicio.
- [ ] Diferenciar claramente cerrar la ventana, cerrar PLANO y detener Agent Host.
- [ ] Verificar recuperación después de terminar PLANO desde el Administrador de tareas.
- [ ] Verificar recuperación después de reiniciar Windows.

### Terminado cuando

- [ ] Una interrupción durante el guardado no produce un workspace vacío.
- [ ] PLANO puede recuperar el último estado válido sin intervención técnica.
- [ ] El usuario puede iniciar en modo seguro y volver a abrir su proyecto.

---

## Fase 3 — Onboarding de primera apertura

**Objetivo:** una persona nueva debe llegar a su primer agente funcional en menos de cinco minutos.

### Tareas

- [ ] Crear una bienvenida breve que explique la propuesta de PLANO.
- [ ] Permitir elegir o crear la primera carpeta de trabajo.
- [ ] Detectar Git, shells y agentes disponibles.
- [ ] Mostrar instrucciones específicas para instalar agentes ausentes.
- [ ] Permitir elegir el agente principal.
- [ ] Crear automáticamente un workspace inicial limpio.
- [ ] Guiar la creación y ejecución de la primera terminal/agente.
- [ ] Enseñar pan, zoom, arrastre, búsqueda y Command Palette.
- [ ] Añadir una opción para volver a abrir la guía desde Ayuda.
- [ ] Diseñar estados de permiso denegado, carpeta inválida y agente no encontrado.

### Terminado cuando

- [ ] Un usuario sin conocimiento previo puede completar el flujo sin documentación externa.
- [ ] Cada dependencia ausente muestra una solución concreta.

---

## Fase 4 — Mobile & Remote

**Objetivo:** conectar el teléfono debe sentirse como emparejar un dispositivo, no como configurar una red.

### Tareas de interfaz

- [ ] Reemplazar la lista de adaptadores y QR por un asistente paso a paso.
- [ ] Mostrar un único QR recomendado inicialmente.
- [ ] Explicar que PC y teléfono deben estar en la misma red.
- [ ] Mostrar estados: preparando, esperando, conectado, sin red y error.
- [ ] Mostrar el nombre del dispositivo conectado.
- [ ] Incorporar botones para copiar URL y código de emparejamiento.
- [ ] Mostrar alternativas de red sólo dentro de “Opciones avanzadas”.
- [ ] Añadir diagnóstico automático cuando el teléfono no conecta.
- [ ] Añadir instrucciones específicas para firewall y redes públicas.

### Tareas de seguridad

- [ ] Exigir emparejamiento explícito incluso dentro de la misma subred.
- [ ] No incluir tokens permanentes visibles en URLs compartibles.
- [ ] Permitir regenerar credenciales.
- [ ] Mostrar y revocar dispositivos vinculados.
- [ ] Añadir expiración para códigos temporales.
- [ ] Registrar conexiones sin guardar secretos.
- [ ] Revisar exposición del servidor en interfaces de red no deseadas.

### Terminado cuando

- [ ] Un teléfono nuevo se conecta con un solo QR y confirmación explícita.
- [ ] Un dispositivo revocado no puede volver a entrar con credenciales antiguas.
- [ ] Un fallo de conexión muestra su causa probable y la acción recomendada.

---

## Fase 5 — Diagnóstico y soporte

**Objetivo:** transformar cada fallo de usuario en un reporte reproducible y seguro.

### Tareas

- [ ] Añadir “Reportar un problema” dentro de PLANO.
- [ ] Generar un paquete de diagnóstico bajo confirmación del usuario.
- [ ] Incluir versión, Windows, GPU, escalado, tema y número de paneles.
- [ ] Incluir estado de WebGL, Agent Host, PTYs y servicios relevantes.
- [ ] Incluir los últimos errores y eventos de inicio.
- [ ] Censurar rutas sensibles, tokens, claves, prompts y contenido de terminal.
- [ ] Permitir previsualizar lo que se enviará.
- [ ] Añadir botones para copiar error, abrir logs y exportar diagnóstico.
- [ ] Crear un canal de soporte o formulario de feedback.

### Terminado cuando

- [ ] Un reporte contiene lo necesario para diagnosticar sin pedir múltiples capturas.
- [ ] La prueba de redacción confirma que no se filtran credenciales ni contenido privado.

---

## Fase 6 — Calidad y regresiones

**Objetivo:** impedir que una corrección vuelva a romper terminales, temas o movimiento.

### Tareas

- [ ] Crear un comando único de validación para typecheck, build y pruebas.
- [ ] Probar 1, 20, 50 y 100 paneles.
- [ ] Probar varias terminales con WebGL y fallback sin WebGL.
- [ ] Probar pan, zoom y arrastre con diferentes DPI de Windows.
- [ ] Probar todos los temas claros y oscuros.
- [ ] Probar restauración, actualización y desinstalación conservando datos.
- [ ] Probar suspensión y reactivación de Windows.
- [ ] Probar Agent Host con PLANO abierto y cerrado.
- [ ] Probar conexión, desconexión y reconexión móvil.
- [ ] Definir presupuestos máximos de frame, memoria y tiempo de arranque.
- [ ] Ejecutar una prueba de humo sobre el paquete instalado, no sólo en desarrollo.

### Terminado cuando

- [ ] El pipeline bloquea releases con errores de tipos, build o pruebas críticas.
- [ ] Los escenarios principales pasan en el instalador final.

---

## Fase 7 — Voz como función experimental

**Objetivo:** conservar Odla sin prometer confiabilidad que todavía no tiene.

### Decisión de lanzamiento

- [ ] Etiquetar Voz/Odla como `Labs` o beta.
- [ ] Mantenerla desactivada por defecto hasta completar sus pruebas.
- [ ] No utilizarla como promesa principal de marketing en la primera versión.

### Mejoras necesarias

- [ ] Añadir prueba de micrófono y medidor de nivel.
- [ ] Calibrar automáticamente ruido, voz y silencio por dispositivo.
- [ ] Mostrar qué micrófono está realmente activo.
- [ ] Mostrar la transcripción antes de ejecutar acciones destructivas.
- [ ] Permitir corregir, confirmar o cancelar una transcripción.
- [ ] Añadir historial de órdenes y resultados.
- [ ] Explicar si falló captura, transcripción, interpretación o ejecución.
- [ ] Probar un corpus real en español e inglés.
- [ ] Hacer opcional la descarga del modelo local para reducir el instalador base.
- [ ] Desactivar `auto-send` inicialmente o limitarlo a comandos seguros.

### Terminado cuando

- [ ] Diferentes micrófonos funcionan sin editar umbrales manualmente.
- [ ] Una transcripción dudosa nunca ejecuta silenciosamente una acción destructiva.

---

## Fase 8 — Portabilidad y respaldo

**Objetivo:** permitir cambiar de PC y recuperar PLANO sin copiar carpetas internas manualmente.

### Tareas

- [ ] Exportar configuración y workspaces a un archivo de respaldo.
- [ ] Importar el respaldo con vista previa y validación de versión.
- [ ] Exportar o importar un único workspace.
- [ ] Detectar rutas inexistentes en el nuevo PC y permitir reasignarlas.
- [ ] Excluir tokens, API keys y sesiones secretas por defecto.
- [ ] Documentar qué datos se transfieren.

---

## Fase 9 — Idiomas y accesibilidad

### Tareas

- [ ] Extraer textos de interfaz a un sistema de traducciones.
- [ ] Añadir inglés y español completos.
- [ ] No mezclar idiomas dentro del mismo flujo.
- [ ] Revisar navegación completa por teclado.
- [ ] Añadir foco visible, etiquetas accesibles y orden lógico.
- [ ] Validar contraste en todos los temas.
- [ ] Respetar reducción de movimiento sin eliminar feedback funcional.

---

## Fase 10 — Ayuda, legal y presencia pública

### Centro de ayuda

- [ ] Guía rápida y listado de atajos.
- [ ] Instalación y detección de agentes.
- [ ] Mobile & Remote.
- [ ] Voz y permisos del micrófono.
- [ ] Recuperación y solución de problemas.

### Legal y privacidad

- [ ] Política de privacidad pública.
- [ ] Términos de uso.
- [ ] Explicar qué datos permanecen locales.
- [ ] Explicar cuándo Gemini, endpoints externos o servicios móviles reciben datos.
- [ ] Incluir contacto de soporte y proceso para reportar seguridad.

### Página de producto

- [ ] Dominio y landing page.
- [ ] Propuesta clara: agentes y terminales dentro de un espacio visual.
- [ ] Vídeo corto del flujo principal.
- [ ] Capturas reales del producto.
- [ ] Botón principal de Microsoft Store.
- [ ] Descarga beta secundaria.
- [ ] Documentación, changelog y formulario de feedback.

---

## Orden de ejecución recomendado

| Orden | Área | Bloquea la beta pública |
|---:|---|:---:|
| 1 | Distribución y actualizaciones | Sí |
| 2 | Recuperación y protección del trabajo | Sí |
| 3 | Onboarding | Sí |
| 4 | Mobile & Remote | Sí |
| 5 | Diagnóstico y soporte | Sí |
| 6 | Calidad y regresiones | Sí |
| 7 | Voz/Odla Labs | No, si se presenta como experimental |
| 8 | Exportación e importación | Recomendado |
| 9 | Idiomas y accesibilidad | Recomendado |
| 10 | Ayuda, legal y página pública | Sí para lanzamiento comercial |

## Lo que no se debe priorizar todavía

- Más tipos de paneles.
- Más temas visuales.
- Animaciones decorativas complejas.
- Sincronización cloud completa.
- Funciones sociales.
- Marketplace de extensiones.
- Nuevos proveedores de voz antes de estabilizar captura y transcripción.

## Hito final

La beta pública se puede anunciar cuando las fases 1–6 estén completas, Voz esté claramente marcada como experimental y existan política de privacidad, documentación mínima y un canal de soporte.
