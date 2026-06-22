# Análisis de la Terminal en PLANO

## 1. Visión General

La terminal de PLANO es una implementación moderna basada en tecnologías web que proporciona terminales completas dentro de la aplicación de escritorio. Se diseñó con referencia a Deska (otra aplicación similar) y utiliza un enfoque de "registro persistente" para manejar las sesiones de terminal.

## 2. Tecnologías Clave

### Dependencias Principales:
- **@xterm/xterm** (v5.5.0): Terminal en el navegador con soporte WebGL
- **@xterm/addon-fit**: Ajuste automático de tamaño
- **@xterm/addon-webgl** (v0.18.0): Renderizado acelerado por GPU
- **@xterm/addon-web-links**: Enlaces clickeables en terminal
- **@xterm/addon-search**: Búsqueda en scrollback
- **@xterm/addon-unicode11**: Soporte Unicode 11
- **@xterm/addon-canvas** (v0.7.0): Alternativa Canvas 2D
- **node-pty** (v1.0.0): Creación de pseudo-terminales nativos (ConPTY en Windows)

### Stack Arquitectónico:
```
Electron 33 + electron-vite
React 18 + TypeScript + Tailwind CSS
zustand + immer (gestión de estado)
```

## 3. Funcionamiento de la Terminal

### Estructura del Panel de Terminal:
```
TerminalPanel
├─ TerminalStatusStrip (barra superior)
├─ TerminalSearchBar (aparece con Cmd+F/Ctrl+F)
├─ .deska-terminal-canvas (contendor principal)
│  └─ renderBoxRef (div absoluto con transformación de escala)
│     └─ xterm.element (montado por terminalRegistry)
└─ TerminalActionBar (barra inferior)
```

### Ciclo de Vida Persistente:
La aplicación utiliza un sistema de **terminalRegistry** que mantiene las instancias de terminal vivas incluso cuando el componente React se desmonta. Esto permite:
- Reutilizar terminales existentes
- Mantener procesos PTY activos
- Reanudar sesiones entre navegaciones

### Manejo de Escala:
El sistema utiliza un enfoque de "render box" virtual que se escala según el zoom del canvas:
- El `renderBoxRef` tiene dimensiones virtuales (`100 * renderScale %`)
- Se contra-escala con `scale(1 / renderScale)`
- Esto permite renderizar glifos en alta resolución antes de aplicar el zoom global

### Ajuste de Tamaño:
La implementación utiliza `FitAddon.proposeDimensions()` con lógica especial:
- Verifica que las dimensiones propuestas sean válidas
- Aplica mínimos de 1 fila/columna
- Maneja desbordamiento vertical de subpíxeles
- Llama a `terminal.resize()` solo cuando hay cambios reales

## 4. Modo Agente para AI Coding CLIs

### Detección Automática:
PLANO detecta automáticamente cuando se ejecutan AI coding CLIs como:
- Claude Code
- Codex (OpenAI)
- Kiro CLI
- Aider
- Gemini CLI
- Cursor
- Opencode

### Sistema de Detección:
- **Process-tree matching**: Análisis de árbol de procesos
- **Output-heuristic**: Detección por patrones de salida
- **Fused confidence**: Combinación de múltiples fuentes (0.8-0.95)

### Características del Modo Agente:
1. **Sin cambio de color**: Mantiene el diseño monocromático "Monolith Draft"
2. **Cambios visuales sutiles**: Movimiento y peso visual diferenciado
3. **Acordes de marca**: Colores específicos por agente (excepción única al diseño monocromático)
4. **Iconos específicos**: Iconos de lucide-react por tipo de agente

### Reanudación de Sesiones:
El sistema guarda referencias de sesiones (`AgentSessionRef`) que incluyen:
- Tipo de agente (`ResumableAgent`)
- ID de sesión (UUID)
- Directorio de trabajo (cwd)

**Guardias de seguridad:**
- Validación del directorio de trabajo (resume es scope por proyecto)
- Verificación de existencia de sesión en disco
- Inyección protegida (regex estricta para IDs)

## 5. Diferencias con Deska (Referencia)

Según el análisis en `DESKA_TERMINAL_REFERENCE.md`:

| Aspecto | Deska | PLANO |
|---------|-------|-------|
| **Ciclo de vida** | Registro persistente por panel | Store de sesiones + hook por panel |
| **Montaje DOM** | xterm en render box absoluto | xterm en contenedor React directo |
| **Escala** | Render box virtual + contra-escalado | Transformación CSS del world layer |
| **Ajuste de tamaño** | `FitAddon.proposeDimensions()` + un resize | Varios cálculos y verificaciones |
| **Observación de tamaño** | Render box, umbral 0.5px + debounce | Contenedor/viewport via `ResizeObserver` |
| **Scrollbar** | Sin gutter especial | Regla global `scrollbar-gutter: stable` |

## 6. Consideraciones de Seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Validación zod de todos los payloads IPC
- Contenido web embebido en sesión aislada
- Guardias de inyección para comandos de reanudación

## 7. Configuración para Windows

### Requisitos:
- Windows 10 1809+ (para ConPTY)
- Desktop development with C++ (VS Build Tools) para compilar node-pty

### Comandos de Configuración:
```bash
npm install
npm run rebuild  # compila node-pty contra ABI de Electron
npm run dev      # inicia PLANO con HMR
```

## 8. Conclusión

La terminal de PLANO representa una implementación sofisticada que combina:
- Renderizado web moderno con aceleración GPU
- Gestión persistente de sesiones
- Detección inteligente de AI coding CLIs
- Reanudación automática de conversaciones
- Diseño monocromático con excepciones controladas

El sistema está bien pensado para desarrolladores que trabajan con múltiples herramientas de IA, proporcionando una experiencia fluida y sin interrupciones entre sesiones de trabajo.