import { shouldRetry } from './errors'

/** Up to three tries, only for failures that can pass on their own (never an empty balance or a bad key). */
export async function withRetry<T>(call: () => Promise<T>, signal?: AbortSignal, delayMs = 1000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (attempt >= 3 || signal?.aborted || !shouldRetry(error)) throw error
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs * 2 ** (attempt - 1))
        signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
      })
    }
  }
}
