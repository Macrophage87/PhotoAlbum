import { db } from "@/lib/db";

/** Everyone who can sign in, as the "who was there" control wants them: an id and something to call them. */
export async function familyMembers(): Promise<{ id: string; label: string }[]> {
  const users = await db.user.findMany({ orderBy: [{ name: "asc" }, { email: "asc" }], select: { id: true, name: true, email: true } });
  return users.map((u) => ({ id: u.id, label: u.name?.trim() || u.email }));
}
