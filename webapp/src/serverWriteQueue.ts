export function createServerWriteQueue() {
  let tail: Promise<void> = Promise.resolve();

  return function queueServerWrite<T>(write: () => Promise<T>): Promise<T> {
    const queued = tail.then(write, write);
    tail = queued.then(() => undefined, () => undefined);
    return queued;
  };
}
