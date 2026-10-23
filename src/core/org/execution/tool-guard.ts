/**
 * Tier0 M7 (T-M7-01) execution contract — tool authority guard.
 *
 * The only way an executor performs an external effect is through a
 * framework-controlled tool call (`ctx.tool(name, args)`). The guard is the
 * single place that checks the bound position's `allowedTools` and fails
 * closed on any tool that is not explicitly granted. The executor can never
 * bypass the check by reaching for the channel directly, because it never
 * holds credentials or channel clients (only references) — those live behind
 * the framework-invoked tool surface.
 *
 * T-M7-01 enforces the position allow-list. Mapping of a tool to the decision
 * grade it requires (so a D2 position cannot silently perform a D3 action,
 * which instead becomes a requestDecision checkpoint) is T-M7-03 (SOP/skill
 * mapping); the guard is the enforcement point for that later mapping.
 */
import { ToolDeniedError } from './errors.js';

/** A position grants exactly this set of tool names (position.allowedTools). */
export function isToolGranted(tool: string, grantedTools: readonly string[]): boolean {
  return grantedTools.includes(tool);
}

/** Assert the tool is granted, throwing ToolDeniedError (fail-closed) otherwise. */
export function assertToolGranted(tool: string, grantedTools: readonly string[]): void {
  if (!isToolGranted(tool, grantedTools)) {
    throw new ToolDeniedError(tool, grantedTools);
  }
}

/**
 * Filter a candidate tool list down to what the position grants. Used by
 * adapters to expose only the permitted surface; it never throws, so an
 * adapter can render the reduced set up front.
 */
export function grantedSubset(tools: readonly string[], grantedTools: readonly string[]): string[] {
  return tools.filter(t => isToolGranted(t, grantedTools));
}
