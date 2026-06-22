import type { ComponentType } from 'react'
import {
  SiAstro,
  SiBabel,
  SiC,
  SiCplusplus,
  SiCss,
  SiDocker,
  SiDotenv,
  SiDotnet,
  SiElectron,
  SiEslint,
  SiGit,
  SiGnubash,
  SiGo,
  SiGraphql,
  SiHtml5,
  SiJavascript,
  SiJest,
  SiJson,
  SiKotlin,
  SiLess,
  SiLua,
  SiMarkdown,
  SiNpm,
  SiPhp,
  SiPnpm,
  SiPostcss,
  SiPrettier,
  SiPrisma,
  SiPython,
  SiReact,
  SiRuby,
  SiRust,
  SiSass,
  SiSqlite,
  SiSvelte,
  SiSwift,
  SiTailwindcss,
  SiToml,
  SiTypescript,
  SiVite,
  SiVitest,
  SiVuedotjs,
  SiWebassembly,
  SiWebpack,
  SiYaml,
  SiYarn,
} from 'react-icons/si'
import { FaJava } from 'react-icons/fa6'
import {
  Binary,
  Database,
  FileArchive,
  FileText,
  Image as LuImage,
  Key,
  Lock,
  Scale,
  Settings,
  Terminal,
} from 'lucide-react'

/** Any lucide / react-icons glyph: all of them accept these props (size is `string | number`). */
type Glyph = ComponentType<{ size?: number | string; color?: string; className?: string }>

interface FileIcon {
  Cmp: Glyph
  /** Brand color, tuned for legibility on the dark surface. Omit → inherits the neutral tree color. */
  color?: string
}

// Brand colors live here (not theme.css) on purpose: like the agent accents in
// `shared/domain/agent.ts`, these are fixed brand identities, not themeable chrome. Each is
// nudged lighter where the official mark would be too dark to read on `--surface-1`.
const TS = '#3178C6'
const JS = '#F0DB4F'
const REACT_C = '#61DAFB'
const JSON_C = '#CBB041'
const MD = '#4A9FF5'
const HTML = '#E34F26'
const CSS = '#3A8FD9'
const SCSS = '#CF649A'
const PY = '#5B9FD4'
const RUST = '#E5915A'
const GO = '#00ADD8'
const RUBY = '#CC342D'
const PHP = '#8993BE'
const JAVA = '#E76F00'
const CFAMILY = '#5C9FD8'
const DOTNET = '#8A6FE8'
const SHELL = '#7FBF50'
const PS = '#5391FE'
const YAML = '#9AA7B8'
const TOML = '#B0816A'
const LUA = '#6E8BD6'
const KOTLIN = '#A97BFF'
const SWIFT = '#F05138'
const VUE = '#42B883'
const SVELTE = '#FF5A2B'
const ASTRO = '#FF7E33'
const GRAPHQL = '#E535AB'
const WASM = '#8A7FF0'
const IMG = '#C084FC'
const ARCHIVE = '#E0A458'
const NEUTRAL = '#9AA0AA'

const GENERIC: FileIcon = { Cmp: FileText, color: NEUTRAL }

/** Tools/configs matched by filename prefix (so `tsconfig.web.json`, `.env.local`, … all hit). */
const PREFIX_RULES: Array<[string, FileIcon]> = [
  ['tsconfig', { Cmp: SiTypescript, color: TS }],
  ['tailwind.config', { Cmp: SiTailwindcss, color: '#38BDF8' }],
  ['postcss.config', { Cmp: SiPostcss, color: '#E8643C' }],
  ['vite.config', { Cmp: SiVite, color: '#7B7FFF' }],
  ['vitest.config', { Cmp: SiVitest, color: '#86B84C' }],
  ['vitest.workspace', { Cmp: SiVitest, color: '#86B84C' }],
  ['webpack.config', { Cmp: SiWebpack, color: '#8DD6F9' }],
  ['jest.config', { Cmp: SiJest, color: '#C7568A' }],
  ['babel.config', { Cmp: SiBabel, color: '#F5DA55' }],
  ['.babelrc', { Cmp: SiBabel, color: '#F5DA55' }],
  ['.eslintrc', { Cmp: SiEslint, color: '#8A7BE8' }],
  ['eslint.config', { Cmp: SiEslint, color: '#8A7BE8' }],
  ['.prettierrc', { Cmp: SiPrettier, color: '#F7B93E' }],
  ['prettier.config', { Cmp: SiPrettier, color: '#F7B93E' }],
  ['.env', { Cmp: SiDotenv, color: '#E8C942' }],
  ['dockerfile', { Cmp: SiDocker, color: '#2496ED' }],
  ['docker-compose', { Cmp: SiDocker, color: '#2496ED' }],
  ['.dockerignore', { Cmp: SiDocker, color: '#2496ED' }],
  ['electron-builder', { Cmp: SiElectron, color: '#5AA7B8' }],
]

