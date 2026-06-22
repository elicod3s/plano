import type React from 'react'

/** Minimal subset of Electron's <webview> tag we use (it's a real DOM element). */
export interface WebviewElement extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  isLoading(): boolean
  // Legacy navigation methods (deprecated in Electron ≥30 in favour of `navigationHistory`,
  // but still present in 33). We prefer `navigationHistory` when available, falling back here.
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  reload(): void
  stop(): void
  /** Modern navigation-history controller (present in recent Electron). */
  navigationHistory?: {
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
          useragent?: string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref?: React.Ref<any>
        },
        HTMLElement
      >
    }
  }
}
