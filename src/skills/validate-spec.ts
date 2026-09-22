import type { SkillSpecInput } from './types.js';

/**
 * E2.1 skill spec validation (pure). A registered SkillSpec must be
 * self-consistent before it enters the catalogue: required fields present,
 * version parseable, inputs/outputs declared as objects, permissions drawn
 * from the scope vocabulary, and dependencies shaped correctly. Cross-record
 * checks (unknown dependency / cycle) live in the registry where the full
 * graph is known.
 */

/** Allowed permission scopes. A claim is `scope` or `scope:action`, where
 *  action is a lowercase identifier. Keep this vocabulary closed so a skill
 *  cannot invent rights the governance layer does not understand. */
const PERMISSION_SCOPES = ['realm', 'execute', 'network', 'credential', 'mcp'] as const;

const PERMISSION_RE = /^[a-z][a-z-]*(:[a-z][a-z-]*)?$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

export class SkillValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid skill spec: ${issues.join('; ')}`);
    this.name = 'SkillValidationError';
  }
}

/** Validate the shape of one spec; throws SkillValidationError with every
 *  problem found (not just the first). */
export function validateSkillSpecShape(input: SkillSpecInput): void {
  const issues: string[] = [];

  if (typeof input.id !== 'string' || input.id.trim() === '') issues.push('id is required');
  else if (!/^[a-z0-9][a-z0-9-_./]*$/i.test(input.id)) issues.push(`id has an invalid format: ${input.id}`);

  if (typeof input.name !== 'string' || input.name.trim() === '') issues.push('name is required');

  if (typeof input.version !== 'string' || !VERSION_RE.test(input.version)) {
    issues.push(`version must be major.minor.patch numeric, got: ${String(input.version)}`);
  }

  if (typeof input.description !== 'string') issues.push('description is required');

  if (input.tags !== undefined && !Array.isArray(input.tags)) issues.push('tags must be an array of strings');

  for (const field of ['inputs', 'outputs'] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      issues.push(`${field} must be an object schema descriptor`);
    }
  }

  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions)) {
      issues.push('permissions must be an array');
    } else {
      for (const claim of input.permissions) {
        if (typeof claim !== 'string' || !PERMISSION_RE.test(claim)) {
          issues.push(`invalid permission claim: ${String(claim)}`);
        } else {
          const scope = claim.split(':')[0];
          if (!(PERMISSION_SCOPES as readonly string[]).includes(scope)) {
            issues.push(`unknown permission scope '${scope}'; allowed: ${PERMISSION_SCOPES.join(', ')}`);
          }
        }
      }
    }
  }

  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies) || !input.dependencies.every(dep => typeof dep === 'string')) {
      issues.push('dependencies must be an array of skill ids');
    } else if (input.dependencies.includes(input.id)) {
      issues.push(`skill ${input.id} cannot depend on itself`);
    }
  }

  if (issues.length > 0) throw new SkillValidationError(issues);
}

/** Validate permission claims only; returns every problem found. Used when
 *  hardening narrows an already-registered skill's rights. */
export function validatePermissionClaims(claims: unknown[]): string[] {
  const issues: string[] = [];
  for (const claim of claims) {
    if (typeof claim !== 'string' || !PERMISSION_RE.test(claim)) {
      issues.push(`invalid permission claim: ${String(claim)}`);
    } else {
      const scope = claim.split(':')[0];
      if (!(PERMISSION_SCOPES as readonly string[]).includes(scope)) {
        issues.push(`unknown permission scope '${scope}'; allowed: ${PERMISSION_SCOPES.join(', ')}`);
      }
    }
  }
  return issues;
}
