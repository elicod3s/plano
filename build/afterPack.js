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
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename // → "PLANO"
  const appPath = path.join(context.appOutDir, `${appName}.app`)

  // --deep signs nested frameworks, helpers AND the unpacked native node-pty binary;
  // --force replaces any stale signature; `--sign -` selects the ad-hoc identity.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  console.log(`afterPack: ad-hoc signed ${appPath}`)
}
