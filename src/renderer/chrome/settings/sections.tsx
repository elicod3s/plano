/**
 * The Settings sections. Each is a small component bound to useSettingsStore; the SECTIONS
 * list drives the sidebar (8 sections, matching the new UI design rail) and SETTINGS_INDEX
 * powers search. Every capability from previous builds is preserved — merged groups just
 * share a rail entry (e.g. Canvas & Workspace / Mobile & Remote live under General).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'
import { useUpdateStore } from '@/stores/useUpdateStore'
import { cn } from '@/lib/cn'
import { SEARCH_ENGINES, type SearchEngineId, type ShellChoice, type TerminalUrlAction, type VoiceLanguage, type GridSize } from '@shared/domain/settings'
import type { AppInfo, VoiceStatus } from '@shared/ipc/contracts'
import { Toggle } from '@/design-system/Toggle'
import { Button } from '@/design-system/Button'
import { Icon } from '@/design-system/Icon'
import {
  SectionTitle,
  GroupLabel,
  SettingRow,
  SettingBlock,
  Segmented,
  Slider,
  Select,
  TextField,
  NumberField,
  type Opt,
} from './controls'
import { ThemeGallery, AccentSwatches, TerminalThemeGallery, GridStylePicker, BackgroundPicker } from './galleries'
import { listInputDevices, releaseMic } from '@/voice/audio/mic'
import { playAgentDoneChime } from '@/lib/agentChime'
import { fetchPlatform } from '@/lib/platform'

const pct = (v: number): string => `${Math.round(v * 100)}%`

// ── General (incl. Canvas & Workspace, Mobile & Remote) ──
function GeneralSection() {
  const s = useSettingsStore((st) => st.settings.general)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('general', p)
  return (
    <>
      <SectionTitle>General</SectionTitle>
      <SettingRow title="Restore last workspace" description="Reopen the most-recent project automatically when PLANO launches.">
        <Toggle checked={s.restoreLastWorkspace} onChange={(v) => set({ restoreLastWorkspace: v })} />
      </SettingRow>
      <SettingRow title="Restore agent sessions" description="Reopen agent conversations (Claude Code, Codex, Cursor, …) in restored terminals when a workspace reopens.">
        <Toggle checked={s.restoreAgentSessions} onChange={(v) => set({ restoreAgentSessions: v })} />
      </SettingRow>
      <SettingRow title="Show files on launch" description="Drop a Files panel onto the canvas when a workspace opens without one.">
        <Toggle checked={s.showFilesOnLaunch} onChange={(v) => set({ showFilesOnLaunch: v })} />
      </SettingRow>
      <SettingRow title="Warn before quitting" description="Ask for confirmation before the window's close button exits PLANO.">
        <Toggle checked={s.warnBeforeQuit} onChange={(v) => set({ warnBeforeQuit: v })} />
      </SettingRow>
      <SettingRow title="Confirm closing agent terminals" description="Ask before closing a terminal that has an AI agent (Claude Code, Codex, …) running. Plain terminals always close directly.">
        <Toggle checked={s.confirmClosePanelWithProcess} onChange={(v) => set({ confirmClosePanelWithProcess: v })} />
      </SettingRow>
      <SettingRow title="Agent finished sound" description="Play one quiet cue when an agent finishes a turn. Simultaneous completions are grouped.">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => playAgentDoneChime()} title="Play a preview">
            <Icon name="Volume2" size={14} />
            Preview
          </Button>
          <Toggle checked={s.agentDoneSound} label="Agent finished sound" onChange={(v) => set({ agentDoneSound: v })} />
        </div>
      </SettingRow>
      <SettingRow title="Agent finished notifications" description="Show an in-app notification when an agent in another workspace finishes, or any agent is blocked awaiting input. Clicking it jumps to that agent. The sound follows its own setting.">
        <Toggle checked={s.agentDoneNotify} onChange={(v) => set({ agentDoneNotify: v })} />
      </SettingRow>
      <CanvasBlock />
    </>
  )
}

function CanvasBlock() {
  const s = useSettingsStore((st) => st.settings.canvas)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('canvas', p)
  return (
    <>
      <div className="label-caps mb-2 mt-6 px-1">Canvas &amp; Workspace</div>
      <SettingRow title="Snap to grid" description="Align panels to the 8px grid while moving and resizing.">
        <Toggle checked={s.snapToGrid} onChange={(snapToGrid) => set({ snapToGrid })} />
      </SettingRow>
      <SettingRow title="Zoom sensitivity" description="How fast Alt + wheel zooms the canvas.">
        <Slider value={s.zoomSensitivity} min={0.4} max={2.5} step={0.1} onChange={(zoomSensitivity) => set({ zoomSensitivity })} format={(v) => `${v.toFixed(1)}×`} />
      </SettingRow>
      <SettingRow title="Autosave" description="Continuously persist the workspace as you work.">
        <Toggle checked={s.autosave} onChange={(autosave) => set({ autosave })} />
      </SettingRow>
    </>
  )
}

// ── Mobile & Remote ───────────────────────────────────────────────────────────────
function MobileSection() {
  const keepAgents = useSettingsStore((st) => st.settings.terminal.keepAgentsOnQuit)
  const patch = useSettingsStore((st) => st.patch)
  const [info, setInfo] = useState<{
    lanIps: string[]
    webPort: number
    token: string
    pairingCode: string
    url: string
    phoneConnected: boolean
    firewallNotice: string
  } | null>(null)
  const [qrs, setQrs] = useState<Array<{ ip: string; label: string; dataUrl: string }>>([])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const r = await window.plano.app.getRemoteInfo()
        if (!alive) return
        setInfo(r)
        if (r.token) {
          const QRCode = (await import('qrcode')).default
          const ips = r.lanIps.length > 0 ? r.lanIps : [r.url.replace(/^https?:\/\//, '').split(':')[0]]
          const list: Array<{ ip: string; label: string; dataUrl: string }> = []
          for (const ip of ips) {
            const url = `http://${ip}:${r.webPort}/?token=${r.token}`
            const dataUrl = await QRCode.toDataURL(url, {
              margin: 1,
              width: 220,
              color: { dark: '#1a1a1a', light: '#f5f4f1' },
            })
            list.push({ ip, label: ip === r.lanIps[0] ? ip + ' · recommended' : ip, dataUrl })
          }
          if (alive) setQrs(list)
        }
      } catch {
        /* host may not be up yet */
      }
    }
    void load()
    const t = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  return (
    <div className="mt-6">
      <div className="label-caps mb-2 px-1">Mobile &amp; Remote</div>
      <SettingBlock
        title="PLANO on your phone"
        description="Scan the code with your phone camera — or open the URL in its browser — to view your agents and terminals, talk to them and launch new ones from anywhere on your Wi-Fi. Works even while PLANO is closed."
      >
        <div className="flex flex-col items-center gap-3 py-2">
          {qrs.length > 0 ? (
            qrs.map((q) => (
              <div key={q.ip} className="flex flex-col items-center gap-1">
                <img src={q.dataUrl} alt={`PLANO mobile web QR — ${q.ip}`} className="h-48 w-48 rounded-2xl bg-[var(--surface-raised)] p-2" />
                <div className="rounded-full bg-[var(--surface-raised)] px-3 py-1 font-mono text-[11px] text-[var(--text-secondary)]">
                  {q.label}
                </div>
              </div>
            ))
          ) : info?.webPort ? (
            <div className="flex h-48 w-48 items-center justify-center rounded-2xl bg-[var(--surface-raised)]">
              <span className="text-sm text-[var(--text-muted)]">Waiting for host…</span>
            </div>
          ) : null}
          {info?.url ? (
            <div className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2 font-mono text-xs">
              {info.url}
            </div>
          ) : null}
          {info?.token ? (
            <div className="flex w-full items-center justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2">
              <span className="min-w-0 truncate font-mono text-xs text-[var(--text-muted)]">
                Token: {info.pairingCode}…
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void window.plano.clipboard.writeText(info.token)}
              >
                Copy
              </Button>
            </div>
          ) : null}
          {info && info.lanIps && info.lanIps.length > 1 ? (
            <p className="text-xs text-[var(--text-muted)]">
              Several network adapters found — if the first QR doesn't connect, scan the next one.
            </p>
          ) : null}
        </div>
      </SettingBlock>
      <SettingRow
        title="Keep agents when closing"
        description="Terminals and agents keep running in the background Agent Host when PLANO closes — the phone keeps seeing them live."
      >
        <Toggle checked={keepAgents} onChange={(v) => patch('terminal', { keepAgentsOnQuit: v })} />
      </SettingRow>
      {info?.firewallNotice ? (
        <SettingRow title="Firewall" description="The Agent Host port is blocked by firewalld. Run this once so your phone can reach PLANO.">
          <div className="flex items-center gap-2">
            <code className="rounded-[10px] border border-glass bg-surface-inset px-2.5 py-1.5 font-mono text-[11px] text-text-secondary">
              {info.firewallNotice}
            </code>
            <Button variant="ghost" size="sm" onClick={() => void window.plano.clipboard.writeText(info.firewallNotice)}>
              <Icon name="Copy" size={14} />
              Copy
            </Button>
          </div>
        </SettingRow>
      ) : null}
    </div>
  )
}

