/** Standalone worker entry: `pnpm worker` (or a separate compose service with RUN_WORKER=false on the web). */
import "dotenv/config";
import { startWorker } from "../src/lib/jobs/worker";

startWorker().catch((err) => {
  console.error(err);
  process.exit(1);
});
