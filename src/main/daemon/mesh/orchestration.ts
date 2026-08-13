/**
 * Orchestration store (plan v7): Run / Task / Dispatch.
 *
 * The mesh could already carry a message between two agents and prove it landed. What it could not
 * do was run a PROJECT across five of them: an orchestrator had to invent its own bookkeeping,
 * poll the roster to guess who was alive, and echo sentinels into its own transcript to fake an
 * acknowledgement. This is the layer above the wire.
 *
 * The model is Orca's, because the separation is the whole design:
 *
 *   Run       a durable namespace and the coordinator's inbox. It NEVER schedules or places
 *             workers — agents choose placement, the daemon records and guarantees.
 *   Task      the work item. Carries dependencies (a real DAG) and a status.
 *   Dispatch  ONE attempt of one Task on one agent. Lifecycle authority lives HERE, not on the
 *             terminal: a terminal is routing metadata, and it can die without the attempt losing
 *             its meaning.
 *
 * Everything persists under <userData>/mesh/orchestration.json with the same atomic temp+rename
 * discipline as the mailboxes, because orchestration has to survive the desktop app closing — the
 * invariant the rest of the daemon already honours.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
export type DispatchState = 'ready' | 'settled' | 'failed' | 'stopped' | 'unknown'
export type WorkerOutcome = 'succeeded' | 'failed'

export interface Run {
  id: string
  objective: string
  /** The agent that created it — the coordinator this Run's mail belongs to. */
  coordinator: string
  createdAt: number
}

export interface Task {
  id: string
  runId: string
  spec: string
  /** Task ids that must be `completed` before this one is runnable. */
  deps: string[]
  parent?: string
  status: TaskStatus
  result?: unknown
  /** Consecutive failed attempts. Three trips the circuit breaker (see `recordFailure`). */
  failures: number
  createdAt: number
  settledAt?: number
}

export interface Dispatch {
  id: string
  taskId: string
  runId: string
  /** The agent executing this attempt (routing, not identity). */
  agentId: string
  state: DispatchState
  outcome?: WorkerOutcome
  filesModified?: string[]
  summary?: string
  startedAt: number
  settledAt?: number
  /** Set when this attempt replaces a previous one. */
  retryOf?: string
}

interface Snapshot {
  runs: Run[]
  tasks: Task[]
  dispatches: Dispatch[]
}

/** Three consecutive failures on one task stop the loop — Orca's circuit breaker. */
export const MAX_TASK_FAILURES = 3

