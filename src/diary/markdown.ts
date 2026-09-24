/**
 * renderDiaryMarkdown: deterministic, human-readable diary template
 * (design-diary §5). Each timeline line carries its source eventId so the
 * rendered markdown itself remains traceable.
 */
import type { DiaryEntry } from './types.js';
import { formatTime, renderObject } from './render.js';

export function renderDiaryMarkdown(entry: DiaryEntry, timeZone: string = 'UTC'): string {
  const out: string[] = [];
  out.push(`# Diary · ${entry.date}`, '');
  out.push(
    `> realm: ${entry.realmId} · ${entry.lines.length} event${entry.lines.length === 1 ? '' : 's'} · ` +
      `window ${formatTime(entry.windowStart, timeZone)}–${formatTime(entry.windowEnd, timeZone)}`,
    '',
  );

  out.push('## Timeline', '');
  for (const line of entry.lines) {
    const owner = line.taskId ? `${line.agentId} (task ${line.taskId})` : line.agentId;
    out.push(`- \`${formatTime(line.occurredAt, timeZone)}\` **${line.kind}** · ${owner}`);
    out.push(`  ${line.text.split('\n').join('\n  ')}`);
    out.push(`  (\`event:${line.eventId}\`, confidence ${line.confidence})`, '');
  }

  if (entry.facts.length > 0) {
    out.push('## Facts', '');
    for (const fact of entry.facts) {
      out.push(
        `- \`fact:${fact.factId}\` (${fact.status}, v${fact.version}, ${fact.confidence}) ` +
          `${fact.subject} ${fact.predicate} ${renderObject(fact.object, 80)}`,
      );
    }
    out.push('');
  }

  return out.join('\n');
}
