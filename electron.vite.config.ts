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
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The detached Agent Host (ELECTRON_RUN_AS_NODE child) that owns every PTY session so
          // agents survive the app quitting. Built alongside index.js into out/main/daemon.js.
          daemon: resolve('src/main/daemon/index.ts'),
          // The `plano` mesh CLI (plan v5 A1): a self-contained node script the daemon copies
          // into <userData>/bin at boot so every agent terminal has it on PATH. Built into
          // out/main/cli.js and executed via ELECTRON_RUN_AS_NODE by the plano.cmd/plano
          // launchers — no system Node required, no embedded source string to drift.
          cli: resolve('src/main/daemon/cli/index.ts'),
        },
      },
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
