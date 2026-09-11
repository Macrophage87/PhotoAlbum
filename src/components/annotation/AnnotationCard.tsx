import { Badge, Button, Card, Input, Label, Textarea } from "@/components/ui";
import type { StoredAnnotation } from "@/lib/annotation/schema";
import { reannotate, updateAnnotation } from "@/app/annotation/actions";
import { OptOutToggle } from "./OptOutToggle";

/** The helper's description on the item page: read for everyone who may see the item, editable for members. */
export function AnnotationCard({ photoId, annotation, source, model, error, optOut, optOutReason, active, editable }: { photoId: string; annotation: StoredAnnotation | null; source: string | null; model: string | null; error: string | null; optOut: boolean; /** Why the item will not be sent (its own flag, or an opted-out trip or collection), or null. */ optOutReason: string | null; active: boolean; editable: boolean }) {
  const update = updateAnnotation.bind(null, photoId);
  const again = reannotate.bind(null, photoId);
  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium">Description</h2>
        {annotation && <Badge tone={source === "EDITED" ? "primary" : "neutral"}>{source === "EDITED" ? "edited by the family" : `written by the AI helper${model ? ` (${model})` : ""}`}</Badge>}
      </div>
      {!annotation && (
        <p className="text-sm text-muted">
          {error ? `The helper could not describe this item (${error.replace(":", ": ")}).` : optOutReason ? `Not sent to the AI helper. ${optOutReason === "this item is opted out" ? "" : `(${optOutReason[0].toUpperCase()}${optOutReason.slice(1)}.)`}` : active ? "No description yet; it is written a little while after the upload is reviewed." : "No description. The AI helper is off; an admin can turn it on."}
        </p>
      )}
      {annotation && editable ? (
        <form action={update} className="space-y-3 text-sm">
          <div>
            <Label htmlFor="a-caption">Caption</Label>
            <Input id="a-caption" name="caption" defaultValue={annotation.caption} />
          </div>
          <div>
            <Label htmlFor="a-description">Description</Label>
            <Textarea id="a-description" name="description" rows={4} defaultValue={annotation.description} />
          </div>
          <div>
            <Label htmlFor="a-tags">Tags (comma separated)</Label>
            <Input id="a-tags" name="tags" defaultValue={annotation.tags.join(", ")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="a-place">Place</Label>
              <Input id="a-place" name="place" defaultValue={annotation.place ?? ""} />
            </div>
            <div>
              <Label htmlFor="a-activity">Activity</Label>
              <Input id="a-activity" name="activity" defaultValue={annotation.activity ?? ""} />
            </div>
          </div>
          <div>
            <Label htmlFor="a-objects">Objects (comma separated)</Label>
            <Input id="a-objects" name="objects" defaultValue={annotation.objects.join(", ")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="a-text">Visible text</Label>
              <Input id="a-text" name="visibleText" defaultValue={annotation.visibleText ?? ""} />
            </div>
            <div>
              <Label htmlFor="a-mood">Mood</Label>
              <Input id="a-mood" name="mood" defaultValue={annotation.mood ?? ""} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm">Save description</Button>
          </div>
        </form>
      ) : annotation ? (
        <div className="text-sm space-y-2">
          <p className="font-medium">{annotation.caption}</p>
          <p>{annotation.description}</p>
          {annotation.tags.length > 0 && <p className="text-muted">{annotation.tags.join(" · ")}</p>}
          {annotation.place && <p className="text-muted">Place: {annotation.place}</p>}
        </div>
      ) : null}
      {editable && (
        <div className="space-y-2 pt-2 border-t border-border">
          {active && !optOutReason && (
            <form action={again}>
              <Button type="submit" variant="secondary" size="sm">{annotation ? "Describe again" : "Describe now"}</Button>
            </form>
          )}
          <OptOutToggle target={{ kind: "photo", id: photoId }} initial={optOut} />
        </div>
      )}
    </Card>
  );
}