// ── Appearance ──────────────────────────────────────────────────────────────
function AppearanceSection() {
  const s = useSettingsStore((st) => st.settings.appearance)
  const canvas = useSettingsStore((st) => st.settings.canvas)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('appearance', p)
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>

      {/* theme — 8 cards */}
      <div className="label-caps mb-2 mt-6 px-1">Theme</div>
      <div className="grid grid-cols-4 gap-3">
        <ThemeGallery value={s.theme} onChange={(theme) => set({ theme })} />
      </div>

      {/* accent — full-width palette so the description never collapses into a narrow column */}
      <SettingBlock title="Accent" description="Used sparingly for active states and focus.">
        <AccentSwatches value={s.accent} onChange={(accent) => set({ accent })} />
      </SettingBlock>

      {/* canvas — substrate, glow and drafting grid */}
      <div className="label-caps mb-2 mt-6 px-1">Canvas</div>
      <SettingBlock title="Background">
        <BackgroundPicker value={s.canvasBackground} onChange={(canvasBackground) => set({ canvasBackground })} theme={s.theme} />
      </SettingBlock>
      <SettingRow title="Ambient glow" description="A soft halo of the accent color over the canvas substrate.">
        <Slider value={s.canvasGlow} min={0} max={40} step={1} onChange={(canvasGlow) => set({ canvasGlow })} format={(v) => `${Math.round(v)}%`} />
      </SettingRow>
      <SettingBlock title="Grid style" description="The pattern drawn on the canvas substrate.">
        <GridStylePicker value={s.gridStyle} onChange={(gridStyle) => set({ gridStyle })} />
      </SettingBlock>
      <SettingRow title="Grid size" description="Spacing of the drafting grid.">
        <GridSizePill value={s.gridSize} onChange={(gridSize) => set({ gridSize })} />
      </SettingRow>
      <SettingRow title="Grid strength" description="How prominent the canvas grid reads.">
        <Slider value={s.gridOpacity} min={0} max={1} step={0.05} onChange={(gridOpacity) => set({ gridOpacity })} format={pct} />
      </SettingRow>
      <SettingRow title="Show minimap" description="The overview map in the corner of the canvas.">
        <Toggle checked={canvas.showMinimap} onChange={(showMinimap) => patch('canvas', { showMinimap })} />
      </SettingRow>

      {/* reduce motion — last */}
      <SettingRow title="Reduce motion" description="Damp animations and transitions regardless of the OS setting.">
        <Toggle checked={s.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} />
      </SettingRow>
    </>
  )
}

