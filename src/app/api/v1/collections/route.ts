import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getApiViewer } from "@/lib/auth/viewer";
import { uniqueSlug } from "@/lib/trips/slug";
import { fieldErrors } from "@/lib/trips/validation";
import { collectionInputSchema } from "@/lib/collections/validation";
import { handWrittenDescription } from "@/lib/annotation/members-only";

export const dynamic = "force-dynamic";

/**
 * The collections a member can put photos in, by name: every one, since any member may file their own photographs
 * under any of the family's collections. The app shows it where something is being sent or filed.
 */
export async function GET(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const collections = await db.collection.findMany({ orderBy: [{ title: "asc" }, { id: "asc" }], select: { id: true, slug: true, title: true } });
  return Response.json({ collections });
}

/** A new collection, made from the app as the website's form makes one. Whoever makes it arranges it. */
export async function POST(request: Request) {
  const viewer = await getApiViewer(request);
  if (viewer.kind !== "user") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = collectionInputSchema.safeParse({ ...body, themeKey: "default", description: body?.description ?? undefined });
  if (!parsed.success) return Response.json({ error: Object.values(fieldErrors(parsed.error))[0] ?? "That collection could not be made." }, { status: 400 });
  const v = parsed.data;
  const slug = await uniqueSlug(v.title, async (s) => Boolean(await db.collection.findUnique({ where: { slug: s }, select: { id: true } })));
  const { descriptionMembersOnly, descriptionSharedAt } = await handWrittenDescription(null, v.description);
  const collection = await db.collection.create({ data: { slug, title: v.title, description: v.description, descriptionMembersOnly, descriptionSharedAt, themeKey: v.themeKey, createdById: viewer.user.id }, select: { id: true, slug: true, title: true } });
  revalidatePath("/", "layout");
  return Response.json({ collection }, { status: 201 });
}
