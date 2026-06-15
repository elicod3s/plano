import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * One config, three targets.
 *  - main    : Node target (privileged). node-pty stays external (native .node binary).
 *  - preload : Node target, the only bridge between main and renderer.
 *  - renderer: web target (React + Tailwind), sandboxed Chromium.
 *
 * Path aliases are kept identical across targets so `@shared/*` resolves everywhere,
 * while `@/*` is renderer-only. The ESLint boundary (renderer must never import main)
 * is enforced by the tsconfig project split, not by aliases.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
})