// ── Usage (the status bar + its providers) ─────────────────────────────────
function UsageSection() {
  const usage = useSettingsStore((st) => st.settings.usage)
  const patch = useSettingsStore((st) => st.patch)
  const patchUsage = (p: Partial<typeof usage>): void => patch('usage', p)
  const setChip = (key: 'ports' | 'resources' | 'agents', value: boolean): void =>
    patch('usage', { chips: { ...usage.chips, [key]: value } })
  const setProvider = (provider: string, value: boolean): void =>
    patch('usage', { chips: { ...usage.chips, providers: { ...usage.chips.providers, [provider]: value } } })
  // Only the providers the collector can actually read. Listing chips for quotas PLANO cannot
  // fetch (gemini, opencode, omp) gave the user switches that changed nothing.
  const PROVIDER_LABELS: Array<[string, string]> = [
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['grok', 'Grok'],
  ]
  return (
    <>
      <SectionTitle>Usage</SectionTitle>
      {/* One switch decides the island exists; everything below only picks what it carries, so
          the rows are grouped by WHAT they show instead of listed flat. No helper copy: each
          label already says what it is (CLAUDE.md). */}
      <SettingRow title="Usage island">
        <Toggle checked={usage.showStatusBar} onChange={(showStatusBar) => patchUsage({ showStatusBar })} />
      </SettingRow>

      <GroupLabel>Providers</GroupLabel>
      {PROVIDER_LABELS.map(([id, label]) => (
        <SettingRow key={id} title={label}>
          <Toggle
            checked={usage.chips.providers[id as keyof typeof usage.chips.providers] !== false}
            onChange={(v) => setProvider(id, v)}
          />
        </SettingRow>
      ))}

      <GroupLabel>Machine</GroupLabel>
      <SettingRow title="Ports">
        <Toggle checked={usage.chips.ports} onChange={(v) => setChip('ports', v)} />
      </SettingRow>
      <SettingRow title="Memory">
        <Toggle checked={usage.chips.resources} onChange={(v) => setChip('resources', v)} />
      </SettingRow>
      <SettingRow title="Agents">
        <Toggle checked={usage.chips.agents} onChange={(v) => setChip('agents', v)} />
      </SettingRow>
    </>
  )
}

/** Grid-spacing pill — opens a small dropdown (Fine / Standard / Coarse). */
const GRID_SIZE_OPTS: { value: GridSize; label: string }[] = [
  { value: 'fine', label: 'Fine' },
  { value: 'standard', label: 'Standard' },
  { value: 'coarse', label: 'Coarse' },
]
function GridSizePill({ value, onChange }: { value: GridSize; onChange: (v: GridSize) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = GRID_SIZE_OPTS.find((o) => o.value === value)?.label ?? 'Standard'
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="app-no-drag flex h-[34px] items-center gap-2 rounded-pill border border-glass px-[13px] text-[13px] text-text-1 transition-colors hover:border-glass-hover hover:bg-glass"
        style={{ background: 'var(--glass)' }}
      >
        {current}
        <Icon name="ChevronDown" size={13} className={open ? 'rotate-180 text-text-3' : 'text-text-3'} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-[38px] z-20 min-w-[148px] overflow-hidden rounded-[13px] border border-glass bg-surface-2 p-1 shadow-xl"
          style={{ boxShadow: '0 16px 40px -12px rgba(0,0,0,0.55)' }}
        >
          {GRID_SIZE_OPTS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-[9px] px-2.5 py-1.5 text-left text-[12.5px] transition-colors',
                o.value === value ? 'bg-accent-soft text-text-primary' : 'text-text-secondary hover:bg-accent-soft hover:text-text-primary',
              )}
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && <Icon name="Check" size={12} className="ml-auto shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Editor ──────────────────────────────────────────────────────────────────
function EditorSection() {
  const s = useSettingsStore((st) => st.settings.editor)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('editor', p)
  return (
    <>
      <SectionTitle>Editor</SectionTitle>
      <SettingRow title="Font size" description="Code font size in editor panels.">
        <NumberField value={s.fontSize} min={9} max={28} onChange={(fontSize) => set({ fontSize })} suffix="px" />
      </SettingRow>
      <SettingRow title="Tab size" description="Spaces a tab is rendered as.">
        <NumberField value={s.tabSize} min={1} max={8} onChange={(tabSize) => set({ tabSize })} />
      </SettingRow>
      <SettingRow title="Word wrap" description="Wrap long lines to the panel width instead of scrolling.">
        <Toggle checked={s.wordWrap} onChange={(wordWrap) => set({ wordWrap })} />
      </SettingRow>
      <SettingRow title="Line numbers" description="Show the gutter with line numbers.">
        <Toggle checked={s.lineNumbers} onChange={(lineNumbers) => set({ lineNumbers })} />
      </SettingRow>
      <p className="pt-3 font-mono text-[11px] text-text-quaternary">Applies to editors opened after the change.</p>
    </>
  )
}

// ── Terminal ────────────────────────────────────────────────────────────────
const SHELL_OPTS: Opt<ShellChoice>[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'pwsh', label: 'PowerShell 7' },
  { value: 'cmd', label: 'Command Prompt' },
  { value: 'bash', label: 'bash' },
  { value: 'zsh', label: 'zsh' },
  { value: 'fish', label: 'fish' },
]

