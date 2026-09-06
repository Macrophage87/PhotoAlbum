import { db } from "@/lib/db";

export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch (err) {
    console.error("[health] database check failed:", err instanceof Error ? err.message : err);
    return Response.json({ ok: false }, { status: 503 });
  }
}
