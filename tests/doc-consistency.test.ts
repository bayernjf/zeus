import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The documentation-consistency checks that review rounds kept performing by
 * hand - and kept finding things with. Four separate sweeps in this repo's
 * recent history surfaced: index rows claiming a version the document does not
 * carry, a review document whose own header still pointed at an older round, a
 * status line that had accumulated 2000 characters and an odd number of bold
 * markers, and a change-log row into which a previous row's body had been
 * pasted, giving that row one extra column.
 *
 * Those are all mechanical, which is the point: a comparison nobody can re-run
 * is a claim, not a guard. Three checks here, each with a positive control so an
 * empty scan cannot pass silently.
 */

const ROOT_FILES = ['handoff.md', 'README.md', 'docs/README.md'];
const DOC_FILES = [
  ...ROOT_FILES,
  ...readdirSync('docs')
    .filter(name => name.endsWith('.md'))
    .map(name => `docs/${name}`),
];

/** The version a document declares about itself, from its status line. */
function declaredVersion(file: string): string | null {
  const head = readFileSync(file, 'utf8').split('\n').slice(0, 16).join('\n');
  const status = head.match(/状态：\*\*[^v]*(v\d+\.\d+)/);
  if (status) return status[1];
  const anyVersion = head.match(/(v\d+\.\d+)/);
  return anyVersion ? anyVersion[1] : null;
}

type IndexRow = { file: string; line: number; target: string; claimed: string };

/** Rows whose only job is to point at a document and name its version: the
 *  handoff index bullets and the docs map table. History rows are excluded by
 *  shape (they are table rows in the change log, not index bullets). */
function indexRows(): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const file of ['handoff.md', 'docs/README.md']) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((text, index) => {
        const isIndexBullet = file === 'handoff.md' && /^\* \[/.test(text);
        const isMapRow = file === 'docs/README.md' && /^\| /.test(text);
        if (!isIndexBullet && !isMapRow) return;
        const link = text.match(/\((?:docs\/)?([a-z0-9\-\.]+\.md)\)/);
        if (!link) return;
        const target = link[1];
        const path = existsSync(`docs/${target}`) ? `docs/${target}` : target;
        if (!existsSync(path)) return;
        const after = text.slice(link.index ?? 0);
        const claim = after.match(/(?<![\w.])v(\d+)\.(\d+)/);
        if (!claim) return;
        rows.push({ file, line: index + 1, target: path, claimed: `v${claim[1]}.${claim[2]}` });
      });
  }
  return rows;
}

/** Column count of a table row: unescaped pipes in the line. */
function rowCount(line: string): number {
  return (line.replace(/\\\|/g, '').match(/\|/g) ?? []).length;
}

