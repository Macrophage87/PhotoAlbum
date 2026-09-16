"use client";

import { useState } from "react";
import { Button, Input, Label, Select } from "@/components/ui";
import { nameCluster } from "@/app/people/actions";

export type Known = { id: string; name: string };

/**
 * Naming form for an unnamed cluster. An admin records the birthday (or an adult attestation) and the indexing
 * decision in the same step; a member only names, and can flag a child so the templates are dropped at once.
 */
export function NameClusterForm({ clusterId, isAdmin, people, pets = [] }: { clusterId: string; isAdmin: boolean; people: Known[]; pets?: Known[] }) {
  const [existing, setExisting] = useState("");
  const [birthday, setBirthday] = useState("");
  const [attest, setAttest] = useState(false);
  const action = nameCluster.bind(null, clusterId);
  const minorByBirthday = birthday ? new Date().getTime() - Date.parse(birthday) < 18 * 365.25 * 86_400_000 : false;
  return (
    <form action={action} className="space-y-2 text-sm">
      {(people.length > 0 || pets.length > 0) && (
        <div>
          <Label htmlFor={`known-${clusterId}`}>Someone already named?</Label>
          <Select id={`known-${clusterId}`} name="personId" value={existing} onChange={(e) => setExisting(e.target.value)} className="h-9">
            <option value="">New person</option>
            {people.length > 0 && (
              <optgroup label="People">
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            )}
            {/* The detector finds dogs often enough that a whole group can be one, and the family should be able to say so. */}
            {pets.length > 0 && (
              <optgroup label="Pets">
                {pets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </Select>
        </div>
      )}
      {!existing && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label htmlFor={`name-${clusterId}`}>Name</Label>
              <Input id={`name-${clusterId}`} name="name" required className="h-9" />
            </div>
            <div>
              <Label htmlFor={`rel-${clusterId}`}>Relationship</Label>
              <Input id={`rel-${clusterId}`} name="relationship" placeholder="Grandma, cousin…" className="h-9" />
            </div>
          </div>
          {isAdmin ? (
            <>
              <div>
                <Label htmlFor={`bday-${clusterId}`}>Birthday</Label>
                <Input id={`bday-${clusterId}`} name="birthday" type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} className="h-9 w-44" />
              </div>
              {!birthday && (
                <label className="flex items-start gap-2">
                  <input type="checkbox" name="attest" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-1" />
                  <span>I confirm this person is an adult and has agreed to face recognition</span>
                </label>
              )}
              {minorByBirthday && (
                <label className="flex items-start gap-2">
                  <input type="checkbox" name="parentInstruction" className="mt-1" />
                  <span>A parent has asked for this child to be recognised (a minor is otherwise never matched)</span>
                </label>
              )}
              <label className="flex items-start gap-2">
                <input type="checkbox" name="faceIndexing" className="mt-1" />
                <span>
                  <span className="font-medium">Recognise this person in new photos</span>
                  <span className="block text-muted">Keeps their face templates on this server. Off by default; without a birthday or the attestation the templates are dropped now.</span>
                </span>
              </label>
            </>
          ) : (
            <label className="flex items-start gap-2">
              <input type="checkbox" name="isChild" className="mt-1" />
              <span>
                <span className="font-medium">This person is a child</span>
                <span className="block text-muted">Drops the face templates now. Otherwise an admin decides whether recognition is turned on; templates wait meanwhile.</span>
              </span>
            </label>
          )}
        </>
      )}
      {existing && (
        <p className="text-muted">
          {pets.some((p) => p.id === existing)
            ? "These faces are recorded as that pet, and their templates are dropped: a pet is spotted by the animal detector, never by face."
            : "These faces are added to that person and follow their recognition setting."}
        </p>
      )}
      <Button type="submit" size="sm">Name these faces</Button>
    </form>
  );
}
