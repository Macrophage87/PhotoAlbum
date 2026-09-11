/**
 * One in-process mutex for work that saturates CPU or memory (ffmpeg, the ML sidecar), so a transcode and an
 * embedding never run at the same time inside one worker process. Each heavy queue also keeps localConcurrency 1;
 * this lock is what serialises them across queues. Holds only within a single worker process, as the docs require.
 */
let tail: Promise<void> = Promise.resolve();

export async function withHeavyLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const previous = tail;
  tail = previous.then(() => mine);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
