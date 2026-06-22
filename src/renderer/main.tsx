import React from 'react'
import { createRoot } from 'react-dom/client'

// Bundled offline (Fontsource) so the packaged app never needs the network for type.
import '@fontsource-variable/space-grotesk'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
// Fills the box-drawing / Braille / block / symbol ranges Fontsource's subsets drop, so terminal
// CLIs (Claude Code's box + spinner, progress bars, ✓/✶ marks) render in JetBrains Mono, not an
// ugly proportional system fallback. Must come AFTER the Fontsource imports. See the file header.
import './styles/terminal-symbols.css'

import './styles/theme.css'
import './styles/globals.css'
import { App } from './app/App'

// Surface anything that escapes React so a blank screen always has a cause in the log.
window.addEventListener('error', (e) =>
  console.error('PLANO_WINDOW_ERROR:', e.message, e.error?.stack),
)
window.addEventListener('unhandledrejection', (e) =>
  console.error('PLANO_UNHANDLED_REJECTION:', String(e.reason), (e.reason as Error)?.stack),
)

/** Last-resort boundary: turns a render crash into a readable panel instead of a black screen. */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('PLANO_RENDER_CRASH:', error.message, error.stack, info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            padding: 24,
            overflow: 'auto',
            background: '#141414',
            color: '#fafafa',
            font: '13px/1.6 "JetBrains Mono", monospace',
          }}
        >
          <h1 style={{ color: '#f87171', fontSize: 16, marginBottom: 12 }}>PLANO crashed on render</h1>
          <pre style={{ whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root not found')

console.log('PLANO_RENDER_START')
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