describe('documentation consistency', () => {
  it('scans a non-empty population, so it cannot pass by checking nothing', () => {
    expect(DOC_FILES.length).toBeGreaterThan(15);
    expect(indexRows().length).toBeGreaterThan(10);
  });

  it('never lets an index row claim a version the document does not carry', () => {
    const stale = indexRows()
      .map(row => ({ ...row, actual: declaredVersion(row.target) }))
      .filter(row => row.actual !== null && row.claimed !== row.actual)
      .map(row => `${row.file}:${row.line}  ${row.target}  index says ${row.claimed}, document says ${row.actual}`);
    expect(stale, `index rows out of step with the documents they point at:\n${stale.join('\n')}`).toEqual([]);
  });

  it('keeps every table row in a table at the same column count', () => {
    const offenders: string[] = [];
    let tablesChecked = 0;
    for (const file of DOC_FILES) {
      const lines = readFileSync(file, 'utf8').split('\n');
      let inFence = false;
      let rows: { line: number; count: number }[] = [];
      const flush = () => {
        if (rows.length < 2) {
          rows = [];
          return;
        }
        tablesChecked += 1;
        const tally = new Map<number, number[]>();
        for (const row of rows) {
          if (!tally.has(row.count)) tally.set(row.count, []);
          tally.get(row.count)!.push(row.line);
        }
        // The modal column count is the table's shape: a pasted-together row or a
        // stray unescaped pipe always shows up as the minority.
        const [modal, modalLines] = [...tally.entries()].sort((a, b) => b[1].length - a[1].length)[0];
        for (const [count, at] of tally.entries()) {
          if (count !== modal) {
            offenders.push(`${file}:${at.join(',')}  pipes=${count} 其余行是 ${modal}（${modalLines.length} 行）`);
          }
        }
        rows = [];
      };
      lines.forEach((line, index) => {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          flush();
          return;
        }
        if (inFence) return;
        if (/^\s*\|/.test(line)) {
          rows.push({ line: index + 1, count: rowCount(line) });
          return;
        }
        // Blank lines and separator rows stay inside the table; prose ends it.
        if (/^\s*$/.test(line) || /^\|[\s|:-]+\|?\s*$/.test(line)) return;
        flush();
      });
      flush();
    }
    // Positive control: a checker that inspected no table would report nothing.
    expect(tablesChecked).toBeGreaterThan(10);
    expect(offenders, `table rows with a stray unescaped pipe or a pasted-together row:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('pairs every bold marker outside inline code and fenced blocks', () => {
    const unbalanced: string[] = [];
    for (const file of DOC_FILES) {
      let inFence = false;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/^\s*```/.test(line)) {
            inFence = !inFence;
            return;
          }
          if (inFence) return;
          const withoutCode = line.replace(/`[^`]*`/g, '');
          const markers = (withoutCode.match(/\*\*/g) ?? []).length;
          if (markers % 2 !== 0) unbalanced.push(`${file}:${index + 1}  markers=${markers}  ${line.slice(0, 70)}`);
        });
    }
    expect(unbalanced, `lines with an unmatched ** (the rest of the file renders bolded):\n${unbalanced.join('\n')}`).toEqual([]);
  });

  it('keeps the PRD status column a single machine-readable marker', () => {
    const markers = new Set(['✅', '🚧', '⬜']);
    const offenders = (text: string): string[] => {
      const bad: string[] = [];
      text.split('\n').forEach((line, index) => {
        if (!line.startsWith('| E')) return;
        const cells = line.split('\\|').join('').split('|').map(cell => cell.trim());
        const [, id, , priority, status] = cells;
        // Only requirement rows: a row whose third cell is not a priority is prose.
        if (!id || !/^E[\d.]+$/.test(id) || !/^P\d$/.test(priority) || !status) return;
        if (!markers.has(status)) bad.push(`line ${index + 1}  ${id}  status="${status}"`);
      });
      return bad;
    };

    // Calibration first: the checker must catch the shape this guard exists for,
    // and must not catch the clean one. Without this, an empty result on the real
    // table would be indistinguishable from a regex that never matches anything.
    const sample = [
      '| E1.1 | ok | P0 | ✅ | body |',
      '| E3.4 | qualifier drift | P1 | 🚧 stdio | stdio 壳已落地 |',
      '| E9.9 | two cells collapsed | P0 | ✅ 已交付 | body |',
    ].join('\n');
    expect(offenders(sample)).toEqual([
      'line 2  E3.4  status="🚧 stdio"',
      'line 3  E9.9  status="✅ 已交付"',
    ]);
    expect(offenders('| E1.1 | ok | P0 | ✅ | body |')).toEqual([]);

    const rows = readFileSync('docs/prd.md', 'utf8').split('\n').filter(line => /^\| E[\d.]+ \| .* \| P\d \|/.test(line));
    expect(rows.length).toBeGreaterThan(40);
    const found = offenders(readFileSync('docs/prd.md', 'utf8'));
    expect(found, `requirement rows whose status cell holds more than the marker (a review round reads this column mechanically):\n${found.join('\n')}`).toEqual([]);
  });
});
