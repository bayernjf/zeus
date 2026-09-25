import { digestManifest } from '../realm/digest.js';
import { sha256Hex } from '../util/crypto.js';
import type { LiveSource, RestoreReport, TreasureMap } from './types.js';

/**
 * In-place verification (L0): read the source the map names, re-fingerprint
 * every mark against what is there now, and report ok / changed / missing /
 * unexpected. Never mutates anything.
 *
 * The live view is a port rather than a `RealmStore`, for two reasons learned
 * the hard way: the recovery protocol has to cover the kernel state file (which
 * is not a Realm), and reconnecting a tenant-scoped enterprise realm *without*
 * the map's own scope used to surface as "root unreachable" - a false alarm on
 * a healthy corpus, reported by the one tool whose job is to say whether the
 * treasure is still there.
 */
export async function restoreDryRun(map: TreasureMap, live: LiveSource): Promise<RestoreReport> {
  const sourceId = map.source.kind === 'realm' ? map.source.realmId : `files:${map.source.label}`;
  let current: Array<{ itemId: string; content: string }>;
  try {
    current = await live(map.source);
  } catch (error) {
    return unreachableReport(map, sourceId, (error as Error).message);
  }

  const byId = new Map(current.map(entry => [entry.itemId, entry.content]));
  const ok: string[] = [];
  const changed: RestoreReport['changed'] = [];
  const missing: string[] = [];

  for (const mark of map.marks) {
    const liveContent = byId.get(mark.itemId);
    if (liveContent === undefined) {
      missing.push(mark.itemId);
      continue;
    }
    const actualDigest = sha256Hex(liveContent);
    if (actualDigest === mark.digest) {
      ok.push(mark.itemId);
    } else {
      changed.push({ itemId: mark.itemId, expectedDigest: mark.digest, actualDigest });
    }
  }

  const markIds = new Set(map.marks.map(mark => mark.itemId));
  const unexpected = current.filter(entry => !markIds.has(entry.itemId)).map(entry => entry.itemId);
  const recoverable = changed.length === 0 && missing.length === 0;

  return {
    sourceId,
    sourceKind: map.source.kind,
    rootReachable: true,
    contentDigestMatch: digestManifest(current) === map.contentDigest,
    total: map.marks.length,
    ok,
    changed,
    missing,
    unexpected,
    recoverable,
    ...(!recoverable
      ? { suggestion: map.bundle ? 'restore-from-bundle' : 'reconnect-or-provide-bundle' }
      : {}),
  };
}

/** Same verification as dryRun, but named for callers that want the plan + advice. */
export function restorePlan(map: TreasureMap, live: LiveSource): Promise<RestoreReport> {
  return restoreDryRun(map, live);
}

function unreachableReport(map: TreasureMap, sourceId: string, reason: string): RestoreReport {
  return {
    sourceId,
    sourceKind: map.source.kind,
    rootReachable: false,
    unreachableReason: reason,
    contentDigestMatch: false,
    total: map.marks.length,
    ok: [],
    changed: [],
    missing: map.marks.map(mark => mark.itemId),
    unexpected: [],
    recoverable: false,
    suggestion: map.bundle ? 'restore-from-bundle' : 'reconnect-or-provide-bundle',
  };
}
