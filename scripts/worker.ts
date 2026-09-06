/** Standalone worker entry: `pnpm worker` (or the `worker` compose profile with RUN_WORKER=false on the web). */
import "dotenv/config";
import { startWorker } from "../src/lib/jobs/worker";
import { installShutdownHandlers } from "../src/lib/jobs/boss";

installShutdownHandlers({ exit: true });
startWorker().catch((err) => {
  console.error(err);
  process.exit(1);
});
