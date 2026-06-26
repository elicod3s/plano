/**
 * The Settings sections. Each is a small component bound to useSettingsStore; the SECTIONS
 * list drives the sidebar and SETTINGS_INDEX powers search. Copy is ours (blueprint voice),
 * not lifted from any reference — only the underlying capabilities overlap.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { useSettingsStore, type SettingsSection } from '@/stores/useSettingsStore'
import { SEARCH_ENGINES, type SearchEngineId, type ShellChoice, type TerminalUrlAction, type VoiceLanguage } from '@shared/domain/settings'
import type { AppInfo, VoiceStatus } from '@shared/ipc/contracts'
import { Toggle } from '@/design-system/Toggle'
import { Button } from '@/design-system/Button'
import { Icon } from '@/design-system/Icon'
import {
  SectionTitle,
  SettingRow,
  SettingBlock,
  Segmented,
  Slider,
  Select,
  TextField,
  NumberField,
  PlaceholderCard,
  type Opt,
} from './controls'
import { ThemeGallery, AccentSwatches, TerminalThemeGallery, GridStylePicker } from './galleries'
import { listInputDevices, releaseMic } from '@/voice/audio/mic'

const pct = (v: number): string => `${Math.round(v * 100)}%`

// ── General ───────────────────────────────────────────────────────────────
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
    </>
  )
}

// ── Account (placeholder — no auth backend yet) ─────────────────────────────
function AccountSection() {
  return (
    <>
      <SectionTitle>Account</SectionTitle>
      <div className="py-2">
        <PlaceholderCard
          icon="UserRound"
          title="Sign-in is coming"
          body="PLANO runs fully local today. Cloud sign-in — synced settings, workspaces and agent history across machines — lands in a future build."
        />
      </div>
    </>
  )
}

// ── Appearance ──────────────────────────────────────────────────────────────
function AppearanceSection() {
  const s = useSettingsStore((st) => st.settings.appearance)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('appearance', p)
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <SettingBlock title="Theme" description="Monolith is the default monochrome look. Colored and light themes are opt-in.">
        <ThemeGallery value={s.theme} onChange={(theme) => set({ theme })} />
      </SettingBlock>
      <SettingBlock title="Accent" description={`Used sparingly for active states and focus · ${s.accent}`}>
        <AccentSwatches value={s.accent} onChange={(accent) => set({ accent })} />
      </SettingBlock>
      <SettingBlock title="Grid style" description="The blueprint pattern drawn on the canvas substrate.">
        <GridStylePicker value={s.gridStyle} onChange={(gridStyle) => set({ gridStyle })} />
      </SettingBlock>
      <SettingRow title="Grid strength" description="How prominent the canvas grid reads.">
        <Slider value={s.gridOpacity} min={0} max={1} step={0.05} onChange={(gridOpacity) => set({ gridOpacity })} format={pct} />
      </SettingRow>
      <SettingRow title="Film grain" description="A faint monochrome grain over the canvas for depth.">
        <Toggle checked={s.grain} onChange={(grain) => set({ grain })} />
      </SettingRow>
      <SettingRow title="Reduce motion" description="Damp animations and transitions regardless of the OS setting.">
        <Toggle checked={s.reduceMotion} onChange={(reduceMotion) => set({ reduceMotion })} />
      </SettingRow>
    </>
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
  return (
    <>
      <SectionTitle>Terminal</SectionTitle>
      <SettingRow title="Shell" description="Program launched for new terminals. The explicit path below overrides this.">
        <Select value={s.shell} options={SHELL_OPTS} onChange={(shell) => set({ shell })} width={190} />
      </SettingRow>
      <SettingRow title="Shell path" description="Absolute path to a shell executable. Leave blank to use the choice above.">
        <TextField value={s.shellPath} placeholder="Auto-detect" onChange={(shellPath) => set({ shellPath })} width={210} />
      </SettingRow>
      <SettingRow title="Font family" description="Override the terminal typeface. Blank uses the bundled JetBrains Mono.">
        <TextField value={s.fontFamily} placeholder="e.g. Cascadia Code" onChange={(fontFamily) => set({ fontFamily })} width={210} />
      </SettingRow>
      <SettingRow title="Font size" description="0 keeps the default (13)." >
        <NumberField value={s.fontSize} min={0} max={32} onChange={(fontSize) => set({ fontSize })} suffix="px" />
      </SettingRow>
      <SettingRow title="Line height" description="Vertical spacing between terminal rows. Capped at 1.2 — higher values reopen gaps that tear CLI block-art.">
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
      <SettingRow title="Auto-suspend idle terminals" description="Pause silent, offscreen terminals to reclaim memory. (Planned)">
        <Toggle checked={s.autoSuspendIdle} onChange={(autoSuspendIdle) => set({ autoSuspendIdle })} />
      </SettingRow>
      <SettingBlock title="Terminal theme" description="Default palette for new terminals. Each terminal can override it from its panel.">
        <TerminalThemeGallery value={s.theme} onChange={(theme) => set({ theme })} />
      </SettingBlock>
    </>
  )
}

// ── Canvas & Workspace ──────────────────────────────────────────────────────
function CanvasSection() {
  const s = useSettingsStore((st) => st.settings.canvas)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('canvas', p)
  return (
    <>
      <SectionTitle>Canvas &amp; Workspace</SectionTitle>
      <SettingRow title="Snap to grid" description="Align panels to the 8px grid while moving and resizing.">
        <Toggle checked={s.snapToGrid} onChange={(snapToGrid) => set({ snapToGrid })} />
      </SettingRow>
      <SettingRow title="Show minimap" description="The overview map in the corner of the canvas.">
        <Toggle checked={s.showMinimap} onChange={(showMinimap) => set({ showMinimap })} />
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
    <div className="mt-2 rounded-md border border-subtle bg-surface-inset p-3 font-mono text-[11px] text-text-tertiary">
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
      <SectionTitle>Odla — Voice</SectionTitle>
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

// ── Privacy ─────────────────────────────────────────────────────────────────
function PrivacySection() {
  const s = useSettingsStore((st) => st.settings.privacy)
  const patch = useSettingsStore((st) => st.patch)
  const set = (p: Partial<typeof s>): void => patch('privacy', p)
  return (
    <>
      <SectionTitle>Privacy</SectionTitle>
      <SettingRow title="Telemetry" description="PLANO ships with no analytics or tracking. This switch stays here so the stance is explicit.">
        <Toggle checked={s.telemetry} onChange={(telemetry) => set({ telemetry })} />
      </SettingRow>
      <SettingRow title="Save terminal history" description="Persist terminal scrollback across reopen. (Planned)">
        <Toggle checked={s.saveTerminalHistory} onChange={(saveTerminalHistory) => set({ saveTerminalHistory })} />
      </SettingRow>
    </>
  )
}

// ── Advanced ────────────────────────────────────────────────────────────────
function AboutRow() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.plano.app.getInfo().then(setInfo).catch(() => undefined)
  }, [])
  if (!info) return null
  const v = info.versions
  return (
    <div className="mt-2 rounded-md border border-subtle bg-surface-inset p-3 font-mono text-[11px] text-text-tertiary">
      <div className="flex justify-between"><span>PLANO</span><span className="text-text-secondary">Personal build</span></div>
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
              className="app-no-drag h-8 rounded-sm border border-destructive-border bg-destructive-soft px-3 text-[12px] font-medium text-destructive-hover transition-colors hover:bg-destructive hover:text-white focus-caliper-danger"
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
      <div className="pt-4">
        <div className="label-caps mb-1 px-1">About</div>
        <AboutRow />
      </div>
    </>
  )
}

// ── registry + search index ─────────────────────────────────────────────────
export const SECTIONS: { id: SettingsSection; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'Settings2' },
  { id: 'appearance', label: 'Appearance', icon: 'Palette' },
  { id: 'editor', label: 'Editor', icon: 'Code2' },
  { id: 'terminal', label: 'Terminal', icon: 'SquareTerminal' },
  { id: 'canvas', label: 'Canvas', icon: 'LayoutGrid' },
  { id: 'browser', label: 'Browser', icon: 'Globe' },
  { id: 'voice', label: 'Odla', icon: 'Mic' },
  { id: 'privacy', label: 'Privacy', icon: 'ShieldCheck' },
  { id: 'account', label: 'Account', icon: 'UserRound' },
  { id: 'advanced', label: 'Advanced', icon: 'Wrench' },
]

export const SECTION_COMPONENTS: Record<SettingsSection, () => ReactElement> = {
  general: GeneralSection,
  account: AccountSection,
  appearance: AppearanceSection,
  editor: EditorSection,
  terminal: TerminalSection,
  canvas: CanvasSection,
  browser: BrowserSection,
  voice: VoiceSection,
  privacy: PrivacySection,
  advanced: AdvancedSection,
}

/** Flat index for the search box — section + setting title + extra keywords. */
export const SETTINGS_INDEX: { section: SettingsSection; title: string; keywords: string }[] = [
  { section: 'general', title: 'Restore last workspace', keywords: 'launch startup reopen project' },
  { section: 'general', title: 'Restore agent sessions', keywords: 'resume conversation claude codex cursor gemini kiro agent reopen continue session' },
  { section: 'general', title: 'Show files on launch', keywords: 'explorer panel startup' },
  { section: 'general', title: 'Warn before quitting', keywords: 'confirm close exit' },
  { section: 'general', title: 'Confirm closing agent terminals', keywords: 'agent process running close claude codex' },
  { section: 'account', title: 'Account', keywords: 'sign in login profile sync cloud' },
  { section: 'appearance', title: 'Theme', keywords: 'dark light color monolith indigo cyber carbon slate' },
  { section: 'appearance', title: 'Accent color', keywords: 'highlight tint' },
  { section: 'appearance', title: 'Grid style', keywords: 'dots lines background canvas blueprint' },
  { section: 'appearance', title: 'Grid strength', keywords: 'opacity grid' },
  { section: 'appearance', title: 'Film grain', keywords: 'texture noise' },
  { section: 'appearance', title: 'Reduce motion', keywords: 'animation accessibility' },
  { section: 'editor', title: 'Font size', keywords: 'editor code text' },
  { section: 'editor', title: 'Tab size', keywords: 'indent spaces' },
  { section: 'editor', title: 'Word wrap', keywords: 'editor wrap lines' },
  { section: 'editor', title: 'Line numbers', keywords: 'gutter editor' },
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
  { section: 'terminal', title: 'Auto-suspend idle terminals', keywords: 'memory pause' },
  { section: 'terminal', title: 'Terminal theme', keywords: 'color palette midnight amber matrix paper' },
  { section: 'canvas', title: 'Snap to grid', keywords: 'align panels' },
  { section: 'canvas', title: 'Show minimap', keywords: 'overview map' },
  { section: 'canvas', title: 'Zoom sensitivity', keywords: 'wheel speed' },
  { section: 'canvas', title: 'Autosave', keywords: 'save workspace persist' },
  { section: 'browser', title: 'Homepage', keywords: 'browser url start' },
  { section: 'browser', title: 'Search engine', keywords: 'google bing duckduckgo brave' },
  { section: 'browser', title: 'URLs from terminal', keywords: 'links open localhost dev server preview port npm run auto' },
  { section: 'voice', title: 'Odla voice assistant', keywords: 'odla voice speech microphone parakeet hands-free orchestrator control panels dictation' },
  { section: 'voice', title: 'Push-to-talk', keywords: 'shortcut hold key mic talk listen' },
  { section: 'voice', title: 'Language', keywords: 'spanish english multilingual espanol ingles' },
  { section: 'voice', title: 'Speak responses', keywords: 'tts text to speech voice reply' },
  { section: 'voice', title: 'LLM fallback', keywords: 'ollama openai free form natural language endpoint model' },
  { section: 'privacy', title: 'Telemetry', keywords: 'analytics tracking' },
  { section: 'privacy', title: 'Save terminal history', keywords: 'scrollback persist' },
  { section: 'advanced', title: 'Hardware acceleration', keywords: 'gpu performance' },
  { section: 'advanced', title: 'Reset settings', keywords: 'defaults restore' },
  { section: 'advanced', title: 'About', keywords: 'version electron node chromium' },
]
