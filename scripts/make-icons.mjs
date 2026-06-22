/**
 * Rasterize build/icon.svg into the app-icon assets electron-builder needs:
 *   - build/icon.ico        multi-resolution Windows icon (taskbar, exe, installer, shortcuts)
 *   - build/icon.png        1024px master (Linux + the dev BrowserWindow icon)
 *   - build/icons/<n>x<n>.png  individual sizes (handy for docs / favicons / debugging)
 *
 * Run via `npm run icons` (also chained into the `dist:*` scripts). Edit build/icon.svg, re-run.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const iconsDir = join(buildDir, 'icons')

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

const svg = await readFile(join(buildDir, 'icon.svg'))
await mkdir(iconsDir, { recursive: true })

const pngBySize = new Map()
for (const size of SIZES) {
  const buf = await sharp(svg).resize(size, size, { fit: 'contain' }).png().toBuffer()
  pngBySize.set(size, buf)
  await writeFile(join(iconsDir, `${size}x${size}.png`), buf)
}

await writeFile(join(buildDir, 'icon.png'), pngBySize.get(1024))
await writeFile(join(buildDir, 'icon.ico'), await pngToIco(ICO_SIZES.map((s) => pngBySize.get(s))))

console.log('icons: wrote build/icon.ico, build/icon.png, and build/icons/*.png')
