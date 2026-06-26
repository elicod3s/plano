/**
 * The command registry — ONE source of truth for every keyboard-driven action and panel-creation
 * command. useHotkeys runs them by key, the command palette lists them with their shortcut, and the
 * dock + context menu show the same shortcut. Add a command (or change a key) here and every surface
 * updates together, so the keys shown can never drift from the keys that actually fire.
 *
 * Keymap design (Windows-first, macOS-aware via the "Ctrl"=Ctrl|Cmd rule):
 *  - One Alt+<letter> per panel type — a single keystroke, mnemonic, and collision-free even across
 *    13 panel types. The terminal additionally gets a GLOBAL Ctrl+` (fires even from inside a
 *    focused terminal, VS Code muscle-memory) so "open a terminal" is always one key away.
 *  - App / workspace / view actions keep conventional Ctrl combos and are `global` (work while
 *    typing). Panel-creation is NOT global: it's suppressed while a text field / terminal is focused
 *    so it never eats a keystroke meant for the shell or an editor.
 */

import { PANEL_META, type PanelType } from '@shared/domain/panel'
import { addPanelAtCenter, zoomToFitAll } from '@/app/actions'
import { openFolder, saveCurrent, createNewSpace, closeWorkspace } from '@/app/workspaceActions'
import { useUiStore } from '@/stores/useUiStore'
import { useViewportStore } from '@/stores/useViewportStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { voiceController } from '@/voice/controller'
import { parseCombo, type ParsedCombo } from '@/lib/keymap'

export type CommandGroup = 'Create' | 'Workspace' | 'View' | 'App'

export interface CommandBinding {
  keys: string
  /** Fires even while a text field / terminal is focused. Panel-creation bindings are NOT global. */
  global?: boolean
}

export interface Command {
  id: string
  label: string
  icon: string
  group: CommandGroup
  /** Key bindings; the first is the one shown in the UI. Omit for palette-only commands. */
  bindings?: CommandBinding[]
  /** Present for panel-creation commands so a surface can place the panel itself (e.g. at a point). */
  panelType?: PanelType
  run: () => void
}

const viewport = (): { width: number; height: number } => ({
  width: window.innerWidth,
  height: window.innerHeight,
})

/** Alt+<letter> per panel type (the order is also the create-section order in the palette). */
const CREATE_ORDER: ReadonlyArray<readonly [PanelType, string]> = [
  ['terminal', 'Alt+T'],
  ['editor', 'Alt+E'],
  ['browser', 'Alt+B'],
  ['agent', 'Alt+A'],
  ['git', 'Alt+G'],
  ['markdown', 'Alt+M'],
  ['todo', 'Alt+L'],
  ['pomodoro', 'Alt+P'],
  ['sticky', 'Alt+S'],
  ['region', 'Alt+R'],
  ['label', 'Alt+X'],
]

const createCommands: Command[] = CREATE_ORDER.map(([type, keys]) => ({
  id: `create:${type}`,
  label: PANEL_META[type].label,
  icon: PANEL_META[type].icon,
  group: 'Create',
  panelType: type,
  // Terminal also answers a global Ctrl+` so it opens from anywhere — even a focused terminal.
  bindings: type === 'terminal' ? [{ keys }, { keys: 'Ctrl+`', global: true }] : [{ keys }],
  run: () => addPanelAtCenter(type),
}))

const actionCommands: Command[] = [
  {
    id: 'app:palette',
    label: 'Command Palette',
    icon: 'LayoutGrid',
    group: 'App',
    bindings: [
      { keys: 'Ctrl+K', global: true },
      { keys: 'Ctrl+Shift+E', global: true },
    ],
    run: () => useUiStore.getState().toggleCommandPalette(),
  },
  {
    id: 'ws:new',
    label: 'New Workspace',
    icon: 'Plus',
    group: 'Workspace',
    bindings: [{ keys: 'Ctrl+N', global: true }],
    run: () => {
      createNewSpace()
    },
  },
  {
    id: 'app:open',
    label: 'Open Folder…',
    icon: 'FolderOpen',
    group: 'App',
    bindings: [{ keys: 'Ctrl+O', global: true }],
    run: () => void openFolder(),
  },
  {
    id: 'app:save',
    label: 'Save Workspace',
    icon: 'Save',
    group: 'App',
    bindings: [{ keys: 'Ctrl+S', global: true }],
    run: () => void saveCurrent(),
  },
  {
    id: 'app:close',
    label: 'Close Project',
    icon: 'FolderX',
    group: 'App',
    bindings: [{ keys: 'Ctrl+Shift+W', global: true }],
    run: () => void closeWorkspace(),
  },
  {
    id: 'view:fit',
    label: 'Zoom to Fit',
    icon: 'Maximize2',
    group: 'View',
    bindings: [{ keys: 'Ctrl+Shift+F', global: true }],
    run: () => zoomToFitAll(),
  },
  {
    id: 'view:reset-zoom',
    label: 'Reset Zoom',
    icon: 'Search',
    group: 'View',
    bindings: [{ keys: 'Ctrl+0', global: true }],
    run: () => useViewportStore.getState().zoomTo(1, viewport()),
  },
  {
    id: 'view:minimap',
    label: 'Toggle Minimap',
    icon: 'Map',
    group: 'View',
    run: () => useUiStore.getState().toggleMinimap(),
  },
  {
    id: 'view:snapping',
    label: 'Toggle Snapping',
    icon: 'Magnet',
    group: 'View',
    run: () => useUiStore.getState().toggleSnapping(),
  },
  {
    id: 'app:settings',
    label: 'Settings…',
    icon: 'Settings',
    group: 'App',
    bindings: [{ keys: 'Ctrl+,', global: true }],
    run: () => useSettingsStore.getState().setOpen(true),
  },
  {
    // The voice assistant's primary trigger is HOLDing the push-to-talk key (Settings → Voice);
    // this is the tap-to-toggle entry point for the palette/dock and the Alt+V shortcut.
    id: 'voice:toggle',
    label: 'Odla — Voice Assistant',
    icon: 'Mic',
    group: 'App',
    bindings: [{ keys: 'Alt+V', global: true }],
    run: () => voiceController.toggle(),
  },
]

export const COMMANDS: Command[] = [...createCommands, ...actionCommands]

/** Flat, pre-parsed keymap for the global key handler (built once at module load). */
export const KEYMAP: ReadonlyArray<{ combo: ParsedCombo; global: boolean; run: () => void }> =
  COMMANDS.flatMap((c) =>
    (c.bindings ?? []).map((b) => ({ combo: parseCombo(b.keys), global: !!b.global, run: c.run })),
  )

/** The shortcut shown in the UI for a command (its first binding), or undefined. */
export const primaryShortcut = (c: Command): string | undefined => c.bindings?.[0]?.keys

/** The shortcut for a panel-creation command, e.g. shortcutForPanel('terminal') → 'Alt+T'. */
export function shortcutForPanel(type: PanelType): string | undefined {
  const c = COMMANDS.find((x) => x.panelType === type)
  return c ? primaryShortcut(c) : undefined
}
