import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/viewer";

/** Members only: the pets that can be tagged on a photo. */
export async function GET() {
  const viewer = await getViewer();
  if (!viewer.user) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const pets = await db.person.findMany({ where: { kind: "PET" }, orderBy: { name: "asc" }, select: { id: true, name: true, species: true } });
  return NextResponse.json({ pets });
}
