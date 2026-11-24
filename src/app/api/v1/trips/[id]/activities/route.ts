import { revalidatePath } from "next/cache";
import { TZDate } from "@date-fns/tz";
import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { canEditContainer, NOT_YOUR_CONTAINER } from "@/lib/auth/ownership";
import { activityInputSchema, localInputToInstant } from "@/lib/activities/validation";
import { ACTIVITY_LABEL, ACTIVITY_TYPES } from "@/lib/activities/types";
import { reassignPhotosForActivity } from "@/lib/activities/reassign";
import { fieldErrors } from "@/lib/trips/validation";
import { handWrittenMembersOnly } from "@/lib/annotation/members-only";
import type { ActivityType } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as the clock on the trip read it, to the minute: what the website's form shows and takes. */
function wallTime(at: Date, timezone: string): string {
  const z = new TZDate(at, timezone);
  return `${z.getFullYear()}-${pad(z.getMonth() + 1)}-${pad(z.getDate())}T${pad(z.getHours())}:${pad(z.getMinutes())}`;
}

type Row = { id: string; title: string; type: ActivityType; startTime: Date; endTime: Date };
const toApp = (a: Row, timezone: string) => ({ id: a.id, title: a.title, type: a.type, label: ACTIVITY_LABEL[a.type], start: wallTime(a.startTime, timezone), end: wallTime(a.endTime, timezone) });

/**
 * A trip's activities for the app, in the order they happened, with the kinds an activity can be and whether this
 * member may add one: activities are part of the shape of a trip, so its maker (and admins) arrange them.
 */
export async function GET(request: Request, { params }: RouteContext<"/api/v1/trips/[id]/activities">) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const trip = await db.trip.findUnique({ where: { id, deletingAt: null }, select: { id: true, timezone: true, createdById: true, activities: { orderBy: [{ startTime: "asc" }, { id: "asc" }], select: { id: true, title: true, type: true, startTime: true, endTime: true } } } });
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
  return Response.json({
    activities: trip.activities.map((a) => toApp(a, trip.timezone)),
    types: ACTIVITY_TYPES.map((type) => ({ type, label: ACTIVITY_LABEL[type] })),
    canAdd: canEditContainer(viewer.user, trip),
  });
}

/**
 * A new activity on the trip, made from the app as the website's form makes one. Its times are the clock's on the
 * trip ("2025-08-12T15:04"), and what was taken in them is filed on it, as there.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/v1/trips/[id]/activities">) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const trip = await db.trip.findUnique({ where: { id, deletingAt: null }, select: { id: true, slug: true, timezone: true, createdById: true } });
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
  if (!canEditContainer(viewer.user, trip)) return Response.json({ error: NOT_YOUR_CONTAINER }, { status: 403 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = activityInputSchema.safeParse({ type: "OTHER", ...body, description: body?.description ?? undefined });
  if (!parsed.success) return Response.json({ error: Object.values(fieldErrors(parsed.error))[0] ?? "That activity could not be made." }, { status: 400 });
  const v = parsed.data;
  const activity = await db.activity.create({
    data: { tripId: trip.id, title: v.title, type: v.type as ActivityType, startTime: localInputToInstant(v.start, trip.timezone), endTime: localInputToInstant(v.end, trip.timezone), description: v.description, descriptionMembersOnly: await handWrittenMembersOnly(null, v.description) },
    select: { id: true, title: true, type: true, startTime: true, endTime: true },
  });
  await reassignPhotosForActivity(activity.id);
  revalidatePath(`/trips/${trip.slug}`, "layout");
  return Response.json({ activity: toApp(activity, trip.timezone) }, { status: 201 });
}
