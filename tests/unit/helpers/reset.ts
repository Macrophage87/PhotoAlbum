import { db } from "@/lib/db";

/** Empty every table in dependency order so tests can start from nothing. */
export async function resetTestDb(): Promise<void> {
  await db.collectionItem.deleteMany();
  await db.collection.deleteMany();
  await db.photoLink.deleteMany();
  await db.photo.deleteMany();
  await db.activity.deleteMany();
  await db.trackStats.deleteMany();
  await db.track.deleteMany();
  await db.trip.deleteMany();
  await db.session.deleteMany();
  await db.magicLinkToken.deleteMany();
  await db.invite.deleteMany();
  await db.user.deleteMany();
}
