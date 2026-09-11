import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Probe = {
  durationS: number | null;
  width: number | null;
  height: number | null;
  /** 90/180/270 when the container says the frames are stored rotated (phones). */
  rotation: number;
  /** True for HDR sources (BT.2020 primaries or a PQ/HLG transfer) that need tone mapping to look right on the web. */
  hdr: boolean;
  /** `creation_time` from the container, when present. */
  createdAt: Date | null;
  videoCodec: string | null;
};

type FfprobeJson = {
  format?: { duration?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; color_transfer?: string; color_primaries?: string; side_data_list?: { rotation?: number }[]; tags?: Record<string, string> }[];
};

/** Interpret ffprobe's JSON. Pure, so the parsing is unit-tested without ffmpeg. */
export function parseProbe(json: FfprobeJson): Probe {
  const video = json.streams?.find((s) => s.codec_type === "video");
  const dur = Number(json.format?.duration);
  const rawRotation = Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  const rotation = ((Math.round(rawRotation / 90) * 90) % 360 + 360) % 360;
  const transfer = video?.color_transfer ?? "";
  const primaries = video?.color_primaries ?? "";
  const created = json.format?.tags?.creation_time ?? video?.tags?.creation_time;
  const createdAt = created ? new Date(created) : null;
  return {
    durationS: Number.isFinite(dur) && dur > 0 ? dur : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    rotation,
    hdr: primaries === "bt2020" || ["smpte2084", "arib-std-b67"].includes(transfer),
    createdAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
    videoCodec: video?.codec_name ?? null,
  };
}

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { maxBuffer: 4 * 1024 * 1024 });
  return parseProbe(JSON.parse(stdout) as FfprobeJson);
}

/** Video filter chain: tone-map HDR to BT.709 (needs libzimg), then fit inside 1920x1080 with even dimensions. */
export function videoFilter(p: Pick<Probe, "hdr">): string {
  const fit = "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  if (!p.hdr) return fit;
  return `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,${fit}`;
}

/** Arguments for the web-playable H.264 MP4. `-preset veryfast` keeps a 90-second clip to minutes on a small VPS. */
export function transcodeArgs(input: string, output: string, p: Pick<Probe, "hdr">): string[] {
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", input,
    "-vf", videoFilter(p),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    output,
  ];
}

/** Arguments for a single poster frame at a fraction of the duration (10 percent by default). */
export function posterArgs(input: string, output: string, durationS: number | null, at = 0.1): string[] {
  const t = durationS ? Math.max(0, Math.min(durationS * at, Math.max(durationS - 0.1, 0))) : 0;
  return ["-y", "-hide_banner", "-loglevel", "error", "-ss", t.toFixed(2), "-i", input, "-frames:v", "1", "-vf", videoFilter({ hdr: false }), "-q:v", "2", output];
}

/** No single ffmpeg call may hang a worker: a poster or frame takes seconds, a 90-second transcode a few minutes. */
export const FFMPEG_TIMEOUT_MS = 10 * 60_000;

export async function ffmpeg(args: string[]): Promise<void> {
  await run("ffmpeg", args, { maxBuffer: 4 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL" });
}
