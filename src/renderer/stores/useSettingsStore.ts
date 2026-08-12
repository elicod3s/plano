import { create } from 'zustand'
import { DEFAULT_SETTINGS, mergeSettings, type PlanoSettings } from '@shared/domain/settings'
import { applyAppearance } from '@/theme/themes'
import { useUiStore } from './useUiStore'

/** The Settings sidebar sections, in display order (matching the new UI design rail). */
export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'usage'
  | 'terminal'
  | 'editor'
  | 'browser'
  | 'agents'
  | 'voice'
  | 'mobile'
  | 'advanced'

interface SettingsStore {
  settings: PlanoSettings
  hydrated: boolean
  /** Modal visibility + which section is shown. */
  open: boolean
  section: SettingsSection
  /** Optional jump target (e.g. open straight to a section from a deep link). */
  hydrate: () => Promise<void>
  setOpen: (open: boolean) => void
  openTo: (section: SettingsSection) => void
  toggleOpen: () => void
  setSection: (section: SettingsSection) => void
  /** Patch one settings group; applies side-effects + debounced-persists. */
  patch: <K extends keyof PlanoSettings>(group: K, patch: Partial<PlanoSettings[K]>) => void
  reset: () => void
}

// Persist is debounced so dragging a slider doesn't hammer the disk; the in-memory store
// is the source of truth for the UI and updates synchronously.
let saveTimer: ReturnType<typeof setTimeout> | undefined
function persist(settings: PlanoSettings): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void window.plano.settings.save(settings).catch(() => undefined)
  }, 250)
}

/** Mirror persisted canvas prefs into the live UI store the canvas already reads. */
function syncCanvas(settings: PlanoSettings): void {
  const ui = useUiStore.getState()
  ui.setSnapping(settings.canvas.snapToGrid)
  ui.setMinimap(settings.canvas.showMinimap)
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  open: false,
  section: 'general',

  hydrate: async () => {
    let next = DEFAULT_SETTINGS
    try {
      // Merge over the defaults instead of trusting the payload: main can be a step behind the
      // renderer (electron-vite hot-reloads the renderer instantly but restarts main), and a
      // settings object missing a whole group — one the renderer already reads — crashed the
      // first render with "Cannot read properties of undefined". mergeSettings is the same
      // tolerant merge main uses, so every group is guaranteed present and typed.
      next = mergeSettings(await window.plano.settings.get())
    } catch {
      /* fall back to defaults */
    }
    applyAppearance(next.appearance)
    syncCanvas(next)
    set({ settings: next, hydrated: true })
  },

  setOpen: (open) => set({ open }),
  openTo: (section) => set({ open: true, section }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setSection: (section) => set({ section }),

  patch: (group, patch) => {
    const cur = get().settings
    const next: PlanoSettings = {
      ...cur,
      [group]: { ...(cur[group] as object), ...patch } as PlanoSettings[typeof group],
    }
    if (group === 'appearance') applyAppearance(next.appearance)
    if (group === 'canvas') syncCanvas(next)
    set({ settings: next })
    persist(next)
  },

  reset: () => {
    applyAppearance(DEFAULT_SETTINGS.appearance)
    syncCanvas(DEFAULT_SETTINGS)
    set({ settings: DEFAULT_SETTINGS })
    persist(DEFAULT_SETTINGS)
  },
}))
