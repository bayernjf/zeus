import type { SkillSpecInput } from './types.js';

/**
 * Copies a caller-supplied object into a `SkillSpecInput` field by field.
 *
 * The point is that no key outside this list can reach the persisted catalogue,
 * so a request body or a JSON file cannot smuggle `status`, `registeredAt`, or
 * anything the registry owns into a skill record. Both faces that accept an
 * explicit spec — `POST /api/skills` and `npm run daily --spec` — go through
 * here, because two copies of this list would drift apart and the weaker one
 * would be the live contract.
 *
 * Nothing is validated here: shape problems are the validator's job
 * (`validateSkillSpecShape`, called by `SkillRegistry.register`), which names the
 * offending field rather than guessing at it.
 */
export function skillSpecInputFrom(payload: Record<string, unknown>): SkillSpecInput {
  const input: Record<string, unknown> = {
    id: payload.id,
    name: payload.name,
    description: payload.description,
    version: payload.version,
  };
  for (const key of [
    'domain',
    'tags',
    'aliases',
    'inputs',
    'outputs',
    'permissions',
    'dependencies',
    'providedBy',
    'status',
  ] as const) {
    if (payload[key] !== undefined) input[key] = payload[key];
  }
  return input as unknown as SkillSpecInput;
}
