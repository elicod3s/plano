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

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A REAL `plano.exe`, because a `.cmd` cannot be called by the agents that matter.
 *
 * Codex and OMP are Rust programs, and since CVE-2024-24576 ("BatBadBut") Rust REFUSES to spawn a
 * .bat/.cmd whose arguments it cannot safely escape. An agent trying
 * `plano spawn omp . --prompt "<a real task with (parens), quotes and emoji>"` got
 * `failed to execute command 'plano': batch file arguments are invalid` (exit 126) — every single
 * time. The prompt was never the problem; the file extension was.
 *
 * The fix: ship a real `plano.exe` next to the `.cmd` launcher, so PATH resolves to the
 * executable and the harness spawns a normal Windows process. PLANO cannot ship a prebuilt binary
 * for every install, but it does not have to: the .NET Framework C# compiler is part of Windows
 * itself, so the launcher is COMPILED ON THE MACHINE at provisioning time. ~4 KB, no toolchain,
 * no download.
 *
 * The launcher is deliberately dumb: forward argv verbatim to the CLI script under Electron's
 * node mode, inherit the standard streams, return the child's exit code. All the intelligence
 * stays in TypeScript.
 */
const LAUNCHER_CS = `using System;
using System.Diagnostics;
using System.Text;

class PlanoLauncher {
  // Written WITHOUT a single backslash on purpose: this source lives inside a TypeScript template
  // literal, and every escape level between here and the compiler is one more way to ship a
  // launcher that silently does not build. The two characters that matter are named instead.
  const char BS = (char)92;
  const char QT = (char)34;

  static int Main(string[] args) {
    string electron = @"__ELECTRON__";
    string script = @"__SCRIPT__";
    var sb = new StringBuilder();
    sb.Append(Quote(script));
    foreach (string a in args) { sb.Append(' '); sb.Append(Quote(a)); }
    var psi = new ProcessStartInfo(electron);
    psi.Arguments = sb.ToString();
    psi.UseShellExecute = false;
    psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
    try {
      using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
    } catch (Exception ex) {
      Console.Error.WriteLine("plano: could not start the CLI: " + ex.Message);
      return 1;
    }
  }

  // The quoting rules CreateProcess actually uses: wrap in quotes, double the backslashes that
  // precede a quote, escape embedded quotes. This is the step cmd.exe could never be trusted with,
  // and it is why an arbitrary prompt — parens, quotes, emoji, $, &, |, ^ — arrives intact.
  static string Quote(string s) {
    var sb = new StringBuilder();
    sb.Append(QT);
    int slashes = 0;
    foreach (char c in s) {
      if (c == BS) { slashes++; sb.Append(c); continue; }
      if (c == QT) { sb.Append(new string(BS, slashes + 1)); sb.Append(QT); }
      else { sb.Append(c); }
      slashes = 0;
    }
    sb.Append(new string(BS, slashes));
    sb.Append(QT);
    return sb.ToString();
  }
}
`

/** Where Windows keeps the C# compiler that ships with the OS (no install, every machine). */
function cscPath(): string | null {
  const root = process.env.SystemRoot || 'C:\\Windows'
  for (const version of ['v4.0.30319']) {
    for (const arch of ['Framework64', 'Framework']) {
      const candidate = join(root, 'Microsoft.NET', arch, version, 'csc.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Compile `<userData>/bin/plano.exe`. Best effort by design: when it cannot be built the .cmd and
 * POSIX launchers still exist, so the CLI degrades to "works everywhere except from Rust agents
 * with complex arguments" rather than disappearing.
 */
function installLauncherExe(binDir: string, electron: string, script: string): boolean {
  if (process.platform !== 'win32') return false
  const csc = cscPath()
  if (!csc) return false
  const exePath = join(binDir, 'plano.exe')
  const srcPath = join(binDir, 'plano-launcher.cs')
  try {
    const source = LAUNCHER_CS.replace('__ELECTRON__', electron).replace('__SCRIPT__', script)
    // Rebuild only when the source changed: csc costs ~1 s and provisioning runs on every boot.
    const stamp = join(binDir, 'plano-launcher.stamp')
    const fingerprint = `${electron}|${script}`
    if (existsSync(exePath) && existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint) return true
    writeFileSync(srcPath, source, 'utf8')
    // ASYNC on purpose. Compiling with execFileSync blocked the daemon's event loop for the whole
    // csc run, and the daemon is the only thing answering the mesh: an e2e (fresh userData ⇒ no
    // stamp ⇒ recompile every boot) saw `connect ETIMEDOUT` on the CLI endpoint because the
    // process was sitting inside a synchronous child. Nothing waits for this — the .cmd and POSIX
    // launchers already work, and plano.exe simply appears a second later.
    execFile(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${exePath}`, srcPath], { timeout: 60_000 }, (err) => {
      try {
        if (!err && existsSync(exePath)) writeFileSync(stamp, fingerprint, 'utf8')
        rmSync(srcPath, { force: true })
      } catch {
        /* best effort */
      }
    })
    return true
  } catch {
    return false
  }
}

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
  // The real executable — see LAUNCHER_CS. PATHEXT resolves .EXE before .CMD, so once this exists
  // every caller (including Rust harnesses that refuse .cmd files outright) gets a normal process.
  installLauncherExe(binDir, process.execPath, cliFile)
  return binDir
}
