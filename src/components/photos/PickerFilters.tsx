import { Button, Input, Label, Select } from "@/components/ui";
import { TripFilterField } from "@/components/containers/TripFilterField";
import { NearPlaceField } from "@/components/photos/NearPlaceField";
import { KIND_LABELS } from "@/lib/photos/filters";
import { type PickerFilter } from "@/lib/photos/picker-filter";

export type PickerOption = { id: string; label: string };

/**
 * The questions worth asking when looking through the whole album for photographs to put somewhere.
 *
 * A plain form that submits to the page it is on, so a narrowed picker is an ordinary address: a member can work
 * through a long list over several sittings, or send somebody else the same view.
 */
export function PickerFilters({ filter, action, initialTrip, members, showTrip = true }: {
  filter: PickerFilter;
  action: string;
  /** The trip already named by the filter, so the box shows its title rather than an id. */
  initialTrip: { id: string; title: string } | null;
  members?: PickerOption[];
  /** The trip picker is pointless when adding to a trip from its own page. */
  showTrip?: boolean;
}) {
  return (
    <form method="get" action={action} className="flex flex-wrap items-end gap-3" data-testid="picker-filters">
      <div>
        <Label htmlFor="q">Words</Label>
        <Input id="q" name="q" defaultValue={filter.q ?? ""} placeholder="lake, birthday, Biscuit…" className="h-9 w-56" />
      </div>

      {showTrip && (
        <div>
          <Label htmlFor="trip">Trip</Label>
          <TripFilterField initial={initialTrip} />
        </div>
      )}

      <div>
        <Label htmlFor="from">From</Label>
        <Input id="from" name="from" type="date" defaultValue={filter.from ?? ""} className="h-9" />
      </div>
      <div>
        <Label htmlFor="to">To</Label>
        <Input id="to" name="to" type="date" defaultValue={filter.to ?? ""} className="h-9" />
      </div>

      <div>
        <Label htmlFor="near">Place</Label>
        <NearPlaceField value={filter.near} />
      </div>

      <div>
        <Label htmlFor="kind">Type</Label>
        <Select id="kind" name="kind" defaultValue={filter.kind ?? ""} className="h-9 w-40 text-sm">
          <option value="">Anything</option>
          {(Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((k) => (
            <option key={k} value={k}>{KIND_LABELS[k]}</option>
          ))}
        </Select>
      </div>

      {members && members.length > 1 && (
        <div>
          <Label htmlFor="uploader">Uploaded by</Label>
          <Select id="uploader" name="uploader" defaultValue={filter.uploaderId ?? ""} className="h-9 w-44 text-sm">
            <option value="">Anyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </Select>
        </div>
      )}

      {/* The pile that most wants tidying away: everything nothing has claimed yet. */}
      <label className="flex items-center gap-2 text-sm h-9">
        <input type="checkbox" name="loose" value="1" defaultChecked={filter.loose} data-testid="loose-only" />
        In no trip and no collection
      </label>

      <Button type="submit" variant="secondary" size="sm">Search</Button>
    </form>
  );
}
