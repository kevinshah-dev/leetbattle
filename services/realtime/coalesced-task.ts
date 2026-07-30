export interface CoalescedTaskOptions {
  readonly trailing?: boolean;
}

/**
 * Keeps one asynchronous operation in flight. Optional trailing mode remembers
 * concurrent requests and performs one more pass after the current pass.
 */
export class CoalescedTask {
  private active: Promise<void> | null = null;
  private requested = false;
  private stopped = false;

  constructor(
    private readonly operation: () => Promise<void>,
    private readonly options: CoalescedTaskOptions = {},
  ) {}

  get pending(): Promise<void> | null {
    return this.active;
  }

  request(): Promise<void> {
    if (this.stopped) return Promise.resolve();

    if (this.active) {
      if (this.options.trailing) this.requested = true;
      return this.active;
    }

    this.active = this.drain();
    return this.active;
  }

  stop(): void {
    this.stopped = true;
    this.requested = false;
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.requested = false;
        await this.operation();
      } while (this.options.trailing && this.requested && !this.stopped);
    } finally {
      this.active = null;
    }
  }
}
