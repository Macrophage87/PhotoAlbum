export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  silenceAbortedStreams();
  const { env } = await import("@/lib/env");
  // A FORGET_KEY that is not 32 bytes of base64 is no key: say so at start, not only on the admin page.
  const { forgetKeySecret, INVALID_FORGET_KEY } = await import("@/lib/people/forget-key");
  if (env().NODE_ENV === "production" && env().FORGET_KEY && !forgetKeySecret(env().FORGET_KEY)) console.error(`[forget] ${INVALID_FORGET_KEY} Forgetting anybody waits until it is.`);
  // Forgotten names kept before the photographs they cover were hashed: hashed before the first request, with or
  // without a worker (the worker's nightly pass does it again). Plain ones are still matched until then.
  const { hashPlainScopesOnce } = await import("@/lib/people/tombstone");
  await hashPlainScopesOnce();
  if (!env().RUN_WORKER) return;
  const { startWorker } = await import("@/lib/jobs/worker");
  const { installShutdownHandlers } = await import("@/lib/jobs/boss");
  // Next's built-in SIGTERM handler exits as soon as the HTTP server closes, which would cut the queue
  // shutdown short. With NEXT_MANUAL_SIG_HANDLE=1 (set in the Docker image) it stands down and our
  // handler stops pg-boss gracefully, then exits. Without that variable this is best-effort only.
  installShutdownHandlers({ exit: process.env.NEXT_MANUAL_SIG_HANDLE === "1" });
  startWorker().catch((err) => console.error("[worker] failed to start", err));
}

/**
 * When a browser abandons a page mid-render (navigating away, a poll that reloads), React logs
 * "The destination stream closed early". It is not an error in this app; keep the log readable.
 */
function silenceAbortedStreams() {
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    const text = typeof first === "string" ? first : first instanceof Error ? first.message : "";
    if (text.includes("The destination stream closed early")) return;
    original(...args);
  };
}
