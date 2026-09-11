/**
 * The consent rules for faces, as pure functions so the decision table is unit-tested.
 *
 * Detection needs two gates (operator flag and admin opt-in). Matching for a person needs their own switch, which
 * only an admin can turn on, and which passes the minors check: a birthday showing 18 or older, or an adult
 * attestation. Anyone else ends up with their templates nulled.
 */
export type ConsentFields = { birthday: Date | null; adultAttestedAt: Date | null; faceIndexing: boolean };

export function ageOn(birthday: Date, on = new Date()): number {
  let age = on.getUTCFullYear() - birthday.getUTCFullYear();
  const m = on.getUTCMonth() - birthday.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < birthday.getUTCDate())) age--;
  return age;
}

export function isMinor(p: Pick<ConsentFields, "birthday">, now = new Date()): boolean {
  return Boolean(p.birthday) && ageOn(p.birthday!, now) < 18;
}

/** Passes only with a birthday showing 18 or older, or an attestation; a null birthday with no attestation never passes. */
export function minorsCheckPasses(p: Pick<ConsentFields, "birthday" | "adultAttestedAt">, now = new Date()): boolean {
  if (p.adultAttestedAt) return true;
  return Boolean(p.birthday) && !isMinor(p, now);
}

export type NamingInput = { byAdmin: boolean; wantIndexing: boolean; parentInstruction: boolean; birthday: Date | null; attest: boolean; isChildFlag: boolean };
export type NamingOutcome = { faceIndexing: boolean; nullTemplates: boolean; pendingDecision: boolean; attested: boolean };

/**
 * What naming a cluster does to its templates.
 * - Admin naming: indexing on only when asked for and the minors check passes (a minor needs a parent instruction);
 *   any naming that ends with indexing off nulls the templates at once.
 * - Member naming: indexing off, templates kept while the cluster waits for an admin decision, unless the member
 *   marks the person as a child, which nulls them immediately.
 */
export function namingOutcome(input: NamingInput, now = new Date()): NamingOutcome {
  const attested = input.byAdmin && input.attest && !input.birthday;
  if (!input.byAdmin) {
    return { faceIndexing: false, nullTemplates: input.isChildFlag, pendingDecision: !input.isChildFlag, attested: false };
  }
  const minor = isMinor({ birthday: input.birthday }, now);
  const passes = minorsCheckPasses({ birthday: input.birthday, adultAttestedAt: attested ? now : null }, now);
  const on = input.wantIndexing && (passes || (minor && input.parentInstruction));
  return { faceIndexing: on, nullTemplates: !on, pendingDecision: false, attested };
}

/** Whether this person's name may be sent to the AI helper: indexing on and not a minor. */
export function nameMayLeaveServer(p: ConsentFields, now = new Date()): boolean {
  return p.faceIndexing && !isMinor(p, now);
}
