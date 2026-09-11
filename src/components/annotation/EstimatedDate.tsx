import { Button, Input } from "@/components/ui";
import { confirmEstimatedDate } from "@/app/annotation/actions";

/** For undated items: the helper's year estimate with the evidence, and a one-step way to set a real date. */
export function EstimatedDate({ photoId, estimatedDate, confidence, note, compact = false }: { photoId: string; estimatedDate: Date | null; confidence: number | null; note: string | null; compact?: boolean }) {
  const confirm = confirmEstimatedDate.bind(null, photoId);
  const year = estimatedDate ? estimatedDate.getUTCFullYear() : null;
  const level = confidence === null ? "" : confidence >= 0.7 ? "fairly sure" : confidence >= 0.4 ? "a guess" : "a rough guess";
  return (
    <form action={confirm} className={`flex flex-wrap items-center gap-2 text-sm ${compact ? "" : "rounded-theme border border-amber-200 bg-amber-50 p-3 text-amber-900"}`}>
      <span>
        {year ? <>The helper thinks this is from about <b>{year}</b>{level && ` (${level})`}{note && <span className="text-muted">: {note}</span>}.</> : "No reliable date."}
      </span>
      <Input type="date" name="date" defaultValue={year ? `${year}-07-01` : ""} required className="w-40 h-8" aria-label="Date" />
      <Button type="submit" size="sm" variant="secondary">Set date</Button>
    </form>
  );
}