function TerminalSection() {
  const s = useSettingsStore((st) => st.settings.terminal)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('terminal', p)
  // Linux ports: the privileged platform comes from main over IPC. On Linux, PowerShell/cmd
  // are never installed — filter them out so the Shell picker only shows shells that exist.
  // Windows and macOS keep the full list byte-identical to before (all 7 options).
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null)
  useEffect(() => {
    void fetchPlatform().then(setPlatform)
  }, [])
  const shellOpts =
    platform === 'linux'
      ? SHELL_OPTS.filter((o) => o.value === 'auto' || o.value === 'bash' || o.value === 'zsh' || o.value === 'fish')
      : SHELL_OPTS
  return (
    <>
      <SectionTitle>Terminal</SectionTitle>
      <SettingRow title="Shell" description="Program launched for new terminals. The explicit path below overrides this.">
        <Select value={s.shell} options={shellOpts} onChange={(shell) => set({ shell })} width={190} />
      </SettingRow>
      <SettingRow title="Shell path" description="Absolute path to a shell executable. Leave blank to use the choice above.">
        <TextField value={s.shellPath} placeholder="Auto-detect" onChange={(shellPath) => set({ shellPath })} width={210} />
      </SettingRow>
      <SettingRow title="Font family" description="Override the terminal typeface. Blank uses the bundled JetBrains Mono.">
        <TextField value={s.fontFamily} placeholder="e.g. Cascadia Code" onChange={(fontFamily) => set({ fontFamily })} width={210} />
      </SettingRow>
      <SettingRow
        title="Font size"
        description="Global terminal typeface size (10–24 px). Per-terminal Ctrl +/− overrides keep winning over this."
      >
        <Slider
          value={s.fontSize === 0 ? 13 : s.fontSize}
          min={10}
          max={24}
          step={1}
          width={150}
          onChange={(fontSize) => set({ fontSize })}
          format={(v) => `${v}px`}
        />
      </SettingRow>
      <SettingRow title="Line height" description="Vertical spacing between terminal rows. 1.0 (default) keeps box-drawing connected — higher values reopen a sub-cell gap that tears CLI block-art, so the slider caps at 1.2.">
        <Slider value={s.lineHeight} min={1} max={1.2} step={0.05} width={150} onChange={(lineHeight) => set({ lineHeight })} format={(v) => v.toFixed(2)} />
      </SettingRow>
      <SettingRow title="Cursor" description="Caret shape and blink for the terminal.">
        <div className="flex items-center gap-2">
          <Segmented
            value={s.cursorStyle}
            onChange={(cursorStyle) => set({ cursorStyle })}
            options={[
              { value: 'bar', label: 'Bar' },
              { value: 'block', label: 'Block' },
              { value: 'underline', label: 'Line' },
            ]}
          />
          <Toggle checked={s.cursorBlink} onChange={(cursorBlink) => set({ cursorBlink })} label="Blink" />
        </div>
      </SettingRow>
      <SettingRow title="Scrollback" description="Lines kept per terminal — lower uses less memory.">
        <NumberField value={s.scrollback} min={500} max={100000} step={500} onChange={(scrollback) => set({ scrollback })} width={96} />
      </SettingRow>
      <SettingRow title="Copy on select" description="Copy the selection to the clipboard the moment it is made.">
        <Toggle checked={s.copyOnSelect} onChange={(copyOnSelect) => set({ copyOnSelect })} />
      </SettingRow>
      <SettingRow title="Predictive history" description="Ghost the best-matching past command inline as you type; press Tab or → to accept. Uses your shell's saved history (PowerShell/PSReadLine). Applies to terminals opened after the change.">
        <Toggle checked={s.predictiveHistory} onChange={(predictiveHistory) => set({ predictiveHistory })} />
      </SettingRow>
      <SettingRow title="Smart actions" description="Detect links, device codes and paths in output and offer one-click actions. (Planned)">
        <Toggle checked={s.smartActions} onChange={(smartActions) => set({ smartActions })} />
      </SettingRow>
      <SettingRow title="Suspend background terminals" description="Hibernate the terminals of a workspace you switch away from (free their GPU contexts and stop their output streaming) while the shells keep running. Returning replays the buffered output. Reclaim memory with many workspaces open.">
        <Toggle checked={s.autoSuspendIdle} onChange={(autoSuspendIdle) => set({ autoSuspendIdle })} />
      </SettingRow>
      <SettingRow title="Keep agents when closing" description="Keep every terminal — and the agents running inside it — alive in the background when PLANO closes, so reopening lands exactly where you left it and work continues while the app is closed.">
        <Toggle checked={s.keepAgentsOnQuit} onChange={(keepAgentsOnQuit) => set({ keepAgentsOnQuit })} />
      </SettingRow>
      <SettingBlock title="Terminal theme" description="Default palette for new terminals. Each terminal can override it from its panel.">
        <TerminalThemeGallery value={s.theme} onChange={(theme) => set({ theme })} />
      </SettingBlock>
    </>
  )
}

// ── Browser ─────────────────────────────────────────────────────────────────
const ENGINE_OPTS: Opt<SearchEngineId>[] = (Object.keys(SEARCH_ENGINES) as SearchEngineId[]).map((id) => ({
  value: id,
  label: SEARCH_ENGINES[id].label,
}))
const URL_ACTION_OPTS: Opt<TerminalUrlAction>[] = [
  { value: 'ask', label: 'Ask first' },
  { value: 'plano', label: 'Open in PLANO' },
  { value: 'external', label: 'System browser' },
  { value: 'ignore', label: 'Do nothing' },
]

