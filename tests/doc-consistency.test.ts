import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The documentation-consistency checks that review rounds kept performing by
 * hand - and kept finding things with. Four separate sweeps in this repo's
 * recent history surfaced: index rows claiming a version the document does not
 * carry, a review document whose own header still pointed at an older round, a
 * status line that had accumulated 2000 characters and an odd number of bold
 * markers, and a change-log row into which a previous row's body had been
 * pasted, giving that row one extra column. A fifth is the opening paragraph
 * quoting a live baseline - test count, file count, smoke steps - that nothing
 * compared against Current state, so it lagged two batches behind the state it
 * describes.
 *
 * Those are all mechanical, which is the point: a comparison nobody can re-run
 * is a claim, not a guard. Every check here carries a positive control so an
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
  if (status) return status[1]!;
  const anyVersion = head.match(/(v\d+\.\d+)/);
  return anyVersion ? anyVersion[1]! : null;
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
        const target = link[1]!;
        const path = existsSync(`docs/${target}`) ? `docs/${target}` : target;
        if (!existsSync(path)) return;
        const after = text.slice(link.index ?? 0);
        const claim = after.match(/(?<![\w.])v(\d+)\.(\d+)/);
        if (!claim) return;
        rows.push({ file, line: index + 1, target: path, claimed: `v${claim[1]!}.${claim[2]!}` });
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
        const [modal, modalLines] = [...tally.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
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
        if (!id || !/^E[\d.]+$/.test(id) || !/^P\d$/.test(priority ?? '') || !status) return;
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

  it('keeps the header paragraph quoting the same baseline as Current state', () => {
    // The opening paragraph quotes exactly one live baseline among dozens of
    // historical counts, and it drifts quietly: it is prose, not a table, so the
    // column and version checks above cannot see it. Read each side from its own
    // section and anchor on the full sentence shape, so a historical number can
    // never be mistaken for the current one.
    const lines = readFileSync('handoff.md', 'utf8').split('\n');
    const headerLine = lines.find(line => line.startsWith('> Zeus 处于')) ?? '';
    const stateStart = lines.findIndex(line => line.startsWith('## Current state'));
    const stateEnd = lines.findIndex(line => line.startsWith('## New inputs'));
    const currentState = lines.slice(stateStart, stateEnd).join('\n');

    const grab = (text: string, re: RegExp, what: string): RegExpMatchArray => {
      const found = text.match(re);
      // Positive control: a rewrite that breaks the anchor must fail loudly.
      // Finding no numbers and reporting no drift is the failure this guard
      // exists to prevent; it must not be the failure it commits.
      expect(found, `${what} - anchor not found, so this check would pass by finding nothing`).not.toBeNull();
      if (!found) throw new Error(what);
      return found;
    };

    const header = grab(
      headerLine,
      /\*\*(\d+) 项测试绿 \/ (\d+) 个测试文件，typecheck 过，核心链路真机冒烟 (\d+)\/(\d+)\*\*/,
      'the header paragraph no longer carries its inline baseline sentence'
    );
    const baseline = grab(
      currentState,
      /全量 \*\*(\d+) 测试 \/ (\d+) 文件 \/ (\d+) 失败\*\*/,
      'Current state no longer carries its baseline line'
    );
    const smoke = grab(
      currentState,
      /核心链路真机冒烟 `npm run smoke:core` (\d+)\/(\d+)/,
      'Current state no longer carries its smoke baseline'
    );

    const pairs: [string, string, string][] = [
      ['tests', header[1]!, baseline[1]!],
      ['files', header[2]!, baseline[2]!],
      ['smoke passed', header[3]!, smoke[1]!],
      ['smoke total', header[4]!, smoke[2]!],
    ];
    const drift = pairs
      .filter(([, quoted, current]) => quoted !== current)
      .map(([label, quoted, current]) => `${label}: header says ${quoted}, Current state says ${current}`);
    expect(drift, `the header paragraph and Current state disagree on the baseline:\n${drift.join('\n')}`).toEqual([]);
  });

  it('keeps README quoting the same baseline as Current state', () => {
    // Same class the guard above was written for, caught one file over: review
    // v0.19 found the checklist's live baseline two batches stale, and README was
    // two batches stale at the very same moment - its gate block is edited
    // directly (no copy step), so nothing but an assertion makes it agree.
    // Historical counts elsewhere in these files are untouched: each pattern is
    // the full sentence shape, not a bare number.
    const lines = readFileSync('handoff.md', 'utf8').split('\n');
    const stateStart = lines.findIndex(line => line.startsWith('## Current state'));
    const stateEnd = lines.findIndex(line => line.startsWith('## New inputs'));
    const currentState = lines.slice(stateStart, stateEnd).join('\n');
    const readme = readFileSync('README.md', 'utf8');

    const grab = (text: string, re: RegExp, what: string): RegExpMatchArray => {
      const found = text.match(re);
      expect(found, `${what} - anchor not found, so this check would pass by finding nothing`).not.toBeNull();
      if (!found) throw new Error(what);
      return found;
    };

    const baseline = grab(currentState, /全量 \*\*(\d+) 测试 \/ (\d+) 文件 \/ \d+ 失败\*\*/, 'Current state baseline counts');
    const smoke = grab(currentState, /核心链路真机冒烟 `npm run smoke:core` (\d+)\/(\d+)/, 'Current state smoke baseline');

    const gateTests = grab(readme, /vitest：(\d+) 项 \/ (\d+) 个测试文件/, 'README gate block test counts');
    const gateSmoke = grab(readme, /真 socket 跑完 (\d+) 步/, 'README gate block smoke steps');
    const evidence = grab(readme, /已验证到什么程度\*\*：(\d+) 项测试 \/ (\d+) 个测试文件/, 'README evidence sentence test counts');
    const evidenceSmoke = grab(readme, /重启恢复，(\d+) 步）/, 'README evidence sentence smoke steps');

    const pairs: [string, string, string][] = [
      ['gate tests', gateTests[1]!, baseline[1]!],
      ['gate files', gateTests[2]!, baseline[2]!],
      ['gate smoke steps', gateSmoke[1]!, smoke[2]!],
      ['evidence tests', evidence[1]!, baseline[1]!],
      ['evidence files', evidence[2]!, baseline[2]!],
      ['evidence smoke steps', evidenceSmoke[1]!, smoke[2]!],
    ];
    const drift = pairs
      .filter(([, quoted, current]) => quoted !== current)
      .map(([label, quoted, current]) => `${label}: README says ${quoted}, Current state says ${current}`);
    expect(drift, `README's live baseline disagrees with Current state:\n${drift.join('\n')}`).toEqual([]);
  });

  it('keeps the code-index test count equal to the Current state baseline', () => {
    // The handoff index line for `tests/` quotes a bare test count and file
    // count. It drifted (read 789 while the suite ran 790) and no gate saw it:
    // the index-version check only reads rows that name a document version, and
    // the header/README checks anchor their own sentences. Same class as the two
    // guards above, one more surface over.
    const lines = readFileSync('handoff.md', 'utf8').split('\n');
    const stateStart = lines.findIndex(line => line.startsWith('## Current state'));
    const stateEnd = lines.findIndex(line => line.startsWith('## New inputs'));
    const currentState = lines.slice(stateStart, stateEnd).join('\n');
    const codeRow = lines.find(line => line.startsWith('* 代码：')) ?? '';

    const grab = (text: string, re: RegExp, what: string): RegExpMatchArray => {
      const found = text.match(re);
      expect(found, `${what} - anchor not found, so this check would pass by finding nothing`).not.toBeNull();
      if (!found) throw new Error(what);
      return found;
    };

    const index = grab(
      codeRow,
      /`tests\/`（\*\*(\d+) 项，(\d+) 个测试文件\*\*/,
      'the code-index row no longer carries its tests/ count'
    );
    const baseline = grab(
      currentState,
      /全量 \*\*(\d+) 测试 \/ (\d+) 文件 \/ \d+ 失败\*\*/,
      'Current state no longer carries its baseline line'
    );

    const pairs: [string, string, string][] = [
      ['tests', index[1]!, baseline[1]!],
      ['files', index[2]!, baseline[2]!],
    ];
    const drift = pairs
      .filter(([, quoted, current]) => quoted !== current)
      .map(([label, quoted, current]) => `${label}: code index says ${quoted}, Current state says ${current}`);
    expect(drift, `the code-index row and Current state disagree on the baseline:\n${drift.join('\n')}`).toEqual([]);
  });

  it('keeps narrative metaphors out of the current external-facing surfaces', () => {
    // deferred #32: the 2026-09-25 terminology policy is "professional terms
    // only" on external-facing prose, but each sweep was a manual grep whose
    // population nobody could reproduce. This guard fixes the four current
    // surfaces (deferred #32's agreed boundary): root README, the docs map,
    // the pre-launch checklist, the PRD's current requirement rows, and the
    // product portrait's current sections. handoff.md and design-*.md stay
    // internal surfaces and are deliberately not scanned; change-log rows and
    // evolution logs are excluded per the document-status convention.
    const banned = ['封臣', '效忠', '战报', '藏宝图', '宝藏', '封神榜', '驾驶员', '拍板', '避风港', '审计脊', '立国三纲', '交回'];
    const findings: string[] = [];
    const scan = (file: string, text: string) => {
      banned.forEach(word => {
        text.split('\n').forEach((line, index) => {
          if (line.includes(word)) findings.push(`${file}:${index + 1} 「${word}」  ${line.slice(0, 60)}`);
        });
      });
    };

    const fullSurface = ['README.md', 'docs/README.md', 'docs/pre-launch-checklist.md'];
    fullSurface.forEach(file => scan(file, readFileSync(file, 'utf8')));

    // PRD: current requirement rows only. Evolution-log rows are history.
    readFileSync('docs/prd.md', 'utf8')
      .split('\n')
      .filter(line => /^\| E[\d.]+ \| .* \| P\d \|/.test(line))
      .join('\n')
      .split('\n')
      .forEach((line, i) => scan(`docs/prd.md(E-row ${i + 1})`, line));

    // Product portrait: everything before the evolution log is current prose.
    const portrait = readFileSync('docs/product-portrait.md', 'utf8');
    const changelogAt = portrait.search(/^## 演进日志/m);
    expect(changelogAt, 'product portrait must carry its 演进日志 anchor').toBeGreaterThan(0);
    scan('docs/product-portrait.md', portrait.slice(0, changelogAt));

    // Positive control: a checker whose word list or scan silently matched
    // nothing would keep passing as prose drifts back to metaphors.
    const dirty = ['封臣 注册', 'H2 驾驶员入口', '待拍板'].join('\n');
    const caught: string[] = [];
    banned.forEach(word => dirty.split('\n').forEach(line => { if (line.includes(word)) caught.push(word); }));
    expect(caught).toEqual(['封臣', '驾驶员', '拍板']);

    expect(findings, `current external-facing prose still uses narrative metaphors (deferred #32):\n${findings.join('\n')}`).toEqual([]);
  });
});
