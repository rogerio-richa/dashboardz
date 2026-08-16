import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RuntimeConfig {
  model?: string
  permissionMode: 'default' | 'acceptEdits' | 'plan'
}

const MODES = new Set(['default', 'acceptEdits', 'plan'])

export function loadRuntime(dataDir: string): RuntimeConfig {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8')) as Partial<RuntimeConfig>
    return {
      ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
      permissionMode: MODES.has(raw.permissionMode as string) ? (raw.permissionMode as RuntimeConfig['permissionMode']) : 'default',
    }
  } catch {
    return { permissionMode: 'default' }
  }
}

export function saveRuntime(dataDir: string, rt: RuntimeConfig): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'runtime.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(rt, null, 2))
  renameSync(`${file}.tmp`, file)
}
