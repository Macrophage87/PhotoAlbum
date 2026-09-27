import { db } from "@/lib/db";
import { revokeRemovedConnection } from "./account";

/** How long a grant Google keeps refusing to hear about is tried for, before it is logged and let go. */
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tell Google about one removed member's grant, kept (sealed) in PendingRevoke by the transaction that deleted the
 * account. The row goes once Google has been told, or once there is nothing that could be told (an undecryptable
 * token); while Google cannot be reached it stays for the next pass.
 */
export async function revokePending(id: string): Promise<"revoked" | "failed" | "none"> {
  const row = await db.pendingRevoke.findUnique({ where: { id } });
  if (!row) return "none";
  const result = await revokeRemovedConnection(row.userId, row.encryptedRefreshToken);
  if (result === "failed") await db.pendingRevoke.updateMany({ where: { id }, data: { attempts: { increment: 1 } } });
  else await db.pendingRevoke.deleteMany({ where: { id } });
  return result;
}

/** With the worker's quarter-hourly pass: every grant still waiting to be revoked, oldest first. */
export async function revokePendingConnections(now = new Date()): Promise<number> {
  const rows = await db.pendingRevoke.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, createdAt: true, attempts: true } });
  let revoked = 0;
  for (const r of rows) {
    if (now.getTime() - r.createdAt.getTime() > GIVE_UP_AFTER_MS) {
      console.error(`[google] gave up revoking a removed member's Google connection after ${r.attempts} attempts; they can remove the album's access from their Google account`);
      await db.pendingRevoke.deleteMany({ where: { id: r.id } });
      continue;
    }
    if ((await revokePending(r.id)) === "revoked") revoked++;
  }
  return revoked;
}
