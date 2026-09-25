import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentInit } from '../shared/protocol'

type Keys = NonNullable<AgentInit['keys']>
export type KeyName = keyof Keys
export const KEY_NAMES: KeyName[] = ['openai', 'anthropic', 'anthropicWorkspace', 'google', 'typesafe']

/** Electron's safeStorage, which encrypts with a key kept in your login Keychain (spec §8). */
/** Where the key a model uses comes from: saved in Settings (Keychain, wins), .env.local, or nowhere. */
export function keySources(stored: Partial<Keys>, env: Partial<Keys>): Record<KeyName, 'keychain' | 'env' | 'none'> {
  return Object.fromEntries(KEY_NAMES.map((k) => [k, stored[k] ? 'keychain' : env[k] ? 'env' : 'none'])) as Record<KeyName, 'keychain' | 'env' | 'none'>
}

export type Crypter = { available(): boolean; encrypt(text: string): Buffer; decrypt(data: Buffer): string }

/**
 * Provider keys you enter in Settings, encrypted at rest in keys.bin (0600). The UI can set or clear a key and see
 * whether one is set, never read one back; keys go only to the agent process in its init message.
 */
export class KeyStore {
  private readonly file: string

  constructor(
    dir: string,
    private readonly crypter: Crypter,
  ) {
    this.file = join(dir, 'keys.bin')
  }

  all(): Keys {
    if (!existsSync(this.file) || !this.crypter.available()) return {}
    try {
      const parsed = JSON.parse(this.crypter.decrypt(readFileSync(this.file))) as Keys
      return Object.fromEntries(KEY_NAMES.filter((k) => typeof parsed[k] === 'string' && parsed[k]).map((k) => [k, parsed[k]]))
    } catch {
      return {}
    }
  }

  status(): Record<KeyName, boolean> {
    const keys = this.all()
    return Object.fromEntries(KEY_NAMES.map((k) => [k, Boolean(keys[k])])) as Record<KeyName, boolean>
  }

  /** An empty value clears the key. */
  set(name: KeyName, value: string) {
    if (!this.crypter.available()) throw new Error('The macOS Keychain is not available, so keys can’t be stored safely.')
    const keys = this.all()
    const trimmed = value.trim()
    if (trimmed) keys[name] = trimmed
    else delete keys[name]
    writeFileSync(this.file, this.crypter.encrypt(JSON.stringify(keys)), { mode: 0o600 })
    chmodSync(this.file, 0o600)
  }
}
