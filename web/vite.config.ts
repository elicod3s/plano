import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The PLANO mobile web app — a phone-first PWA. Built to <repo>/web-dist which the Agent Host
// serves on the LAN (and which electron-builder ships as resources/web).
export default defineConfig({
  root: resolve(__dirname),
  plugins: [react()],
  base: './',
  build: {
    outDir: resolve(__dirname, '..', 'web-dist'),
    emptyOutDir: true,
    target: 'es2020',
    // Keep it small for phone loads; the app is a thin client over the LAN daemon.
    assetsInlineLimit: 8192,
  },
  server: {
    port: 5199,
    host: true,
  },
})
