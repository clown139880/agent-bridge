/**
 * Generic single-consumer async stream with queuing, error propagation, and
 * cleanup. Ported verbatim from hapi (cli/src/claude/sdk/stream.ts).
 */
export class Stream<T> implements AsyncIterableIterator<T> {
  private queue: T[] = [];
  private readResolve?: (value: IteratorResult<T>) => void;
  private readReject?: (error: Error) => void;
  private isDone = false;
  private terminalError?: Error;
  private started = false;

  constructor(private returned?: () => void) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.started) {
      throw new Error("Stream can only be iterated once");
    }
    this.started = true;
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift()! });
    }
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.readResolve = resolve;
      this.readReject = reject;
    });
  }

  enqueue(value: T): void {
    if (this.isDone || this.terminalError) {
      return;
    }
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: false, value });
    } else {
      this.queue.push(value);
    }
  }

  done(): void {
    if (this.isDone || this.terminalError) {
      return;
    }
    this.isDone = true;
    if (this.readResolve) {
      const resolve = this.readResolve;
      this.readResolve = undefined;
      this.readReject = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  error(error: Error): void {
    if (this.isDone || this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.queue = [];
    if (this.readReject) {
      const reject = this.readReject;
      this.readResolve = undefined;
      this.readReject = undefined;
      reject(error);
    }
  }

  async return(): Promise<IteratorResult<T>> {
    this.isDone = true;
    if (this.returned) {
      this.returned();
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  get hasTerminalError(): boolean {
    return this.terminalError !== undefined;
  }
}
