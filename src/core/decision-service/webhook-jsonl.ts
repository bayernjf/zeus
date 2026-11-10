/**
 * Opt-in JSONL persistence for decision webhook subscriptions in the
 * memory/demo mode (no ZEUS_DB_FILE). The durable mode keeps the registry in
 * SQLite (Active work 276); without a DB the registry used to stay in memory
 * and lose every operator-created subscription on restart. Pointing
 * ZEUS_WEBHOOK_SUBSCRIPTIONS_FILE at a path gives that mode the same restart
 * guarantee through a local file, following the JsonlTraceExporter /
 * JsonlEvalRunsStore pattern: unset = the in-memory behavior is unchanged; set
 * = every mutation lands on disk and a boot reads the file back (readBack).
 *
 * Secrets stay plaintext on the operator's own disk — the dispatcher needs the
 * HMAC key at delivery time and zeus has no at-rest key-management story, the
 * same stance the SQLite store took (Active work 276). The file is 0600 and
 * the directory 0700, re-asserted at every write so a recreate race cannot
 * relax them; the secret is never selected into an HTTP response and never
 * logged.
 *
 * Unlike the trace exporter's append-only JSONL, this registry supports
 * deletion (the bearer DELETE route), so a mutation rewrites the whole file:
 * the registry is a small operator-managed list, not an audit history, and a
 * tombstone log would turn every read into a fold. After any settled mutation
 * the file equals the in-memory registry, so "read the file with plain tools"
 * stays honest. Rewrites go through a temp file + atomic rename, so a crash
 * mid-flush cannot leave a torn registry behind, and concurrent mutations are
 * serialized through a one-deep write chain.
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DecisionWebhookStore, DecisionWebhookSubscription } from './webhook.js';

/** One persisted subscription as it appears on a JSONL line. */
export type PersistedWebhookSubscription = DecisionWebhookSubscription;

function parseLine(line: string, lineNo: number): PersistedWebhookSubscription {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    throw new Error(`decision webhook registry at line ${lineNo}: not valid JSON`);
  }
  const sub = record as Partial<PersistedWebhookSubscription> | null;
  if (
    typeof sub?.id !== 'string' ||
    typeof sub?.url !== 'string' ||
    typeof sub?.secret !== 'string' ||
    typeof sub?.active !== 'boolean'
  ) {
    throw new Error(`decision webhook registry at line ${lineNo}: expected {id,url,secret,active}`);
  }
  return { id: sub.id, url: sub.url, secret: sub.secret, active: sub.active };
}

export class JsonlDecisionWebhookStore implements DecisionWebhookStore {
  /** Insertion-ordered registry; the file preserves this order. */
  private readonly subscriptions = new Map<string, PersistedWebhookSubscription>();
  /** Serializes file rewrites; each mutation awaits its own flush result. */
  private writes: Promise<void> = Promise.resolve();
  /** Guards the one-time hydration; false until the file was read (or found
   *  absent). A failed read leaves it false so the next access retries. */
  private loaded = false;

  constructor(private readonly filePath: string) {}

  /**
   * Rebuild the registry from the file (the boot-time readBack). A missing
   * file is a first boot, not an error — an empty registry. A malformed line
   * refuses to open (fail-closed): silently dropping a row would quietly stop
   * deliveries the operator believed were registered.
   */
  async readBack(): Promise<PersistedWebhookSubscription[]> {
    await this.ensureLoaded();
    return this.list();
  }

  async list(): Promise<PersistedWebhookSubscription[]> {
    await this.ensureLoaded();
    return [...this.subscriptions.values()].map(s => ({ ...s }));
  }

  /** Upsert by id: the boot seeder re-applies the env seed on every start
   *  without duplicating the row (same contract as the SQLite store). */
  async add(subscription: DecisionWebhookSubscription): Promise<void> {
    await this.ensureLoaded(); // before ANY mutation: a flush rewrites the file
    this.subscriptions.set(subscription.id, { ...subscription });
    await this.flush();
  }

  /** Hard delete; false when no row with that id existed (the HTTP layer maps
   *  that to 404). A successful delete rewrites the file, so the removed row
   *  is gone from disk when the route answers 204. */
  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded(); // same as add(): never rewrite a half-read registry
    if (!this.subscriptions.has(id)) return false;
    this.subscriptions.delete(id);
    await this.flush();
    return true;
  }

  /** Hydrate once, lazily: the serve boot calls readBack() explicitly so a
   *  malformed registry fails the boot, not the first request. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.loaded = true;
        return;
      }
      throw error;
    }
    const parsed: PersistedWebhookSubscription[] = [];
    let lineNo = 0;
    for (const line of raw.split('\n')) {
      lineNo += 1;
      if (line.trim() === '') continue;
      parsed.push(parseLine(line, lineNo));
    }
    this.subscriptions.clear();
    for (const subscription of parsed) this.subscriptions.set(subscription.id, subscription);
    this.loaded = true;
  }

  /** Queue one full rewrite (temp file + atomic rename, 0700 dir / 0600 file);
   *  the caller sees its own failure while the chain survives it. */
  private flush(): Promise<void> {
    const next = this.writes.then(() => this.writeThrough());
    this.writes = next.catch(() => {});
    return next;
  }

  private async writeThrough(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const body = [...this.subscriptions.values()].map(s => `${JSON.stringify(s)}\n`).join('');
    const temp = `${this.filePath}.tmp`;
    const handle = await open(temp, 'w', 0o600);
    try {
      await handle.writeFile(body, { encoding: 'utf8' });
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    // rename preserves the temp file's mode, so a pre-existing lax target
    // (hand-created before the store ever ran) settles at 0600 too — the file
    // is replaced, not opened in place.
    await rename(temp, this.filePath);
  }
}