/** Exact filenames (lowercased) — checked before extensions. */
const BY_NAME: Record<string, FileIcon> = {
  'package.json': { Cmp: SiNpm, color: '#CB3837' },
  'package-lock.json': { Cmp: SiNpm, color: '#8E8E8E' },
  '.npmrc': { Cmp: SiNpm, color: '#CB3837' },
  '.npmignore': { Cmp: SiNpm, color: '#8E8E8E' },
  'yarn.lock': { Cmp: SiYarn, color: '#3A91C0' },
  'pnpm-lock.yaml': { Cmp: SiPnpm, color: '#F69220' },
  '.gitignore': { Cmp: SiGit, color: '#F05133' },
  '.gitattributes': { Cmp: SiGit, color: '#F05133' },
  '.gitmodules': { Cmp: SiGit, color: '#F05133' },
  '.gitkeep': { Cmp: SiGit, color: '#F05133' },
  '.editorconfig': { Cmp: Settings, color: '#C7CDD6' },
  license: { Cmp: Scale, color: '#D4A93C' },
  'license.md': { Cmp: Scale, color: '#D4A93C' },
  licence: { Cmp: Scale, color: '#D4A93C' },
  copying: { Cmp: Scale, color: '#D4A93C' },
  readme: { Cmp: SiMarkdown, color: MD },
}

