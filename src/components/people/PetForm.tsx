import { Button, Input, Label, Select } from "@/components/ui";
import { createPet, updatePet } from "@/app/people/actions";

const SPECIES = [["DOG", "Dog"], ["CAT", "Cat"], ["CHICKEN", "Chicken"], ["HORSE", "Horse"], ["OTHER", "Other"]] as const;

type Pet = { id: string; name: string; species: string | null; livedFrom: Date | null; livedTo: Date | null; isFlock: boolean; descriptors?: string | null };
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

/** Create or edit a pet: name, species, lifespan, or a flock record for a species nobody tells apart. */
export function PetForm({ pet }: { pet?: Pet }) {
  const action = pet ? updatePet.bind(null, pet.id) : createPet;
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2 text-sm">
      <div>
        <Label htmlFor="pet-name">Name</Label>
        <Input id="pet-name" name="name" required defaultValue={pet?.name ?? ""} placeholder="Biscuit, or “the chickens”" className="h-9" />
      </div>
      <div>
        <Label htmlFor="pet-species">Species</Label>
        <Select id="pet-species" name="species" defaultValue={pet?.species ?? "DOG"} className="h-9">
          {SPECIES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="pet-from">With us from</Label>
        <Input id="pet-from" name="livedFrom" type="date" defaultValue={day(pet?.livedFrom ?? null)} className="h-9" />
      </div>
      <div>
        <Label htmlFor="pet-to">Until</Label>
        <Input id="pet-to" name="livedTo" type="date" defaultValue={day(pet?.livedTo ?? null)} className="h-9" />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="pet-descriptors">Looks like (optional)</Label>
        <Input id="pet-descriptors" name="descriptors" defaultValue={pet?.descriptors ?? ""} placeholder="golden retriever, floppy ears" className="h-9" />
      </div>
      <label className="flex items-center gap-2 sm:col-span-2">
        <input type="checkbox" name="isFlock" defaultChecked={pet?.isFlock ?? false} />
        A flock or group record (“the chickens”), not one animal
      </label>
      <div className="sm:col-span-2">
        <Button type="submit" size="sm">{pet ? "Save" : "Add pet"}</Button>
      </div>
    </form>
  );
}
