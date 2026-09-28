/**
 * One in-process mutex for work that saturates CPU or memory (ffmpeg, the ML sidecar), so a transcode and an
 * embedding never run at the same time inside one worker process. Each heavy queue also keeps localConcurrency 1;
 * this lock is what serialises them across queues. Holds only within a single worker process, as the docs require.
 */
let tail: Promise<void> = Promise.resolve();

export async function withHeavyLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const previous = tail;
  tail = previous.then(() => mine);
  try {
    // A job pg-boss has already timed out (and will retry) stops waiting rather than running alongside its retry.
    if (signal) await abortable(previous, signal);
    else await previous;
    signal?.throwIfAborted();
    return await fn();
  } finally {
    // Given up or done, the next in line may go once whoever is ahead of us has finished.
    void previous.then(release);
  }
}

function abortable(p: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