const BY_EXT: Record<string, FileIcon> = {
  ts: { Cmp: SiTypescript, color: TS },
  mts: { Cmp: SiTypescript, color: TS },
  cts: { Cmp: SiTypescript, color: TS },
  tsx: { Cmp: SiReact, color: REACT_C },
  js: { Cmp: SiJavascript, color: JS },
  mjs: { Cmp: SiJavascript, color: JS },
  cjs: { Cmp: SiJavascript, color: JS },
  jsx: { Cmp: SiReact, color: REACT_C },
  json: { Cmp: SiJson, color: JSON_C },
  json5: { Cmp: SiJson, color: JSON_C },
  jsonc: { Cmp: SiJson, color: JSON_C },
  md: { Cmp: SiMarkdown, color: MD },
  mdx: { Cmp: SiMarkdown, color: MD },
  markdown: { Cmp: SiMarkdown, color: MD },
  html: { Cmp: SiHtml5, color: HTML },
  htm: { Cmp: SiHtml5, color: HTML },
  css: { Cmp: SiCss, color: CSS },
  scss: { Cmp: SiSass, color: SCSS },
  sass: { Cmp: SiSass, color: SCSS },
  less: { Cmp: SiLess, color: '#3A6FB0' },
  py: { Cmp: SiPython, color: PY },
  pyw: { Cmp: SiPython, color: PY },
  pyi: { Cmp: SiPython, color: PY },
  rs: { Cmp: SiRust, color: RUST },
  go: { Cmp: SiGo, color: GO },
  rb: { Cmp: SiRuby, color: RUBY },
  php: { Cmp: SiPhp, color: PHP },
  java: { Cmp: FaJava, color: JAVA },
  class: { Cmp: FaJava, color: JAVA },
  c: { Cmp: SiC, color: CFAMILY },
  h: { Cmp: SiC, color: CFAMILY },
  cpp: { Cmp: SiCplusplus, color: CFAMILY },
  cc: { Cmp: SiCplusplus, color: CFAMILY },
  cxx: { Cmp: SiCplusplus, color: CFAMILY },
  hpp: { Cmp: SiCplusplus, color: CFAMILY },
  hxx: { Cmp: SiCplusplus, color: CFAMILY },
  cs: { Cmp: SiDotnet, color: DOTNET },
  sh: { Cmp: SiGnubash, color: SHELL },
  bash: { Cmp: SiGnubash, color: SHELL },
  zsh: { Cmp: SiGnubash, color: SHELL },
  ps1: { Cmp: Terminal, color: PS },
  psm1: { Cmp: Terminal, color: PS },
  psd1: { Cmp: Terminal, color: PS },
  yml: { Cmp: SiYaml, color: YAML },
  yaml: { Cmp: SiYaml, color: YAML },
  toml: { Cmp: SiToml, color: TOML },
  ini: { Cmp: Settings, color: NEUTRAL },
  cfg: { Cmp: Settings, color: NEUTRAL },
  conf: { Cmp: Settings, color: NEUTRAL },
  properties: { Cmp: Settings, color: NEUTRAL },
  lua: { Cmp: SiLua, color: LUA },
  kt: { Cmp: SiKotlin, color: KOTLIN },
  kts: { Cmp: SiKotlin, color: KOTLIN },
  swift: { Cmp: SiSwift, color: SWIFT },
  vue: { Cmp: SiVuedotjs, color: VUE },
  svelte: { Cmp: SiSvelte, color: SVELTE },
  astro: { Cmp: SiAstro, color: ASTRO },
  graphql: { Cmp: SiGraphql, color: GRAPHQL },
  gql: { Cmp: SiGraphql, color: GRAPHQL },
  prisma: { Cmp: SiPrisma, color: '#A9B4C8' },
  sql: { Cmp: Database, color: '#7AA6C2' },
  db: { Cmp: SiSqlite, color: '#5FA9D9' },
  sqlite: { Cmp: SiSqlite, color: '#5FA9D9' },
  sqlite3: { Cmp: SiSqlite, color: '#5FA9D9' },
  wasm: { Cmp: SiWebassembly, color: WASM },
  png: { Cmp: LuImage, color: IMG },
  jpg: { Cmp: LuImage, color: IMG },
  jpeg: { Cmp: LuImage, color: IMG },
  gif: { Cmp: LuImage, color: IMG },
  webp: { Cmp: LuImage, color: IMG },
  bmp: { Cmp: LuImage, color: IMG },
  avif: { Cmp: LuImage, color: IMG },
  svg: { Cmp: LuImage, color: IMG },
  ico: { Cmp: LuImage, color: IMG },
  zip: { Cmp: FileArchive, color: ARCHIVE },
  tar: { Cmp: FileArchive, color: ARCHIVE },
  gz: { Cmp: FileArchive, color: ARCHIVE },
  tgz: { Cmp: FileArchive, color: ARCHIVE },
  rar: { Cmp: FileArchive, color: ARCHIVE },
  '7z': { Cmp: FileArchive, color: ARCHIVE },
  bz2: { Cmp: FileArchive, color: ARCHIVE },
  xz: { Cmp: FileArchive, color: ARCHIVE },
  pdf: { Cmp: FileText, color: '#E5664E' },
  lock: { Cmp: Lock, color: NEUTRAL },
  exe: { Cmp: Binary, color: NEUTRAL },
  dll: { Cmp: Binary, color: NEUTRAL },
  bin: { Cmp: Binary, color: NEUTRAL },
  so: { Cmp: Binary, color: NEUTRAL },
  dylib: { Cmp: Binary, color: NEUTRAL },
  key: { Cmp: Key, color: ARCHIVE },
  pem: { Cmp: Key, color: ARCHIVE },
  crt: { Cmp: Key, color: ARCHIVE },
  cert: { Cmp: Key, color: ARCHIVE },
}

/** Map a file name to its brand glyph + color. Pure; safe to call per tree node. */
export function getFileIcon(filename: string): FileIcon {
  const lower = filename.toLowerCase()
  const exact = BY_NAME[lower]
  if (exact) return exact
  if (lower.startsWith('readme.')) return { Cmp: SiMarkdown, color: MD }
  for (const [prefix, icon] of PREFIX_RULES) {
    if (lower.startsWith(prefix)) return icon
  }
  if (lower.endsWith('.d.ts')) return { Cmp: SiTypescript, color: TS }
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  return BY_EXT[ext] ?? GENERIC
}

/**
 * VS Code / Warp-style file-type glyph: a colored brand mark for known types, a neutral
 * document for everything else (the neutral one inherits the surrounding text color, so it
 * stays monochrome via the parent's `text-…` class).
 */
export function FileTypeIcon({
  name,
  size = 14,
  className,
}: {
  name: string
  size?: number
  className?: string
}) {
  const { Cmp, color } = getFileIcon(name)
  return <Cmp size={size} color={color} className={className} />
}
