import type { RealmStore } from '../realm/types.js';
import { sha256Hex } from '../util/crypto.js';
import type { RestoreReport, TreasureMap } from './types.js';

/**
 * In-place verification (L0): reconnect the map's root, re-fingerprint every
 * mark against the live disk, and report ok / changed / missing / unexpected.
 * Never mutates anything. The root is re-scanned on connect, so the enumeration
 * reflects the current disk.
 */
export async function restoreDryRun(map: TreasureMap, store: RealmStore): Promise<RestoreReport> {
  let liveRealmId: string;
  let current: Array<{ itemId: string; content: string }>;
  let contentDigestMatch = false;
  try {
    const manifest = await store.connect(map.realm.root, map.realm.type);
    liveRealmId = manifest.realmId;
    const entries = await store.entries(manifest.realmId);
    current = entries.map(entry => ({ itemId: entry.itemId, content: entry.content }));
    contentDigestMatch = manifest.contentDigest === map.contentDigest;
  } catch {
    return rootUnreachableReport(map);
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
    realmId: liveRealmId,
    rootReachable: true,
    contentDigestMatch,
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
export function restorePlan(map: TreasureMap, store: RealmStore): Promise<RestoreReport> {
  return restoreDryRun(map, store);
}

function rootUnreachableReport(map: TreasureMap): RestoreReport {
  return {
    realmId: map.realm.realmId,
    rootReachable: false,
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
