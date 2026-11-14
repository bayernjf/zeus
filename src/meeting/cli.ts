// Minimal CLI for the local meeting flow. It prints JSON so an agent (or the
// owner in a shell) can drive a meeting without a UI; the web dialog comes later.

import { MeetingStore } from './store.js';
import { advanceRound, claimGraph, createMeeting, decide, recordUtterance } from './protocol.js';
import type { Evidence, EvidenceKind, SpeakerKind, Stance, Utterance } from './types.js';

const DEFAULT_DIR = process.env.ZEUS_MEETING_DIR ?? '.zeus-meetings';

type Flags = Map<string, string[]>;

function parse(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags.set(key, [...(flags.get(key) ?? []), 'true']);
      } else {
        flags.set(key, [...(flags.get(key) ?? []), value]);
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional.shift() ?? 'help', positional, flags };
}

function one(flags: Flags, key: string): string | undefined {
  return flags.get(key)?.at(-1);
}

function many(flags: Flags, key: string): string[] {
  return flags.get(key) ?? [];
}

function now(): string {
  return new Date().toISOString();
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const STANCES: Stance[] = ['propose', 'challenge', 'support', 'note'];
const KINDS: SpeakerKind[] = ['agent', 'human'];
const EVIDENCE: EvidenceKind[] = ['fact', 'observation', 'reference', 'counterexample'];

async function main(): Promise<void> {
  const { command, positional, flags } = parse(process.argv.slice(2));
  const store = new MeetingStore(one(flags, 'dir') ?? DEFAULT_DIR);

  if (command === 'open') {
    const topic = one(flags, 'topic');
    if (!topic) throw new Error('open requires --topic');
    const id = one(flags, 'id') ?? `m-${Date.now().toString(36)}`;
    const maxRounds = Number(one(flags, 'max-rounds') ?? 2);
    const meeting = createMeeting({ id, topic, createdAt: now(), maxRounds });
    await store.save(meeting);
    print({ id: meeting.id, status: meeting.status, round: meeting.round, maxRounds: meeting.maxRounds });
    return;
  }

  if (command === 'list') {
    const meetings = await store.list();
    print(meetings.map(meeting => ({
      id: meeting.id,
      topic: meeting.topic,
      status: meeting.status,
      round: meeting.round,
      utterances: meeting.utterances.length,
      decisions: meeting.decisions.length,
    })));
    return;
  }

  const meetingId = positional[0];
  if (!meetingId) throw new Error(`${command} requires a meeting id`);

  if (command === 'show') {
    const meeting = await store.load(meetingId);
    print(one(flags, 'graph') === 'true' ? claimGraph(meeting) : meeting);
    return;
  }

  if (command === 'advance') {
    const meeting = advanceRound(await store.load(meetingId));
    await store.save(meeting);
    print({ id: meeting.id, status: meeting.status, round: meeting.round });
    return;
  }

  if (command === 'say') {
    const meeting = await store.load(meetingId);
    const speaker = one(flags, 'speaker');
    if (!speaker) throw new Error('say requires --speaker');
    const kind = (one(flags, 'kind') ?? 'agent') as SpeakerKind;
    if (!KINDS.includes(kind)) throw new Error(`--kind must be ${KINDS.join('|')}`);
    const stance = (one(flags, 'stance') ?? 'propose') as Stance;
    if (!STANCES.includes(stance)) throw new Error(`--stance must be ${STANCES.join('|')}`);

    const evidenceByClaim = new Map<string, Evidence[]>();
    for (const raw of many(flags, 'evidence')) {
      const [claimId, kindRaw, ref, note] = raw.split('|');
      if (!claimId || !kindRaw || !ref) throw new Error('--evidence must be claimId|kind|ref|note');
      const evidenceKind = kindRaw as EvidenceKind;
      if (!EVIDENCE.includes(evidenceKind)) throw new Error(`evidence kind must be ${EVIDENCE.join('|')}`);
      evidenceByClaim.set(claimId, [
        ...(evidenceByClaim.get(claimId) ?? []),
        { kind: evidenceKind, ref, note: note ?? '' },
      ]);
    }

    const claims = many(flags, 'claim').map((raw) => {
      const [id, ...textParts] = raw.split('|');
      const text = textParts.join('|');
      if (!id || !text) throw new Error('--claim must be id|text');
      return { id, text, evidence: evidenceByClaim.get(id) ?? [] };
    });

    const utterance: Utterance = {
      id: one(flags, 'id') ?? `u-${meeting.utterances.length + 1}`,
      speakerId: speaker,
      kind,
      round: meeting.round,
      stance,
      claims,
      rebuts: many(flags, 'rebut'),
      at: now(),
    };
    const next = recordUtterance(meeting, utterance);
    await store.save(next);
    print({ id: next.id, status: next.status, round: next.round, recorded: utterance.id });
    return;
  }

  if (command === 'decide') {
    const meeting = await store.load(meetingId);
    const next = decide(meeting, {
      id: one(flags, 'id') ?? `d-${meeting.decisions.length + 1}`,
      by: one(flags, 'by') ?? 'owner',
      chosenClaimIds: many(flags, 'chosen'),
      rejectedClaimIds: many(flags, 'rejected'),
      rationale: one(flags, 'rationale') ?? '',
      at: now(),
    });
    await store.save(next);
    print({ id: next.id, status: next.status });
    return;
  }

  process.stderr.write(
    'usage: open --topic <t> [--id] [--max-rounds] [--dir] | say <id> --speaker <s> [--stance] [--claim id|text] [--rebut id] [--evidence claimId|kind|ref|note] | advance <id> | decide <id> --chosen <id> --rationale <r> | show <id> [--graph] | list\n',
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
