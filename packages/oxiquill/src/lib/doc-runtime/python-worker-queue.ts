export function createSerialRequestQueue<Request>(handle: (request: Request) => Promise<void>): {
  enqueue: (request: Request) => void;
} {
  let tail = Promise.resolve();

  return {
    enqueue(request) {
      tail = tail.then(() => handle(request)).catch(() => undefined);
    }
  };
}
