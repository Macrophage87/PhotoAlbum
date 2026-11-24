import { CAST_LINK_MS, castKey, readCastLink, signCastLink } from "@/lib/cast/link";

/**
 * Music for a slideshow on a television.
 *
 * A member adds a song to the album as a file of their own. The phone app is given the list, and tells the
 * television which to play while the photographs go by. Like a slide, a song reaches the television by an address
 * the album signed for a few hours (see `lib/cast/link`), because a television cannot sign in.
 */

/** The kinds of file a Chromecast plays, and the ending each is kept under. */
export const SONG_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/wav": "wav",
};

const TYPE_BY_ENDING: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav" };

/** A long song at a good bitrate, with room to spare; an hour-long recording is not what this is for. */
export const MAX_SONG_BYTES = 40 * 1024 * 1024;

/**
 * What kind of music file this is, or null when it is not one the album keeps. Browsers and phones name the same
 * file differently ("audio/mp3", "audio/x-m4a", or nothing at all), so the name's ending settles it when it can.
 */
export function songType(fileName: string, sent: string | null | undefined): string | null {
  const ending = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ending && TYPE_BY_ENDING[ending]) return TYPE_BY_ENDING[ending]!;
  const type = (sent ?? "").split(";")[0]!.trim().toLowerCase();
  if (SONG_TYPES[type]) return type;
  if (type === "audio/mp3") return "audio/mpeg";
  if (type === "audio/x-m4a" || type === "audio/m4a") return "audio/mp4";
  if (type === "audio/x-flac") return "audio/flac";
  if (type === "audio/x-wav" || type === "audio/wave") return "audio/wav";
  return null;
}

/** What a song is called until somebody says otherwise: its file's name without the ending, tidied. */
export function songTitle(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "").replace(/[_\s]+/g, " ").trim();
  return (base || "Untitled").slice(0, 120);
}

/** What is signed for a song: never a photograph's id, so neither kind of address opens the other. */
const signedName = (songId: string) => `music:${songId}`;

/** The address a television fetches a song from. */
export async function songCastUrl(songId: string, now = Date.now()): Promise<string> {
  return `/api/music/${songId}?cast=${signCastLink(await castKey(), signedName(songId), now + CAST_LINK_MS)}`;
}

export async function songLinkGood(songId: string, token: unknown, now = Date.now()): Promise<boolean> {
  return readCastLink(await castKey(), signedName(songId), token, now);
}
