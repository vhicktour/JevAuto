import { TypeSafeClient } from '@typesafe-ai/sdk'
import { JEV_MODEL } from '../../shared/constants'

export function jevClient(apiKey = process.env.TYPESAFE_API_KEY) {
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set (put it in .env.local).')
  return new TypeSafeClient({ apiKey, defaultModel: JEV_MODEL, timeout: 10_000 })
}
