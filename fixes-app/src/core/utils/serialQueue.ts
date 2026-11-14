/** FIFO async lock: tasks run one at a time in submission order. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    // The queue only needs to know when the task settled; its outcome reaches the caller via `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
