export interface ClosableConnection {
  close(): void | Promise<void>
}

interface CacheEntry<T> {
  value: T
  active: number
  lastUsed: number
  idleTimer: NodeJS.Timeout | undefined
}

export interface ConnectionCacheOptions<T> {
  capacity: number
  idleTtlMs: number
  factory: (projectId: string) => Promise<T>
  /** Runs before a connection is reused or opened; throwing refuses the call with nothing sent. */
  beforeConnect?: (projectId: string) => void
}

/**
 * Bounds cached project sockets while preserving active operations.
 * Idle sockets are evicted least-recently-used and expire after the configured presence window.
 */
export class ProjectConnectionCache<T extends ClosableConnection> {
  readonly #capacity: number
  readonly #idleTtlMs: number
  readonly #factory: (projectId: string) => Promise<T>
  readonly #beforeConnect: ((projectId: string) => void) | undefined
  readonly #entries = new Map<string, CacheEntry<T>>()
  #mutex: Promise<void> = Promise.resolve()
  #slotWaiters: Array<() => void> = []

  constructor(options: ConnectionCacheOptions<T>) {
    this.#capacity = options.capacity
    this.#idleTtlMs = options.idleTtlMs
    this.#factory = options.factory
    this.#beforeConnect = options.beforeConnect
  }

  async withConnection<R>(projectId: string, operation: (connection: T) => Promise<R>): Promise<R> {
    this.#beforeConnect?.(projectId)
    const entry = await this.#acquire(projectId)
    try {
      return await operation(entry.value)
    } finally {
      await this.#release(projectId, entry)
    }
  }

  async closeAll(): Promise<void> {
    const entries = await this.#locked(() => {
      const values = [...this.#entries.values()]
      this.#entries.clear()
      return values
    })
    await Promise.all(
      entries.map(async entry => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
        await entry.value.close()
      })
    )
    this.#notifySlot()
  }

  async invalidate(projectId: string): Promise<void> {
    while (true) {
      const value = await this.#locked(() => {
        const entry = this.#entries.get(projectId)
        if (!entry) return null
        if (entry.active > 0) return undefined
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
        this.#entries.delete(projectId)
        return entry.value
      })
      if (value === null) return
      if (value !== undefined) {
        await value.close()
        this.#notifySlot()
        return
      }
      await new Promise<void>(resolve => this.#slotWaiters.push(resolve))
    }
  }

  async #acquire(projectId: string): Promise<CacheEntry<T>> {
    while (true) {
      const acquired = await this.#locked(async () => {
        const existing = this.#entries.get(projectId)
        if (existing) {
          if (existing.idleTimer) clearTimeout(existing.idleTimer)
          existing.idleTimer = undefined
          existing.active += 1
          existing.lastUsed = Date.now()
          return existing
        }

        if (this.#entries.size >= this.#capacity) {
          // Evicting an active socket could strand an acknowledged or in-flight OT operation.
          const idle = [...this.#entries.entries()]
            .filter(([, entry]) => entry.active === 0)
            .sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0]
          if (!idle) return undefined
          const [idleId, idleEntry] = idle
          if (idleEntry.idleTimer) clearTimeout(idleEntry.idleTimer)
          this.#entries.delete(idleId)
          await idleEntry.value.close()
        }

        const value = await this.#factory(projectId)
        const entry: CacheEntry<T> = {
          value,
          active: 1,
          lastUsed: Date.now(),
          idleTimer: undefined,
        }
        this.#entries.set(projectId, entry)
        return entry
      })
      if (acquired) return acquired
      // Capacity is fully active; wait until a release makes an idle slot available.
      await new Promise<void>(resolve => this.#slotWaiters.push(resolve))
    }
  }

  async #release(projectId: string, expected: CacheEntry<T>): Promise<void> {
    await this.#locked(() => {
      const entry = this.#entries.get(projectId)
      if (entry !== expected) return
      entry.active -= 1
      entry.lastUsed = Date.now()
      if (entry.active === 0) {
        entry.idleTimer = setTimeout(() => {
          void this.#expire(projectId, entry)
        }, this.#idleTtlMs)
        entry.idleTimer.unref?.()
        this.#notifySlot()
      }
    })
  }

  async #expire(projectId: string, expected: CacheEntry<T>): Promise<void> {
    const value = await this.#locked(() => {
      const entry = this.#entries.get(projectId)
      if (entry !== expected || entry.active !== 0) return undefined
      this.#entries.delete(projectId)
      return entry.value
    })
    await value?.close()
    this.#notifySlot()
  }

  #notifySlot(): void {
    const waiter = this.#slotWaiters.shift()
    waiter?.()
  }

  async #locked<R>(operation: () => Promise<R> | R): Promise<R> {
    let release!: () => void
    const previous = this.#mutex
    this.#mutex = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
