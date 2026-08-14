# Terminal Analysis in PLANO

## 1. Overview

PLANO's terminal is a modern, web-based implementation that provides full terminals inside the desktop app. It uses a "persistent registry" approach to manage terminal sessions.

## 2. Key Technologies

### Main Dependencies:
- **@xterm/xterm** (v5.5.0): Browser terminal with WebGL support
- **@xterm/addon-fit**: Automatic size fitting
- **@xterm/addon-webgl** (v0.18.0): GPU-accelerated rendering
- **@xterm/addon-web-links**: Clickable links in the terminal
- **@xterm/addon-search**: Scrollback search
- **@xterm/addon-unicode11**: Unicode 11 support
- **@xterm/addon-canvas** (v0.7.0): Canvas 2D fallback
- **node-pty** (v1.0.0): Native pseudo-terminal creation (ConPTY on Windows)

### Architectural Stack:
```
Electron 33 + electron-vite
React 18 + TypeScript + Tailwind CSS
zustand + immer (state management)
```

## 3. How the Terminal Works

### Terminal Panel Structure:
```
TerminalPanel
├─ TerminalStatusStrip (top bar)
├─ TerminalSearchBar (appears with Cmd+F/Ctrl+F)
├─ container div (main container)
│  └─ renderBoxRef (absolute div with scale transform)
│     └─ xterm element (mounted by terminalRegistry)
└─ TerminalActionBar (bottom bar)
```

### Persistent Lifecycle:
The app uses a **terminalRegistry** that keeps terminal instances alive even when the React component unmounts. This allows:
- Reusing existing terminals
- Keeping PTY processes active
- Resuming sessions across navigations

### Scale Handling:
The system uses a virtual "render box" approach that scales according to the canvas zoom:
- The `renderBoxRef` has virtual dimensions (`100 * renderScale %`)
- It is counter-scaled with `scale(1 / renderScale)`
- This renders glyphs at high resolution before applying the global zoom

### Size Fitting:
The implementation uses `FitAddon.proposeDimensions()` with special logic:
- Verifies that the proposed dimensions are valid
- Applies a minimum of 1 row/column
- Handles sub-pixel vertical overflow
- Calls `terminal.resize()` only when there are real changes

## 4. Agent Mode for AI Coding CLIs

### Automatic Detection:
PLANO automatically detects when AI coding CLIs are running, such as:
- Claude Code
- Codex (OpenAI)
- Kiro CLI
- Aider
- Gemini CLI
- Cursor
- Opencode

### Detection System:
- **Process-tree matching**: Process tree analysis
- **Output-heuristic**: Detection by output patterns
- **Fused confidence**: Combination of multiple sources (0.8-0.95)

### Agent Mode Features:
1. **No color change**: Keeps the monochrome "Monolith Draft" design
2. **Subtle visual changes**: Differentiated motion and visual weight
3. **Brand chords**: Agent-specific colors (the single exception to the monochrome design)
4. **Specific icons**: lucide-react icons per agent type

### Session Resumption:
The system stores session references (`AgentSessionRef`) that include:
- Agent type (`ResumableAgent`)
- Session ID (UUID)
- Working directory (cwd)

**Security guards:**
- Working-directory validation (resume is scoped per project)
- Session existence verification on disk
- Protected injection (strict regex for IDs)

## 5. Design decisions

| Aspect | PLANO |
|--------|-------|
| **Lifecycle** | Two approaches in PLANO: persistent registry per panel, and per-panel hook + sessions store |
| **DOM mounting** | xterm in a direct React container |
| **Scale** | CSS transform of the world layer |
| **Size fitting** | Several calculations and verifications |
| **Size observation** | Container/viewport via `ResizeObserver` |
| **Scrollbar** | Global rule `scrollbar-gutter: stable` |

## 6. Security Considerations

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- zod validation of all IPC payloads
- Embedded web content in an isolated session
- Injection guards for resume commands

## 7. Windows Setup

### Requirements:
- Windows 10 1809+ (for ConPTY)
- Desktop development with C++ (VS Build Tools) to compile node-pty

### Setup Commands:
```bash
npm install
npm run rebuild  # compiles node-pty against Electron's ABI
npm run dev      # starts PLANO with HMR
```

## 8. Conclusion

PLANO's terminal is a sophisticated implementation that combines:
- Modern web rendering with GPU acceleration
- Persistent session management
- Smart detection of AI coding CLIs
- Automatic conversation resumption
- Monochrome design with controlled exceptions

The system is well thought out for developers who work with multiple AI tools, providing a smooth, uninterrupted experience between work sessions.
