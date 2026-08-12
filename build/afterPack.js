/**
 * electron-builder afterPack hook — ad-hoc code signing for macOS.
 *
 * We ship UNSIGNED macOS builds (no Apple Developer certificate). On Apple Silicon (arm64),
 * a binary with NO signature at all is rejected by the kernel and Finder mislabels it
 * "PLANO is damaged and can't be opened" — even right-click → Open won't help, because the
 * chip requires *some* valid code signature.
 *
 * An "ad-hoc" signature (`codesign --sign -`) carries no identity and proves nothing about
 * the author, but it satisfies the arm64 signature requirement. After this, Gatekeeper falls
 * back to the normal "unidentified developer" prompt, which the user clears once with
 * right-click → Open (or `xattr -cr` to drop the download quarantine).
 *
 * Runs ONLY on darwin packs — the early return makes it a complete no-op for the Windows
 * build, so the .exe/installer and its behaviour are unchanged.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Patch node-pty's ConPTY console-list agent so it tolerates `AttachConsole` failure.
 * Electron is a GUI process with no attached console, so the agent's native
 * `getConsoleProcessList` throws (`AttachConsole failed`) and node-pty would reject every
 * ConPTY spawn — that's why PLANO fell back to WinPTY (which mangles emoji/CJK). The patched
 * agent returns an empty console list instead of crashing; `kill()` then skips its tree-kill,
 * which the PTY handle close still covers. Matches the patch applied to the repo's node_modules
 * copy (so `npm run dev` behaves identically).
 */
function patchConptyAgent(agentPath) {
  try {
    let s = fs.readFileSync(agentPath, 'utf8')
    if (s.includes('consoleProcessList = [];')) return // already patched
    const old =
      'var consoleProcessList = getConsoleProcessList(shellPid);\n' +
      'process.send({ consoleProcessList: consoleProcessList });\n' +
      'process.exit(0);'
    if (!s.includes(old)) {
      console.warn(`afterPack: conpty agent pattern not found in ${agentPath} — skipping patch`)
      return
    }
    const newCode =
      'var consoleProcessList = [];\n' +
      'try {\n' +
      '  consoleProcessList = getConsoleProcessList(shellPid);\n' +
      '} catch (e) {\n' +
      '  // PLANO: Electron has no attached console (AttachConsole fails) — degrade to an empty list.\n' +
      '}\n' +
      'process.send({ consoleProcessList: consoleProcessList });\n' +
      'process.exit(0);'
    fs.writeFileSync(agentPath, s.replace(old, newCode), 'utf8')
    console.log(`afterPack: patched ConPTY console-list agent (${path.basename(agentPath)})`)
  } catch (err) {
    console.warn(`afterPack: conpty agent patch failed: ${err.message}`)
  }
}

/** Bundle the MSVC runtime DLLs next to the exe so node-pty (compiled with MSVC) loads on PCs
 *  that don't have the VC++ 2015-2022 redistributable installed. They're standard Microsoft
 *  redistributables — safe to redistribute. Uses FORWARD-slash paths: on some hardened systems
 *  fs.existsSync with backslashes fails on System32, but forward slashes work. */
function copyVcRuntime(appOutDir) {
  const fs = require('node:fs')
  const path = require('node:path')
  const sys32 = (process.env.SystemRoot || 'C:\\Windows').replace(/\\/g, '/') + '/System32'
  const dlls = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll']
  for (const dll of dlls) {
    try {
      const src = sys32 + '/' + dll
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appOutDir, dll))
    } catch {
      /* best effort — the redistributable is usually already present on target PCs */
    }
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    copyVcRuntime(context.appOutDir)
    
    // Windows/Linux: patch the unpacked node-pty agent so ConPTY spawns survive Electron's
    // console-less environment (emoji/CJK need ConPTY; WinPTY corrupts them).
    const unpacked = path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
    const candidates = [
      path.join(unpacked, 'node_modules', 'node-pty', 'lib', 'conpty_console_list_agent.js'),
      path.join(unpacked, 'node_modules', 'node-pty', 'lib', 'winpty-agent', 'conpty_console_list_agent.js'),
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        patchConptyAgent(c)
        break
      }
    }
    return
  }

  const appName = context.packager.appInfo.productFilename // → "PLANO"
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  // --deep signs nested frameworks, helpers AND the unpacked native node-pty binary;
  // --force replaces any stale signature; `--sign -` selects the ad-hoc identity.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  console.log(`afterPack: ad-hoc signed ${appPath}`)
}
