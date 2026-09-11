import { env } from "@/lib/env";
import { mlConfigured } from "@/lib/ml/client";

export type PetGates = { sidecar: boolean; envEnabled: boolean; active: boolean };

/** Animal spotting needs the sidecar and the operator flag; no per-animal consent applies, so there is no opt-in step. */
export function petGates(): PetGates {
  const sidecar = mlConfigured();
  const envEnabled = env().PET_MATCHING_ENABLED;
  return { sidecar, envEnabled, active: sidecar && envEnabled };
}
