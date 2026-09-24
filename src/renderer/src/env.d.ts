export {}
declare global {
  interface Window {
    jevauto: {
      surface: string
      command<T>(command: unknown): Promise<T>
      subscribe(listener: (event: unknown) => void): () => void
    }
  }
}
