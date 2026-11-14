// Meeting minutes as markdown: a projection of the meeting document, not a
// second source of truth. The point is that a decided meeting leaves something
// you can paste into a handoff, including the proposals that lost and why.

import { claimGraph } from './protocol.js';
import type { Claim, Meeting } from './types.js';

function evidenceLine(claim: Claim): string | null {
  if (claim.evidence.length === 0) return null;
  return claim.evidence
    .map(item => `${item.kind}:${item.ref}${item.note ? `（${item.note}）` : ''}`)
    .join('；');
}

function stamp(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function speakerOf(meeting: Meeting, claimId: string): { speakerId: string; round: number; at: string } | null {
  for (const utterance of meeting.utterances) {
    for (const claim of utterance.claims) {
      if (claim.id === claimId) {
        return { speakerId: utterance.speakerId, round: utterance.round, at: utterance.at };
      }
    }
  }
  return null;
}

export function exportMarkdown(meeting: Meeting, options: { now?: string } = {}): string {
  const lines: string[] = [];
  const generatedAt = options.now ?? new Date().toISOString();
  const claimsById = new Map<string, Claim>(
    meeting.utterances.flatMap(utterance => utterance.claims).map(claim => [claim.id, claim]),
  );
  const graph = claimGraph(meeting);

  lines.push(`# ${meeting.topic}`);
  lines.push('');
  lines.push(`- 会议 id：\`${meeting.id}\``);
  lines.push(`- 状态：${meeting.status}`);
  lines.push(`- 轮次：${meeting.round} / ${meeting.maxRounds}`);
  lines.push(`- 创建：${stamp(meeting.createdAt)}`);
  lines.push(`- 纪要生成：${stamp(generatedAt)}`);
  lines.push('');

  lines.push('## 决策');
  lines.push('');
  if (meeting.decisions.length === 0) {
    lines.push(meeting.status === 'decided' || meeting.status === 'archived'
      ? '（无决策记录）'
      : '_尚未决策：这场会议还停在过程里，下面是当前的主张状态。_');
    lines.push('');
  } else {
    for (const decision of meeting.decisions) {
      lines.push(`### 决策 \`${decision.id}\` · ${decision.by} · ${stamp(decision.at)}`);
      lines.push('');
      lines.push('**采纳**');
      lines.push('');
      if (decision.chosenClaimIds.length === 0) {
        lines.push('（无）');
      } else {
        for (const claimId of decision.chosenClaimIds) {
          const claim = claimsById.get(claimId);
          const origin = speakerOf(meeting, claimId);
          lines.push(`- \`${claimId}\`${claim ? ` ${claim.text}` : '（主张已不在会议上）'}`
            + `${origin ? ` — ${origin.speakerId}，第 ${origin.round} 轮` : ''}`);
          const evidence = claim ? evidenceLine(claim) : null;
          if (evidence) lines.push(`  - 证据：${evidence}`);
        }
      }
      lines.push('');
      lines.push('**否决**');
      lines.push('');
      if (decision.rejectedClaimIds.length === 0) {
        lines.push('（无）');
      } else {
        for (const claimId of decision.rejectedClaimIds) {
          const claim = claimsById.get(claimId);
          const origin = speakerOf(meeting, claimId);
          lines.push(`- \`${claimId}\`${claim ? ` ${claim.text}` : '（主张已不在会议上）'}`
            + `${origin ? ` — ${origin.speakerId}，第 ${origin.round} 轮` : ''}`);
        }
      }
      lines.push('');
      lines.push('**理由**');
      lines.push('');
      lines.push(`> ${decision.rationale}`);
      lines.push('');
    }
  }

  lines.push('## 过程');
  lines.push('');
  if (meeting.utterances.length === 0) {
    lines.push('（还没有发言）');
    lines.push('');
  }
  const rounds = [...new Set(meeting.utterances.map(utterance => utterance.round))].sort((a, b) => a - b);
  for (const round of rounds) {
    lines.push(`### 第 ${round} 轮`);
    lines.push('');
    for (const utterance of meeting.utterances.filter(event => event.round === round)) {
      const rebutText = utterance.rebuts.length > 0 ? ` · 反驳 ${utterance.rebuts.map(id => `\`${id}\``).join(', ')}` : '';
      lines.push(`- **${utterance.speakerId}**（${utterance.kind}）· ${utterance.stance} · ${stamp(utterance.at)}${rebutText}`);
      for (const claim of utterance.claims) {
        lines.push(`  - \`${claim.id}\` ${claim.text}`);
        const evidence = evidenceLine(claim);
        lines.push(`    - 证据：${evidence ?? '（无）'}`);
      }
    }
    lines.push('');
  }

  lines.push('## 被反驳但未裁决');
  lines.push('');
  if (graph.undecided.length === 0) {
    lines.push('（无）');
  } else {
    for (const claimId of graph.undecided) {
      const claim = claimsById.get(claimId);
      lines.push(`- \`${claimId}\` ${claim?.text ?? ''}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
