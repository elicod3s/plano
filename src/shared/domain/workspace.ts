/**
 * The persisted workspace document. Written to <projectFolder>/.plano/workspace.json.
 *
 * A document holds one or more **spaces** — independent canvases the user switches
 * between from the top bar. Each space is its own set of panels + camera, so a single
 * project can keep several parallel working contexts (e.g. one space per task/agent).
 * Bump SCHEMA_VERSION and add a migration whenever the shape changes.
 */

import type { Panel } from './panel'
import type { Transform } from './geometry'

export const SCHEMA_VERSION = 2

export interface Viewport extends Transform {}

/** A grouping frame that moves its contained panels together. */
export interface Region {
  id: string
  rect: { x: number; y: number; width: number; height: number }
  label: string
}

/**
 * One independent **workspace**: its own folder (project), panels, camera and regions. The folder
 * is per-workspace — opening a different folder in one workspace never touches another's. A blank
 * workspace has `folderPath: null` (the "no project picked yet" state, shown as "choose folder").
 */
export interface Space {
  id: string
  name: string
  /** This workspace's own project folder, or null when none is picked yet. */
  folderPath: string | null
  viewport: Viewport
  panels: Panel[]
  regions: Region[]
}

export interface WorkspaceMeta {
  name: string
}

export interface WorkspaceDoc {
  schemaVersion: number
  savedAt: string
  meta: WorkspaceMeta
  /** Which space is shown on load. Always references an existing `spaces` entry. */
  activeSpaceId: string
  spaces: Space[]
}

export interface RecentWorkspace {
  path: string
  name: string
  lastOpened: string
}

/** A blank workspace with the given id + display name (no folder picked unless one is passed). */
export function createSpace(id: string, name: string, folderPath: string | null = null): Space {
  return { id, name, folderPath, viewport: { x: 0, y: 0, zoom: 1 }, panels: [], regions: [] }
}

/**
 * An auto-generated, position-derived space name ("Workspace", "Workspace 3", …) as opposed to a
 * name the user deliberately typed. Blank counts as auto. We never overwrite a custom name.
 */
export function isAutoSpaceName(name: string): boolean {
  const t = name.trim()
  return t === '' || /^Workspace(\s+\d+)?$/i.test(t)
}

/**
 * Keep auto-named spaces numbered by their 1-based position ("Workspace 1", "Workspace 2", …) so the
 * displayed name can never drift from a space's actual slot — which is also what the switcher index
 * badge, the Ctrl+1–9 jump, and the command palette all key off. Custom (user-renamed) spaces are
 * left untouched. Idempotent: re-running it changes nothing once names are in sync.
 *
 * This is the single invariant that prevents orphaned numbers — e.g. a lone space left named
 * "Workspace 2" after deleting "Workspace 1" heals back to "Workspace 1" on the next list mutation.
 */
export function renumberDefaultSpaces(spaces: Space[]): Space[] {
  return spaces.map((s, i) => {
    if (!isAutoSpaceName(s.name)) return s
    const name = `Workspace ${i + 1}`
    return s.name === name ? s : { ...s, name }
  })
}

export function emptyWorkspace(name: string, spaceId: string): WorkspaceDoc {
  const space = createSpace(spaceId, 'Workspace 1')
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date(0).toISOString(),
    meta: { name },
    activeSpaceId: space.id,
    spaces: [space],
  }
}

/**
 * App-global persisted state: every OPEN workspace and which one is active. Lives in
 * <userData>/workspaces.json (NOT per-folder), because workspaces now carry independent folders —
 * one shared per-folder file could no longer hold them. This is the single source of truth the
 * renderer hydrates on launch; folder-bound workspaces are ALSO mirrored to their own
 * <folder>/.plano/workspace.json for portability + importing an existing project's layout.
 */
export const STATE_SCHEMA_VERSION = 1

export interface WorkspaceStateDoc {
  schemaVersion: number
  savedAt: string
  /** The workspace shown on launch. Always references an existing `workspaces` entry. */
  activeId: string
  workspaces: Space[]
}
