import type { ActivityType } from "@/generated/prisma/enums";

const MAP: [RegExp, ActivityType][] = [
  [/^(running|run|trail_?run(ning)?|jog|lauf|laufen|joggen|correr|carrera)/i, "RUN"],
  [/^(cycling|biking|bike|ride|mountain_?bik|gravel|e_?bik|road_?bik|virtual_?rid|rad|radfahr|fahrrad|velo|vélo|ciclismo)/i, "BIKE"],
  [/^(hiking|hike|walking|walk|trekking|backpack|snowshoe|mountaineering|wander|spazier|bergwander|randonn|marche|senderismo|caminata|caminar)/i, "HIKE"],
  [/^(paddling|kayak|canoe|rowing|row|sup|stand_?up|paddle|rafting)/i, "KAYAK"],
  [/^(boating|sail|boat|motorboat|fishing)/i, "BOAT"],
  [/^(driving|drive|motorcycl|car$|car_|flying|flight|train$|train_|transit$|transport|bus$)/i, "DRIVE"],
];

/** Where it was done rather than what: "Outdoor Run", "street_running", "virtual_ride", "e_mountain_biking". */
const SETTING = /^(outdoor|indoor|street|virtual|treadmill|e)_/;

function normalise(raw: string): string {
  let s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  while (SETTING.test(s)) s = s.replace(SETTING, "");
  return s;
}

/** FIT sport / GPX <type> string -> our activity type; null when unknown. */
export function sportToActivityType(raw: string | null | undefined): ActivityType | null {
  if (!raw) return null;
  const s = normalise(raw);
  for (const [re, t] of MAP) if (re.test(s)) return t;
  return null;
}

/** Sports that are recognisably none of ours; a name that is not recognised at all could still be any of them. */
const KNOWN_OTHER =
  /^(swim|open_water|pool|lap_swim|schwimm|natation|nata|ski|alpine|cross_country|backcountry|nordic|langlauf|snowboard|golf|climb|rock_climb|boulder|klettern|skat|inline|ice_skat|surf|kitesurf|windsurf|wakeboard|water_ski|div(e|ing)|snorkel|sky_?div|hang_glid|paraglid|horse|equestrian|reit|yoga|pilates|tennis|squash|badminton|soccer|football|american_football|basketball|volleyball|fitness|training|strength|workout|crossfit|elliptical|stair|transition|hunting|tactical|jumpmaster|boxing|floor_climb|snowmobil)/;

/**
 * The type for a track whose sport did not map to one of ours. A sport recognisably none of ours (swimming, skiing,
 * golf) is OTHER: guessing from its speed would make a ski run a bike ride. Anything else, from no sport at all or a
 * catch-all like "generic" to a name in a language not listed here, is typed from its speed.
 */
export function fallbackActivityType(sportRaw: string | null | undefined, avgSpeedMs: number | null): ActivityType {
  return sportRaw && KNOWN_OTHER.test(normalise(sportRaw)) ? "OTHER" : guessTypeFromSpeed(avgSpeedMs);
}

/** Last resort: guess from average moving speed. */
export function guessTypeFromSpeed(avgSpeedMs: number | null): ActivityType {
  if (avgSpeedMs === null) return "HIKE";
  if (avgSpeedMs < 2.2) return "HIKE";
  if (avgSpeedMs < 4.2) return "RUN";
  if (avgSpeedMs < 12) return "BIKE";
  return "DRIVE";
}
