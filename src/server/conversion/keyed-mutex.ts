export class KeyedMutex<K> {
  readonly #tails = new Map<K, Promise<void>>()

  get pendingKeyCount(): number {
    return this.#tails.size
  }

  async run<T>(key: K, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#tails.set(key, tail)

    await previous
    try {
      return await work()
    } finally {
      release()
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key)
      }
    }
  }
}
