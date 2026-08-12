import type { StickyTone } from '@shared/domain/panel'

export interface StickyToneDef {
  id: StickyTone
  label: string
  color: string
  background: string
}

/**
 * Sticky-note tones. The DEFAULT tone is amber — the design's sticky panel is a warm yellow
 * glass (#FBBF24 wash + #FFE9A8 ink). Shared by the StickyNotePanel body and the PanelFrame
 * chrome (border tint), so both read the same tone.
 */
export const STICKY_TONES: StickyToneDef[] = [
  { id: 'amber', label: 'Amber', color: '#fbbf24', background: 'rgba(251, 191, 36, 0.10)' },
  { id: 'stone', label: 'Stone', color: '#a8a29e', background: 'rgba(168, 162, 158, 0.12)' },
  { id: 'sage', label: 'Sage', color: '#84cc9a', background: 'rgba(132, 204, 154, 0.12)' },
  { id: 'sky', label: 'Sky', color: '#7dd3fc', background: 'rgba(125, 211, 252, 0.12)' },
  { id: 'rose', label: 'Rose', color: '#f9a8d4', background: 'rgba(249, 168, 212, 0.12)' },
  { id: 'slate', label: 'Slate', color: '#94a3b8', background: 'rgba(148, 163, 184, 0.12)' },
]

export function stickyToneColor(tone?: StickyTone): string {
  return (STICKY_TONES.find((t) => t.id === tone) ?? STICKY_TONES[0]).color
}

export function stickyToneBackground(tone?: StickyTone): string {
  const def = STICKY_TONES.find((t) => t.id === tone) ?? STICKY_TONES[0]
  return def.background
}