function BrowserSection() {
  const s = useSettingsStore((st) => st.settings.browser)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('browser', p)
  return (
    <>
      <SectionTitle>Browser</SectionTitle>
      <SettingRow title="Homepage" description="Address new browser panels open to.">
        <TextField value={s.homepage} placeholder="about:blank" onChange={(homepage) => set({ homepage })} width={220} />
      </SettingRow>
      <SettingRow title="Search engine" description="Used when the address bar input isn't a URL.">
        <Select value={s.searchEngine} options={ENGINE_OPTS} onChange={(searchEngine) => set({ searchEngine })} />
      </SettingRow>
      <SettingRow title="URLs from terminal" description="When a local dev-server URL (localhost:PORT) appears in terminal output: open it in a PLANO browser panel, in your system browser, or ignore it.">
        <Select value={s.terminalUrlAction} options={URL_ACTION_OPTS} onChange={(terminalUrlAction) => set({ terminalUrlAction })} width={170} />
      </SettingRow>
    </>
  )
}

// ── Agents (Agent Mesh) ─────────────────────────────────────────────────────
function AgentsSection() {
  const s = useSettingsStore((st) => st.settings.agentMesh)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('agentMesh', p)

  return (
    <>
      <SectionTitle>Agents</SectionTitle>
      <SettingRow
        title="Context persistence"
        description="Write REDACTED agent context (tails + prompts) to the workspace's .plano/context/ so a restart can re-search it. Opt-in — nothing touches disk until you enable it."
      >
        <Toggle checked={s.contextPersistence} onChange={(contextPersistence) => set({ contextPersistence })} />
      </SettingRow>

      <SettingRow
        title="Mesh interconnect"
        description="Agents in your terminals (Claude Code, Codex, Gemini…) connect to each other through the built-in mesh automatically — no configuration."
      >
        <span className="font-mono text-[10px] uppercase tracking-label text-text-4">auto</span>
      </SettingRow>

      <SettingRow
        title="Let agents write to each other"
        description="Off asks for confirmation once per workspace before an agent can message or spawn another."
      >
        <Toggle checked={s.allowAgentWrites} onChange={(allowAgentWrites) => set({ allowAgentWrites })} />
      </SettingRow>
    </>
  )
}

// ── Voice ─────────────────────────────────────────────────────────────────────
const PTT_OPTS: Opt<string>[] = [
  { value: 'Ctrl+Shift+Space', label: 'Ctrl + Shift + Space' },
  { value: 'Ctrl+Space', label: 'Ctrl + Space' },
  { value: 'Ctrl+Shift+V', label: 'Ctrl + Shift + V' },
  { value: 'F4', label: 'F4' },
]
const VOICE_LANG_OPTS: Opt<VoiceLanguage>[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'es', label: 'Spanish' },
  { value: 'en', label: 'English' },
]

const ENGINE_LABEL: Record<VoiceStatus['state'], string> = {
  ready: 'Ready',
  loading: 'Loading model…',
  idle: 'Idle (loads on first use)',
  missing: 'Unavailable',
  error: 'Error',
}

function VoiceEngineRow() {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = (): void => {
    void window.plano.voice.status().then(setStatus).catch(() => undefined)
  }
  useEffect(refresh, [])
  const warm = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.plano.voice.prepare())
    } catch {
      /* ignore */
    } finally {
      setBusy(false)
    }
  }
  const ok = status?.state === 'ready' || status?.state === 'idle' || status?.state === 'loading'
  return (
    <div className="mt-2 rounded-[12px] border border-glass bg-surface-inset p-3 font-mono text-[11px] text-text-tertiary">
      <div className="flex items-center justify-between">
        <span>Speech engine</span>
        <span className={ok ? 'text-text-secondary' : 'text-destructive-hover'}>
          {status ? ENGINE_LABEL[status.state] : 'Checking…'}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span>Model</span>
        <span className="text-text-secondary">{status?.model ?? '—'}</span>
      </div>
      {status?.message && <div className="mt-2 text-text-quaternary">{status.message}</div>}
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="sm" onClick={warm} disabled={busy || status?.state === 'ready' || status?.state === 'missing'}>
          <Icon name={busy ? 'Loader2' : 'Sparkles'} size={14} className={busy ? 'animate-spin' : undefined} />
          {status?.state === 'ready' ? 'Loaded' : 'Warm up model'}
        </Button>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <Icon name="RefreshCw" size={14} />
          Recheck
        </Button>
      </div>
    </div>
  )
}

function VoiceMicRow() {
  const deviceId = useSettingsStore((st) => st.settings.voice.inputDeviceId)
  const patch = useSettingsStore((st) => st.patch)
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([])
  useEffect(() => {
    void listInputDevices().then(setDevices).catch(() => undefined)
  }, [])
  const opts: Opt<string>[] = [
    { value: '', label: 'Auto (prefer real mic)' },
    ...devices.map((d) => ({ value: d.deviceId, label: d.label })),
  ]
  return (
    <SettingRow
      title="Microphone"
      description="Which mic Odla listens to. Auto avoids virtual / router devices (SteelSeries Sonar, VoiceMeeter, Stereo Mix…) whose noise-gates can silence your speech — pick your real microphone if Auto guesses wrong."
    >
      <Select
        value={deviceId}
        options={opts}
        width={260}
        onChange={(id) => {
          patch('voice', { inputDeviceId: id })
          releaseMic() // drop the old stream so the next utterance opens the newly-chosen device
        }}
      />
    </SettingRow>
  )
}

