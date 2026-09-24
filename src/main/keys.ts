import { parseEnv } from 'node:util'
import type { AgentInit } from '../shared/protocol'

const NAMES = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic',
  ANTHROPIC_WORKSPACE_ID: 'anthropicWorkspace',
  GEMINI_API_KEY: 'google',
  TYPESAFE_API_KEY: 'typesafe',
} as const

/** The provider keys in a .env file. Only these names are read; everything else in the file is ignored. */
export function keysFromEnvFile(text: string): NonNullable<AgentInit['keys']> {
  const env = parseEnv(text)
  const keys: NonNullable<AgentInit['keys']> = {}
  for (const [name, field] of Object.entries(NAMES)) {
    const value = env[name]?.trim()
    if (value) keys[field] = value
  }
  return keys
}
