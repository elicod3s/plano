import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_LOG_BYTES = 2 * 1024 * 1024

function jsonValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

/** Small local-only lifecycle/crash log. It never records terminal output or user document data. */
export class DiagnosticsService {
  readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, 'logs', 'plano.log')
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if ((statSync(this.filePath, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
        renameSync(this.filePath, `${this.filePath}.previous`)
      }
    } catch {
      // Diagnostics must never become another failure source.
    }
  }

  log(event: string, details: unknown = {}): void {
    try {
      const record = JSON.stringify({
        at: new Date().toISOString(),
        event,
        details: jsonValue(details),
      })
      appendFileSync(this.filePath, `${record}\n`, 'utf8')
    } catch {
      // Best effort only; the application must remain usable on a read-only/full disk.
    }
  }
}
