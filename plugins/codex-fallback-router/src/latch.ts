export class QuotaLatch {
  #until = 0;

  constructor(private readonly fallbackDurationMs: number) {}

  activate(resetAt: number | undefined, now = Date.now()): number {
    const candidate = resetAt && resetAt > now ? resetAt : now + this.fallbackDurationMs;
    this.#until = candidate;
    return candidate;
  }

  clear(): void {
    this.#until = 0;
  }

  isActive(now = Date.now()): boolean {
    if (this.#until <= now) {
      this.#until = 0;
      return false;
    }
    return true;
  }

  get until(): number | undefined {
    return this.#until > 0 ? this.#until : undefined;
  }
}

