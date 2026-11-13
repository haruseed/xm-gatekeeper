/** Each admitted request owns one idempotent release function, including on exceptions. */
export class CapacityPool {
  private used = 0;
  constructor(private readonly limit: number) {}

  acquire(): (() => void) | undefined {
    if (this.used >= this.limit) return undefined;
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
    };
  }
}
