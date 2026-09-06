import { Button, Select } from "@/components/ui";

const OFFSETS = [-720, -660, -600, -540, -480, -420, -360, -300, -240, -180, -120, -60, 0, 60, 120, 180, 240, 300, 330, 360, 420, 480, 540, 570, 600, 660, 720, 780];
const label = (m: number) => `UTC${m >= 0 ? "+" : "−"}${String(Math.floor(Math.abs(m) / 60)).padStart(2, "0")}:${String(Math.abs(m) % 60).padStart(2, "0")}`;

/** Lets a member fix a photo whose camera clock was in the wrong zone (common with travel). */
export function TimezoneShift({ action, currentOffsetMin, hasTrip, tripTimezone }: { action: (fd: FormData) => Promise<void>; currentOffsetMin: number | null; hasTrip: boolean; tripTimezone?: string }) {
  return (
    <form action={action} className="mt-3 pt-3 border-t border-border space-y-2">
      <div className="text-xs font-medium">Wrong time zone?</div>
      <p className="text-xs text-muted">Keeps the time the camera shows, but reinterprets it in another zone. Currently {currentOffsetMin !== null ? label(currentOffsetMin) : "unknown"}.</p>
      <div className="flex gap-2">
        <Select name="offset" defaultValue={hasTrip ? "trip" : String(currentOffsetMin ?? 0)} className="h-8 text-sm">
          {hasTrip && <option value="trip">Trip zone ({tripTimezone})</option>}
          {OFFSETS.map((m) => (
            <option key={m} value={m}>
              {label(m)}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" size="sm">Apply</Button>
      </div>
    </form>
  );
}
