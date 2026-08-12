/** PLANO Mobile — root: connection management, live channel, routing. */
import { useCallback, useEffect, useState } from 'react'
import { Api, clearConn, loadConn, saveConn } from './lib/api'
import { LiveChannel } from './lib/ws'
import type { Conn, Status } from './lib/types'
import { createStore } from './lib/store'
import { ConnectScreen } from './screens/Connect'
import { HomeScreen } from './screens/Home'
import { AgentDetailScreen } from './screens/AgentDetail'
import { TerminalScreen } from './screens/Terminal'
import { NewAgentScreen } from './screens/NewAgent'

export interface Route {
  name: 'home' | 'agent' | 'terminal' | 'new'
  ptyId?: string
  workspaceId?: string
}

export const routeStore = createStore<Route>({ name: 'home' })
export const statusStore = createStore<Status | null>(null)
export const liveStore = createStore<LiveChannel | null>(null)
export const upStore = createStore(false)
export const apiStore = createStore<Api | null>(null)

export function go(r: Route): void {
  routeStore.set(r)
}

export function App() {
  const [conn, setConn] = useState<Conn | null>(null)
  const [error, setError] = useState<string | null>(null)
  const route = routeStore.use()
  const up = upStore.use()

  // Bootstrap from a saved connection or the URL (?token= …host from location). Both paths must
  // go through connect() (which builds the API client, opens the live channel and seeds the
  // stores) — setting conn directly would render the app with no live wiring.
  useEffect(() => {
    void (async () => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    const saved = loadConn()
    if (saved) {
      connect(saved)
      return
    }
    if (token && window.location.hostname && window.location.port) {
      const c = { base: `${window.location.protocol}//${window.location.hostname}:${window.location.port}`, token }
      saveConn(c)
      window.history.replaceState({}, '', window.location.pathname)
      connect(c)
      return
    }
    // Same-origin (the page was served by the daemon on your LAN): auto-connect WITHOUT a token —
    // the daemon trusts same-subnet peers. Zero setup for the local case.
    if (window.location.hostname && window.location.port && !saved) {
      const c = { base: `${window.location.protocol}//${window.location.hostname}:${window.location.port}`, token: '' }
      const ok = await connect(c)
      if (ok) {
        saveConn({ ...c, token: loadConn()?.token ?? '' })
        return
      }
      setConn({ base: c.base, token: '' })
      return
    }
    // Guest page (e.g. hosted on Vercel): suggest the last-used LAN address.
    const savedBase = localStorage.getItem('plano.lastbase')
    if (savedBase) setConn({ base: savedBase, token: '' })
    })()
  }, [])

  const connect = useCallback((c: Conn): Promise<boolean> => {
    setError(null)
    const api = new Api(c)
    return api
      .status()
      .then((s) => {
        statusStore.set(s)
        apiStore.set(api)
        saveConn(c)
        localStorage.setItem('plano.lastbase', c.base)
        const live = new LiveChannel(c, (up2) => upStore.set(up2))
        liveStore.set(live)
        live.connect()
        setConn(c)
        return true
      })
      .catch((e: Error) => {
        setError(e.message)
        return false
      })
  }, [])

  const disconnect = useCallback(() => {
    liveStore.get()?.close()
    liveStore.set(null)
    upStore.set(false)
    clearConn()
    setConn(null)
    routeStore.set({ name: 'home' })
  }, [])

  if (!conn) {
    return <ConnectScreen onConnect={connect} error={error} />
  }

  return (
    <div className="app">
      {route.name === 'home' && <HomeScreen onDisconnect={disconnect} up={up} />}
      {route.name === 'agent' && route.ptyId && <AgentDetailScreen ptyId={route.ptyId} />}
      {route.name === 'terminal' && route.ptyId && <TerminalScreen ptyId={route.ptyId} />}
      {route.name === 'new' && <NewAgentScreen workspaceId={route.workspaceId} />}
    </div>
  )
}
