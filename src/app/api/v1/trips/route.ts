import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { uniqueSlug } from "@/lib/trips/slug";
import { fieldErrors, tripInputSchema } from "@/lib/trips/validation";
import { dayToDateColumn } from "@/lib/time/local-day";
import { handWrittenMembersOnly } from "@/lib/annotation/members-only";

export const dynamic = "force-dynamic";

/** A trip's day as it is written on a calendar; the column holds a date with no time of day. */
const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The trips a member can send photos to, newest first: the same list the website's upload page offers. The app
 * shows it so that what is sent can be put on a trip by name; left unchosen, the album files each by its date.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const trips = await db.trip.findMany({
    where: { deletingAt: null },
    orderBy: [{ startDate: "desc" }, { id: "asc" }],
    select: { id: true, slug: true, title: true, startDate: true, endDate: true },
  });
  return Response.json({ trips: trips.map((t) => ({ id: t.id, slug: t.slug, title: t.title, startDate: day(t.startDate), endDate: day(t.endDate) })) });
}

/**
 * A new trip, made from the app as the website's form makes one: a title and its days, in the time zone the phone is
 * in unless it says another. Whoever makes it arranges it, as on the website.
 */
export async function POST(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = tripInputSchema.safeParse({ timezone: "UTC", ...body, themeKey: "default", description: body?.description ?? undefined });
  if (!parsed.success) return Response.json({ error: Object.values(fieldErrors(parsed.error))[0] ?? "That trip could not be made." }, { status: 400 });
  const v = parsed.data;
  const slug = await uniqueSlug(v.title, async (s) => Boolean(await db.trip.findUnique({ where: { slug: s }, select: { id: true } })));
  const trip = await db.trip.create({
    data: { slug, title: v.title, description: v.description, descriptionMembersOnly: await handWrittenMembersOnly(null, v.description), startDate: dayToDateColumn(v.startDate), endDate: dayToDateColumn(v.endDate), timezone: v.timezone, themeKey: v.themeKey, createdById: viewer.user.id },
    select: { id: true, slug: true, title: true, startDate: true, endDate: true },
  });
  revalidatePath("/", "layout");
  return Response.json({ trip: { id: trip.id, slug: trip.slug, title: trip.title, startDate: day(trip.startDate), endDate: day(trip.endDate) } }, { status: 201 });
}