function VoiceSection() {
  const s = useSettingsStore((st) => st.settings.voice)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('voice', p)
  const setGemini = (p: Partial<typeof s.gemini>): void => patch('voice', { gemini: { ...s.gemini, ...p } })
  const setLlm = (p: Partial<typeof s.llmFallback>): void => patch('voice', { llmFallback: { ...s.llmFallback, ...p } })
  return (
    <>
      <SectionTitle>Voice</SectionTitle>
      <SettingRow title="Odla voice assistant" description="A hands-free orchestrator that opens, closes and arranges panels from your voice — fully on-device.">
        <Toggle checked={s.enabled} onChange={(enabled) => set({ enabled })} />
      </SettingRow>
      <SettingRow title="Push-to-talk" description="Hold this shortcut anywhere to talk; release to run the command. Click the puck to toggle hands-free.">
        <Select value={s.pushToTalkKey} options={PTT_OPTS} onChange={(pushToTalkKey) => set({ pushToTalkKey })} width={190} />
      </SettingRow>
      <SettingRow title="Auto-send when you stop talking" description="Runs the command the instant you finish speaking — no need to release the key (releasing still sends immediately). Off = send only on release / second tap.">
        <Toggle checked={s.autoSend} onChange={(autoSend) => set({ autoSend })} />
      </SettingRow>
      <VoiceMicRow />
      <SettingRow title="Language" description="Spoken-command language. The bundled model is multilingual — Auto understands both Spanish and English.">
        <Select value={s.language} options={VOICE_LANG_OPTS} onChange={(language) => set({ language })} width={150} />
      </SettingRow>
      <SettingRow title="Speak responses" description="Read short confirmations back aloud after a command runs.">
        <Toggle checked={s.speakResponses} onChange={(speakResponses) => set({ speakResponses })} />
      </SettingRow>
      <SettingBlock title="Understanding (Gemini)" description="Odla's primary intelligence: Gemini turns your speech into actions, so it can open and move whatever you describe. If it's off or unreachable, the built-in local grammar takes over automatically — voice never breaks.">
        <SettingRow title="Use Gemini" description="Cloud understanding for free-form commands. Falls back to the local engine when off/unreachable.">
          <Toggle checked={s.gemini.enabled} onChange={(enabled) => setGemini({ enabled })} />
        </SettingRow>
        <SettingRow title="API key" description="Your Google Gemini API key. Used only from the app's main process for command parsing.">
          <TextField value={s.gemini.apiKey} placeholder="AIza… / AQ…" onChange={(apiKey) => setGemini({ apiKey })} width={240} />
        </SettingRow>
        <SettingRow title="Model" description="flash-lite is the cheapest + fastest and plenty for commands.">
          <TextField value={s.gemini.model} placeholder="gemini-3.1-flash-lite" onChange={(model) => setGemini({ model })} width={200} />
        </SettingRow>
      </SettingBlock>
      <SettingBlock title="Local engine" description="Runs NVIDIA Parakeet locally via sherpa-onnx for speech-to-text. The model ships inside PLANO — no download, no account, nothing leaves your machine.">
        <VoiceEngineRow />
      </SettingBlock>
      <SettingBlock title="Free-form commands (optional)" description="Off by default. When on, requests the built-in grammar can't parse are sent to an OpenAI-compatible endpoint (a local Ollama by default) for interpretation.">
        <SettingRow title="Enable LLM fallback" description="Only used for utterances the local grammar doesn't recognize.">
          <Toggle checked={s.llmFallback.enabled} onChange={(enabled) => setLlm({ enabled })} />
        </SettingRow>
        <SettingRow title="Endpoint" description="OpenAI-compatible base URL. Defaults to a local Ollama so nothing leaves the machine.">
          <TextField value={s.llmFallback.baseUrl} placeholder="http://localhost:11434/v1" onChange={(baseUrl) => setLlm({ baseUrl })} width={220} />
        </SettingRow>
        <SettingRow title="Model" description="Model name the endpoint should use.">
          <TextField value={s.llmFallback.model} placeholder="llama3.1" onChange={(model) => setLlm({ model })} width={160} />
        </SettingRow>
      </SettingBlock>
    </>
  )
}

// ── Advanced (incl. Privacy) ────────────────────────────────────────────────
function PrivacyBlock() {
  const s = useSettingsStore((st) => st.settings.privacy)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('privacy', p)
  return (
    <div className="mt-6">
      <div className="label-caps mb-2 px-1">Privacy</div>
      <SettingRow title="Telemetry" description="PLANO ships with no analytics or tracking. This switch stays here so the stance is explicit.">
        <Toggle checked={s.telemetry} onChange={(telemetry) => set({ telemetry })} />
      </SettingRow>
      <SettingRow title="Save terminal history" description="Persist terminal scrollback across reopen. (Planned)">
        <Toggle checked={s.saveTerminalHistory} onChange={(saveTerminalHistory) => set({ saveTerminalHistory })} />
      </SettingRow>
    </div>
  )
}

