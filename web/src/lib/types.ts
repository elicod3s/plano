/** Types shared with the daemon's web API. */

export interface Session {
  ptyId: string
  panelId: string
  terminalId: string
  spaceId: string
  cwd: string
  shellName: string
  pid: number
  exited: boolean
  exitCode?: number
  viewers: number
  agentKind: string | null
  agentPid: number | null
  phase: 'working' | 'idle' | null
  title: string
  lastOutputAt: number
}

export interface Workspace {
  id: string
  name: string
  folderPath: string | null
  terminalCount: number
  agentCount: number
  terminals?: Array<{
    panelId: string
    terminalId: string
    title: string
    cwd: string
    live: boolean
  }>
}

export interface Status {
  version: string
  appConnected: boolean
  webPort: number
  sessions: Session[]
  workspaces: Workspace[]
  pending: number
  now: number
}

export interface Conn {
  base: string // e.g. http://192.168.1.5:34821
  token: string
}
