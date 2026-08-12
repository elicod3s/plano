/**
 * The `plano` mesh CLI (plan v5 A1): a real TypeScript bundle built from src/main/daemon/cli/
 * into out/main/cli.js (electron-vite input `cli`), copied into <userData>/bin at daemon boot
 * and injected into every agent's PATH (ptySpawn.cleanEnv). The launchers execute it with the
 * daemon's own Electron binary under ELECTRON_RUN_AS_NODE, so no system Node is required.
 *
 * The MCP stdio mode (`plano mcp`) is GONE — the CLI is the orchestration surface: any harness
 * that can run a command participates, no MCP config files, no server handshake. It speaks
 * native JSON-RPC to POST /cli (identity via PLANO_MESH_TOKEN, inherited from the terminal).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The directory the daemon drops the CLI into and injects into agent PATHs. */
export function cliBinDir(userData: string): string {
  return join(userData, 'bin')
}

/**
 * Install (or refresh) the `plano` CLI into <userData>/bin. The bundle ships next to the daemon
 * bundle (out/main/cli.js, inside app.asar in production) — read it and copy it, so the
 * installed CLI can never drift from the daemon it talks to. On failure (missing bundle) the
 * daemon logs and continues: the mesh degrades, never the host.
 */
export function installCli(userData: string): string | null {
  const bundlePath = join(dirname(require.main?.filename ?? __filename), 'cli.js')
  let bundle: string
  try {
    bundle = readFileSync(bundlePath, 'utf8')
  } catch (err) {
    return null
  }
  const binDir = cliBinDir(userData)
  mkdirSync(binDir, { recursive: true })
  const cliFile = join(binDir, 'plano-cli.js')
  writeFileSync(cliFile, bundle, 'utf8')
  const electron = process.execPath.replace(/'/g, "''")
  // Electron runs a plain Node script via the ELECTRON_RUN_AS_NODE **environment variable**.
  // There is no `--run-as-node` flag: passing one makes Electron exit with "bad option".
  writeFileSync(
    join(binDir, 'plano.cmd'),
    `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cliFile.replace(/"/g, '\\"')}" %*\r\n`,
    'utf8',
  )
  // POSIX sh (also invoked on Windows under git-bash/msys shells)
  writeFileSync(
    join(binDir, 'plano'),
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electron}" "${cliFile}" "$@"\n`,
    { mode: 0o755 },
  )
  return binDir
}