/** "3 min ago" / "just now" — the only thing that makes a check button trustworthy. */
function sinceLabel(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/**
 * Software update — the manual counterpart to the automatic check (15 s after launch, then
 * every 4 h; see main/services/UpdateService). The button reflects the real updater phase, so
 * pressing it can never lie: it downloads through the same pipeline the banner renders.
 */
function UpdateRow() {
  // Own its version read: nesting this under AboutRow made the update button vanish whenever
  // getInfo() failed, which is exactly when a user is most likely to go looking for it.
  const [current, setCurrent] = useState('')
  useEffect(() => {
    void window.plano.app
      .getInfo()
      .then((i) => setCurrent(i.versions.app))
      .catch(() => undefined)
  }, [])
  const phase = useUpdateStore((s) => s.phase)
  const canCheck = useUpdateStore((s) => s.canCheck)
  const target = useUpdateStore((s) => s.version)
  const percent = useUpdateStore((s) => s.percent)
  const message = useUpdateStore((s) => s.message)
  const manualUpdateMessage = useUpdateStore((s) => s.manualUpdateMessage)
  const checkedAt = useUpdateStore((s) => s.checkedAt)
  const checkNow = useUpdateStore((s) => s.checkNow)
  const installNow = useUpdateStore((s) => s.installNow)

  const status = ((): string => {
    if (phase === 'manual-required') return manualUpdateMessage ?? 'Manual update required'
    if (!canCheck) return 'Development build'
    if (phase === 'checking') return 'Checking…'
    if (phase === 'downloading') return `Downloading ${target ?? ''} · ${Math.round(percent ?? 0)}%`
    if (phase === 'downloaded') return `${target ?? 'Update'} ready to install`
    if (phase === 'error') return message ?? 'Check failed'
    if (checkedAt) return `Checked ${sinceLabel(checkedAt)}`
    return ''
  })()

  return (
    <SettingRow title={current ? `Version ${current}` : 'Version'} description={status || undefined}>
      {phase === 'downloaded' ? (
        <Button variant="primary" size="sm" onClick={() => void installNow()}>
          <Icon name="RefreshCw" size={14} />
          Restart to update
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={!canCheck || phase === 'checking' || phase === 'downloading'}
          onClick={() => void checkNow()}
        >
          <Icon name="RefreshCw" size={14} className={phase === 'checking' ? 'animate-spin' : undefined} />
          Check for updates
        </Button>
      )}
    </SettingRow>
  )
}

function AboutRow() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.plano.app.getInfo().then(setInfo).catch(() => undefined)
  }, [])
  if (!info) return null
  const v = info.versions
  return (
    <div className="mt-2 rounded-[12px] border border-glass bg-surface-inset p-3 font-mono text-[11px] text-text-tertiary">
      <div className="flex justify-between"><span>PLANO</span><span className="text-text-secondary">{v.app}</span></div>
      <div className="flex justify-between"><span>Electron</span><span className="text-text-secondary">{v.electron}</span></div>
      <div className="flex justify-between"><span>Chromium</span><span className="text-text-secondary">{v.chrome}</span></div>
      <div className="flex justify-between"><span>Node</span><span className="text-text-secondary">{v.node}</span></div>
      <div className="flex justify-between"><span>Platform</span><span className="text-text-secondary">{info.platform}</span></div>
    </div>
  )
}

function AdvancedSection() {
  const s = useSettingsStore((st) => st.settings.advanced)
  const patch = useSettingsStore((st) => st.patch)
  const reset = useSettingsStore((st) => st.reset)
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <SectionTitle>Advanced</SectionTitle>
      <SettingRow title="Hardware acceleration" description="GPU compositing for the canvas and web panels. Takes effect on next launch.">
        <Toggle checked={s.hardwareAcceleration} onChange={(hardwareAcceleration) => patch('advanced', { hardwareAcceleration })} />
      </SettingRow>
      <SettingRow title="Reset settings" description="Restore every preference on this page to its default value.">
        {confirming ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                reset()
                setConfirming(false)
              }}
              className="app-no-drag h-8 rounded-[12px] border border-destructive-border bg-destructive-soft px-3 text-[12px] font-medium text-destructive-hover transition-colors hover:bg-destructive hover:text-white focus-caliper-danger"
            >
              Confirm reset
            </button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            <Icon name="RotateCcw" size={14} />
            Reset to defaults
          </Button>
        )}
      </SettingRow>
      <PrivacyBlock />
      <div className="pt-4">
        <div className="label-caps mb-1 px-1">About</div>
        <UpdateRow />
        <AboutRow />
      </div>
    </>
  )
}

// ── registry + search index ─────────────────────────────────────────────────
export const SECTIONS: { id: SettingsSection; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'SlidersHorizontal' },
  { id: 'appearance', label: 'Appearance', icon: 'Palette' },
  { id: 'usage', label: 'Usage', icon: 'Gauge' },
  { id: 'terminal', label: 'Terminal', icon: 'SquareTerminal' },
  { id: 'editor', label: 'Editor', icon: 'FileCode' },
  { id: 'browser', label: 'Browser', icon: 'Globe' },
  { id: 'agents', label: 'Agents', icon: 'Sparkles' },
  { id: 'voice', label: 'Voice', icon: 'Mic' },
  { id: 'mobile', label: 'Mobile & Remote', icon: 'Smartphone' },
  { id: 'advanced', label: 'Advanced', icon: 'Wrench' },
]

export const SECTION_COMPONENTS: Record<SettingsSection, () => ReactElement> = {
  general: GeneralSection,
  appearance: AppearanceSection,
  usage: UsageSection,
  terminal: TerminalSection,
  editor: EditorSection,
  browser: BrowserSection,
  agents: AgentsSection,
  voice: VoiceSection,
  mobile: MobileSection,
  advanced: AdvancedSection,
}

