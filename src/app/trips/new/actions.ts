"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireUserOrThrow } from "@/lib/auth/viewer";
import { uniqueSlug } from "@/lib/trips/slug";
import { fieldErrors, participantsFromForm, tripInputFromForm } from "@/lib/trips/validation";
import { dayToDateColumn } from "@/lib/time/local-day";

export type TripFormState = { status: "idle" } | { status: "error"; message?: string; fieldErrors?: Record<string, string> };

export async function createTrip(_prev: TripFormState, fd: FormData): Promise<TripFormState> {
  const user = await requireUserOrThrow();
  const parsed = tripInputFromForm(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const v = parsed.data;
  const slug = await uniqueSlug(v.title, async (s) => Boolean(await db.trip.findUnique({ where: { slug: s }, select: { id: true } })));
  const there = participantsFromForm(fd);
  await db.trip.create({
    data: {
      slug,
      title: v.title,
      description: v.description,
      startDate: dayToDateColumn(v.startDate),
      endDate: dayToDateColumn(v.endDate),
      timezone: v.timezone,
      themeKey: v.themeKey,
      createdById: user.id,
      // Nobody named means everybody, which is what an empty list already says.
      ...(there?.length ? { participants: { connect: there.map((id) => ({ id })) } } : {}),
    },
  });
  redirect(`/trips/${slug}`);
}
