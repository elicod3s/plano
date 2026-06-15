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

/** One independent canvas within a project: its own panels, camera and regions. */
export interface Space {
  id: string
  name: string
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

/** A blank space with the given id + display name. */
export function createSpace(id: string, name: string): Space {
  return { id, name, viewport: { x: 0, y: 0, zoom: 1 }, panels: [], regions: [] }
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