/** Flat index for the search box — section + setting title + extra keywords. */
export const SETTINGS_INDEX: { section: SettingsSection; title: string; keywords: string }[] = [
  { section: 'general', title: 'Restore last workspace', keywords: 'launch startup reopen project' },
  { section: 'general', title: 'Restore agent sessions', keywords: 'resume conversation claude codex cursor gemini kiro agent reopen continue session' },
  { section: 'general', title: 'Show files on launch', keywords: 'explorer panel startup' },
  { section: 'general', title: 'Warn before quitting', keywords: 'confirm close exit' },
  { section: 'general', title: 'Confirm closing agent terminals', keywords: 'agent process running close claude codex' },
  { section: 'general', title: 'Agent finished sound', keywords: 'chime sound audio bell notification ready done complete agent alert' },
  { section: 'general', title: 'Agent finished notifications', keywords: 'toast in-app notify waiting input blocked background workspace awareness' },
  { section: 'general', title: 'Snap to grid', keywords: 'canvas align panels' },
  { section: 'general', title: 'Zoom sensitivity', keywords: 'canvas wheel speed' },
  { section: 'general', title: 'Autosave', keywords: 'save workspace persist' },
  { section: 'mobile', title: 'Mobile web app', keywords: 'phone remote lan wifi qr scan connect web app mobile android ios tablet' },
  { section: 'mobile', title: 'Remote access', keywords: 'token pairing security same network' },
  { section: 'appearance', title: 'Theme', keywords: 'dark light color monolith indigo orange tokyo sakura pearl mist paper white' },
  { section: 'appearance', title: 'Accent color', keywords: 'highlight tint cyan purple magenta rose lime teal swatch' },
  { section: 'appearance', title: 'Reduce motion', keywords: 'animation accessibility' },
  { section: 'appearance', title: 'Show minimap', keywords: 'overview map canvas' },
  { section: 'usage', title: 'Show status bar', keywords: 'usage quota subscription chip bottom bar ports resources agents live' },
  { section: 'usage', title: 'Provider chips', keywords: 'claude codex opencode gemini grok omp quota visibility' },
  { section: 'usage', title: 'Ports chip', keywords: 'dev server listening port terminal' },
  { section: 'usage', title: 'Resources chip', keywords: 'memory rss ram agents' },
  { section: 'usage', title: 'Agents chip', keywords: 'live agent count running terminals' },
  { section: 'usage', title: 'OpenCode Go cookie', keywords: 'opencode auth token cookie quota monthly usage' },
  { section: 'appearance', title: 'Canvas background', keywords: 'gradient solid radial linear wallpaper substrate color' },
  { section: 'appearance', title: 'Ambient glow', keywords: 'accent halo aura light' },
  { section: 'appearance', title: 'Grid style', keywords: 'dots lines background canvas blueprint' },
  { section: 'appearance', title: 'Grid size', keywords: 'spacing fine coarse drafting' },
  { section: 'appearance', title: 'Grid strength', keywords: 'opacity grid' },
  { section: 'terminal', title: 'Shell', keywords: 'powershell cmd bash zsh pwsh' },
  { section: 'terminal', title: 'Shell path', keywords: 'executable terminal' },
  { section: 'terminal', title: 'Font family', keywords: 'terminal typeface mono' },
  { section: 'terminal', title: 'Font size', keywords: 'terminal text' },
  { section: 'terminal', title: 'Line height', keywords: 'terminal spacing' },
  { section: 'terminal', title: 'Cursor', keywords: 'caret blink bar block' },
  { section: 'terminal', title: 'Scrollback', keywords: 'history buffer memory' },
  { section: 'terminal', title: 'Copy on select', keywords: 'clipboard terminal' },
  { section: 'terminal', title: 'Predictive history', keywords: 'autocomplete autosuggest warp ghost inline tab history psreadline recall suggestions previous commands' },
  { section: 'terminal', title: 'Smart actions', keywords: 'links device codes paths' },
  { section: 'terminal', title: 'Suspend background terminals', keywords: 'hibernate memory pause workspace background idle suspend gpu' },
  { section: 'terminal', title: 'Keep agents when closing', keywords: 'agent host background daemon quit close' },
  { section: 'terminal', title: 'Terminal theme', keywords: 'color palette midnight amber matrix paper campbell windows terminal' },
  { section: 'editor', title: 'Font size', keywords: 'editor code text' },
  { section: 'editor', title: 'Tab size', keywords: 'indent spaces' },
  { section: 'editor', title: 'Word wrap', keywords: 'editor wrap lines' },
  { section: 'editor', title: 'Line numbers', keywords: 'gutter editor' },
  { section: 'browser', title: 'Homepage', keywords: 'browser url start' },
  { section: 'browser', title: 'Search engine', keywords: 'google bing duckduckgo brave' },
  { section: 'browser', title: 'URLs from terminal', keywords: 'links open localhost dev server preview port npm run auto' },
  { section: 'agents', title: 'Agent Mesh', keywords: 'mesh control center compose dispatch multi agent cross workspace roster' },
  { section: 'agents', title: 'Context persistence', keywords: 'search index redacted tail prompts restartable persist plano context folder' },
  { section: 'voice', title: 'Odla voice assistant', keywords: 'odla voice speech microphone parakeet hands-free orchestrator control panels dictation' },
  { section: 'voice', title: 'Push-to-talk', keywords: 'shortcut hold key mic talk listen' },
  { section: 'voice', title: 'Language', keywords: 'spanish english multilingual espanol ingles' },
  { section: 'voice', title: 'Speak responses', keywords: 'tts text to speech voice reply' },
  { section: 'voice', title: 'LLM fallback', keywords: 'ollama openai free form natural language endpoint model' },
  { section: 'advanced', title: 'Hardware acceleration', keywords: 'gpu performance' },
  { section: 'advanced', title: 'Reset settings', keywords: 'defaults restore' },
  { section: 'advanced', title: 'Telemetry', keywords: 'analytics tracking privacy' },
  { section: 'advanced', title: 'Save terminal history', keywords: 'scrollback persist privacy' },
  { section: 'advanced', title: 'About', keywords: 'version electron node chromium' },
  { section: 'advanced', title: 'Check for updates', keywords: 'update upgrade version release download install' },
]
