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
  // Strava writes CamelCase ("EMountainBikeRide", "VirtualRun"): split the words before anything else.
  const words = raw.trim().replace(/([a-z])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2");
  let s = words.toLowerCase().replace(/[\s-]+/g, "_");
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
  /^(swim|open_water|pool|lap_swim|schwimm|natation|nata|ski|alpine|cross_country|backcountry|nordic|langlauf|roller_?ski|snowboard|golf|disc_golf|climb|rock_climb|boulder|klettern|skat|inline|ice_skat|surf|kitesurf|windsurf|wakeboard|wakesurf|water_ski|water_tubing|tubing|water_sport|div(e|ing)|snorkel|sky_?div|hang_glid|paraglid|horse|equestrian|reit|wheelchair|handcycl|yoga|pilates|hiit|dance|martial|mixed_martial|tennis|squash|badminton|racket|racquet|pickleball|table_tennis|soccer|football|american_football|basketball|volleyball|team_sport|cricket|rugby|hockey|lacrosse|baseball|softball|fitness|training|weight|strength|workout|crossfit|elliptical|stair|jump_rope|mobility|meditation|transition|hunting|shooting|archery|tactical|jumpmaster|boxing|floor_climb|snowmobil|winter_sport|video_gaming|para_sport|motor_sport)/;

/** FIT's own catch-alls, which say nothing about what was done. */
const FIT_CATCH_ALL = /^(generic|all|multisport|invalid|\d+)$/;

/**
 * The type for a track whose sport did not map to one of ours. A sport recognisably none of ours (swimming, skiing,
 * golf) is OTHER: guessing from its speed would make a ski run a bike ride. Anything else, from no sport at all or a
 * catch-all like "generic" to a name in a language not listed here, is typed from its speed. `fromFit` says the
 * name came from a FIT file, where every sport but the catch-alls is a named one.
 */
export function fallbackActivityType(sportRaw: string | null | undefined, avgSpeedMs: number | null, fromFit = false): ActivityType {
  if (!sportRaw) return guessTypeFromSpeed(avgSpeedMs);
  const s = normalise(sportRaw);
  // A FIT file's sport is one of Garmin's own list, so anything but its catch-alls is a named sport.
  if (fromFit && !FIT_CATCH_ALL.test(s)) return "OTHER";
  return KNOWN_OTHER.test(s) ? "OTHER" : guessTypeFromSpeed(avgSpeedMs);
}

/** Last resort: guess from average moving speed. */
export function guessTypeFromSpeed(avgSpeedMs: number | null): ActivityType {
  if (avgSpeedMs === null) return "HIKE";
  if (avgSpeedMs < 2.2) return "HIKE";
  if (avgSpeedMs < 4.2) return "RUN";
  if (avgSpeedMs < 12) return "BIKE";
  return "DRIVE";
}
