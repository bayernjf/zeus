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

/** Non-mcp scopes keep the closed lowercase vocabulary: `scope` or `scope:action`. */
const PERMISSION_RE = /^[a-z][a-z-]*(:[a-z][a-z-]*)?$/;
/**
 * deferred #30: an `mcp:<tool>` grant names an upstream MCP tool verbatim.
 * Real MCP servers name tools with underscores, dots and capitals
 * (`fetch_html`, `notion.search`, `Search`), so the part after `mcp:` is not
 * run through the closed skill vocabulary — it is compared against the
 * handshake capability list as-is. We only reject the shapes that could never
 * be a tool name: empty, surrounding whitespace, control chars.
 */
const MCP_TOOL_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Validate one permission claim against its scope's rules. Returns an issue
 *  message, or null when the claim is well-formed.
 *  - `mcp` / `mcp:<upstream-tool>`: the tool segment is the upstream name
 *    verbatim (underscores/dots/capitals allowed; deferred #30).
 *  - every other scope: closed lowercase vocabulary, `scope[:action]`. */
export function permissionClaimIssue(claim: unknown): string | null {
  if (typeof claim !== 'string') return `invalid permission claim: ${String(claim)}`;
  if (claim === 'mcp') return null;
  if (claim.startsWith('mcp:')) {
    const tool = claim.slice(4);
    if (!MCP_TOOL_NAME_RE.test(tool)) return `invalid mcp tool grant (name must match the upstream tool verbatim): ${claim}`;
    return null;
  }
  if (!PERMISSION_RE.test(claim)) return `invalid permission claim: ${claim}`;
  const scope = claim.split(':')[0];
  if (!(PERMISSION_SCOPES as readonly string[]).includes(scope)) {
    return `unknown permission scope '${scope}'; allowed: ${PERMISSION_SCOPES.join(', ')}`;
  }
  return null;
}

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
        const issue = permissionClaimIssue(claim);
        if (issue) issues.push(issue);
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
    const issue = permissionClaimIssue(claim);
    if (issue) issues.push(issue);
  }
  return issues;
}