const EMPTY: Snapshot = { runs: [], tasks: [], dispatches: [] }

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export class OrchestrationStore {
  private file: string
  private data: Snapshot = { runs: [], tasks: [], dispatches: [] }

  constructor(userData: string) {
    const dir = join(userData, 'mesh')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'orchestration.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Snapshot>
      this.data = {
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        dispatches: Array.isArray(parsed.dispatches) ? parsed.dispatches : [],
      }
    } catch {
      this.data = { ...EMPTY, runs: [], tasks: [], dispatches: [] }
    }
  }

  private persist(): void {
    try {
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      /* a failed write must never take the daemon down; state stays correct in memory */
    }
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  createRun(coordinator: string, objective: string): Run {
    const run: Run = { id: newId('run'), objective, coordinator, createdAt: Date.now() }
    this.data.runs.push(run)
    this.persist()
    return run
  }

  run(id: string): Run | undefined {
    return this.data.runs.find((r) => r.id === id)
  }

  /** The Run a coordinator is working in: its most recent one, so `run-create` is a once-per-session act. */
  runFor(coordinator: string): Run | undefined {
    return [...this.data.runs].reverse().find((r) => r.coordinator === coordinator)
  }

  runs(): Run[] {
    return [...this.data.runs]
  }

  // ── tasks ─────────────────────────────────────────────────────────────────

  createTask(runId: string, spec: string, deps: string[] = [], parent?: string): Task {
    const task: Task = {
      id: newId('task'),
      runId,
      spec,
      deps: deps.filter((d) => typeof d === 'string' && d),
      parent,
      status: 'pending',
      failures: 0,
      createdAt: Date.now(),
    }
    this.data.tasks.push(task)
    this.refreshReadiness()
    this.persist()
    return task
  }

  task(id: string): Task | undefined {
    return this.data.tasks.find((t) => t.id === id)
  }

  tasks(runId?: string): Task[] {
    return this.data.tasks.filter((t) => !runId || t.runId === runId)
  }

  /**
   * Readiness is DERIVED, never stored twice: a task is `ready` exactly when every dependency has
   * completed. Storing it as an independent field is how a DAG drifts out of sync with itself.
   */
  refreshReadiness(): void {
    const byId = new Map(this.data.tasks.map((t) => [t.id, t]))
    for (const task of this.data.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'dispatched') continue
      const deps = task.deps.map((d) => byId.get(d))
      const blocked = deps.some((d) => !d || d.status === 'failed')
      const satisfied = deps.every((d) => d?.status === 'completed')
      task.status = blocked ? 'blocked' : satisfied ? 'ready' : 'pending'
    }
  }

  /** The queue a coordinator pulls from. */
  readyTasks(runId?: string): Task[] {
    this.refreshReadiness()
    return this.tasks(runId).filter((t) => t.status === 'ready')
  }

  setTaskStatus(id: string, status: TaskStatus, result?: unknown): Task | undefined {
    const task = this.task(id)
    if (!task) return undefined
    task.status = status
    if (result !== undefined) task.result = result
    if (status === 'completed' || status === 'failed') task.settledAt = Date.now()
    this.refreshReadiness()
    this.persist()
    return task
  }

  // ── dispatches ────────────────────────────────────────────────────────────

  createDispatch(taskId: string, agentId: string, retryOf?: string): Dispatch | { error: string } {
    const task = this.task(taskId)
    if (!task) return { error: `no task ${taskId}` }
    if (task.status === 'completed') return { error: 'task already completed' }
    if (task.status === 'failed') return { error: `task failed after ${task.failures} attempts` }
    const dispatch: Dispatch = {
      id: newId('disp'),
      taskId,
      runId: task.runId,
      agentId,
      state: 'ready',
      startedAt: Date.now(),
      retryOf,
    }
    this.data.dispatches.push(dispatch)
    task.status = 'dispatched'
    this.persist()
    return dispatch
  }

  dispatch(id: string): Dispatch | undefined {
    return this.data.dispatches.find((d) => d.id === id)
  }

  dispatchesFor(taskId: string): Dispatch[] {
    return this.data.dispatches.filter((d) => d.taskId === taskId)
  }

  /** The live attempt an agent is executing, if any — how a worker finds its own ids. */
  activeDispatchFor(agentId: string): Dispatch | undefined {
    return [...this.data.dispatches].reverse().find((d) => d.agentId === agentId && d.state === 'ready')
  }

  /**
   * A worker reported. This is the ONLY way a task completes on its own: an outcome, stated. A
   * quiet terminal, an idle TUI or a heartbeat never settle anything.
   */
  settle(dispatchId: string, outcome: WorkerOutcome, summary?: string, filesModified?: string[]): { ok: boolean; error?: string; task?: Task; dispatch?: Dispatch } {
    const dispatch = this.dispatch(dispatchId)
    if (!dispatch) return { ok: false, error: `no dispatch ${dispatchId}` }
    if (dispatch.state !== 'ready') return { ok: false, error: `dispatch already ${dispatch.state}` }
    dispatch.state = outcome === 'succeeded' ? 'settled' : 'failed'
    dispatch.outcome = outcome
    dispatch.summary = summary
    dispatch.filesModified = filesModified
    dispatch.settledAt = Date.now()
    const task = this.task(dispatch.taskId)
    if (task) {
      if (outcome === 'succeeded') {
        task.status = 'completed'
        task.failures = 0
        task.settledAt = Date.now()
      } else {
        task.failures += 1
        // The circuit breaker: a spec that keeps failing becomes a failed task instead of an
        // infinite dispatch loop that burns tokens and hides the real problem.
        task.status = task.failures >= MAX_TASK_FAILURES ? 'failed' : 'ready'
        if (task.status === 'failed') task.settledAt = Date.now()
      }
    }
    this.refreshReadiness()
    this.persist()
    return { ok: true, task, dispatch }
  }

  /** The attempt's agent died. The Task returns to the queue for a `--retry-of` attempt. */
  markUnknown(agentId: string): Dispatch[] {
    const affected = this.data.dispatches.filter((d) => d.agentId === agentId && d.state === 'ready')
    for (const d of affected) {
      d.state = 'unknown'
      d.settledAt = Date.now()
      const task = this.task(d.taskId)
      if (task && task.status === 'dispatched') {
        task.failures += 1
        task.status = task.failures >= MAX_TASK_FAILURES ? 'failed' : 'ready'
      }
    }
    if (affected.length > 0) {
      this.refreshReadiness()
      this.persist()
    }
    return affected
  }
}
