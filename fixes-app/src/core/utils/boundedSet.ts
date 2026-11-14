/** Insertion-ordered set that forgets its oldest entries beyond `limit`. */
export class BoundedSet {
  private readonly items = new Set<string>();

  constructor(private readonly limit: number) {}

  has(value: string): boolean {
    return this.items.has(value);
  }

  add(value: string): void {
    this.items.delete(value);
    this.items.add(value);
    if (this.items.size > this.limit) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
}
