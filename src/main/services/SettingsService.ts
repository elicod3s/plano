/**
 * SettingsService — read/write the app-global settings document.
 *
 * Stored in userData/settings.json (atomic temp+rename, pretty JSON), separate from any
 * project workspace. Reads are tolerant: a missing/old/corrupt file degrades to defaults
 * via `mergeSettings`, so the renderer always receives a complete document.
 */

import { app } from 'electron'
import { promises as fs, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, mergeSettings, type PlanoSettings } from '@shared/domain/settings'

const SETTINGS_FILE = 'settings.json'

export class SettingsService {
  private cache: PlanoSettings | null = null

  filePath(): string {
    return join(app.getPath('userData'), SETTINGS_FILE)
  }

  async get(): Promise<PlanoSettings> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.filePath(), 'utf8')
      this.cache = mergeSettings(JSON.parse(raw))
    } catch {
      this.cache = DEFAULT_SETTINGS
    }
    return this.cache
  }

  async save(settings: unknown): Promise<{ ok: true; settings: PlanoSettings }> {
    const merged = mergeSettings(settings)
    this.cache = merged
    await this.atomicWrite(this.filePath(), JSON.stringify(merged, null, 2))
    return { ok: true, settings: merged }
  }

  /**
   * Synchronous read for teardown paths that can't await (`will-quit`): returns the cached doc
   * when present, otherwise reads the file synchronously (tolerant, like `get`).
   */
  getSync(): PlanoSettings {
    if (this.cache) return this.cache
    try {
      const raw = readFileSync(this.filePath(), 'utf8')
      this.cache = mergeSettings(JSON.parse(raw))
    } catch {
      this.cache = DEFAULT_SETTINGS
    }
    return this.cache
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, content, 'utf8')
    await fs.rename(tmp, file)
  }
}
