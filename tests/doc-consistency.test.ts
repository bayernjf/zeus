import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

type DocLine = { at: number; text: string };

const FENCE = /^(\s*)(`{3,})(.*)$/;

/** Lines a reader actually sees: block content is dropped, fence markers kept.
 *  CommonMark rule applied - a closing fence cannot carry an info string, so a
 *  ```bash line inside an open block is content, not a new block. */
function visibleLines(file: string): DocLine[] {
  const out: DocLine[] = [];
  let open: number | null = null;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      const fence = text.match(FENCE);
      if (fence) {
        out.push({ at: index + 1, text });
        const len = fence[2]!.length;
        if (open === null) open = len;
        else if (fence[3]!.trim() === '' && len >= open) open = null;
        return;
      }
      if (open === null) out.push({ at: index + 1, text });
    });
  return out;
}

/** The paste defect: one document carrying two copies of itself. Both signals are
 *  mechanical - the file's own title reappearing later, and duplicated long lines.
 *  Threshold 3 rather than 1 because a repeated table row is legitimate prose:
 *  the current maximum elsewhere in the repo is 2 (review-mvp's verification
 *  matrix row appears in two round tables), while the copy this guard exists for
 *  (audit B-39, docs/mcp-integration.md at 532 lines) measured 30. */
function duplicateBodyFindings(title: string, fullText: string, lines: DocLine[]): string[] {
  const findings: string[] = [];
  if (/^# \S/.test(title)) {
    const rest = fullText.slice(fullText.indexOf('\n') + 1);
    const again = rest.split(title).length - 1;
    if (again > 0) findings.push(`标题「${title}」在正文中又出现 ${again} 次`);
  }
  const first = new Map<string, number>();
  const repeats: string[] = [];
  for (const { at, text } of lines) {
    if (text.length < 120) continue;
    const key = text.slice(0, 400);
    const seen = first.get(key);
    if (seen === undefined) first.set(key, at);
    else repeats.push(`line ${at}（与 line ${seen} 相同）`);
  }
  if (repeats.length >= 3) findings.push(`重复长行 ${repeats.length} 处：${repeats.slice(0, 3).join('、')}`);
  return findings;
}

/** An info-string fence that lands inside an open block can only mean the open
 *  block lost its closer - and everything between then renders as code. */
function fenceFindings(lines: string[]): string[] {
  const findings: string[] = [];
  let open: { len: number; at: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const fence = lines[index]!.match(FENCE);
    if (!fence) continue;
    const len = fence[2]!.length;
    if (open === null) {
      open = { len, at: index + 1 };
      continue;
    }
    if (fence[3]!.trim() === '' && len >= open.len) {
      open = null;
      continue;
    }
    findings.push(`line ${index + 1} 是一块新开的围栏，但它落在 line ${open.at} 打开的代码块里（那块缺闭合）`);
  }
  if (open) findings.push(`line ${open.at} 打开的围栏到文件结尾都没闭合`);
  return findings;
}

/** An anchor citation carries a verification word: `src/path.ts:12-20 #symbol`.
 *  The word must appear inside the cited range, which is what makes a drifted
 *  line number fail loudly instead of reading as unrelated source. */
const ANCHOR = /`((?:src|tests)\/[\w\-/.]+\.(?:ts|js)):(\d+)(?:-(\d+))? #([\w.]+)`/g;

function anchorFindings(text: string, read: (file: string) => string[]): string[] {
  const findings: string[] = [];
  for (const match of text.matchAll(ANCHOR)) {
    const [, file, fromRaw, toRaw, token] = match;
    const from = Number(fromRaw);
    const to = Number(toRaw ?? fromRaw);
    let lines: string[];
    try {
      lines = read(file!);
    } catch {
      findings.push(`${file}:${from}-${to} 的锚点文件不存在`);
      continue;
    }
    if (to > lines.length) {
      findings.push(`${file}:${from}-${to} 超出文件长度 ${lines.length}`);
      continue;
    }
    if (!lines.slice(from - 1, to).join('\n').includes(token!)) {
      findings.push(`${file}:${from}-${to} 的区间里没有校验词 #${token}`);
    }
  }
  // The two shapes that would let the check pass by covering nothing: an anchor
  // with no verification word, and a `:NN` continuation whose path lives in an
  // earlier citation, so the regex above never sees it.
  for (const bare of text.matchAll(/`(?:src|tests)\/[\w\-/.]+\.(?:ts|js):\d+(?:-\d+)?`/g)) {
    findings.push(`锚点缺校验词：${bare[0]}`);
  }
  if (/[、，]`:\d|`:\d[\d-]*`/.test(text)) findings.push('有锚点写成 `:NN` 续写形式（路径在上一条里），断言接不到它');
  return findings;
}

/** Code citations across the whole document set: a source file (full path, or the
 *  `realm/store.ts:178-199` short form the ledgers favour), a line or range, and
 *  optionally the verification word that must appear inside that range. Documents
 *  listed in ANCHOR_CONTRACT_DOCS opted into the word for every citation they carry.
 *  Bare basenames (`registry.ts:210`) are out of scope on purpose: three files share
 *  that name, so resolving one means guessing - and guessing is what this gate exists
 *  to stop. They come back as a count so the exclusion cannot quietly become coverage. */
const CODE_CITATION =
  /`((?:[\w\-/.]+\/)?[\w\-/.]+\.(?:ts|tsx|js|mjs|cjs|json|html)):(\d+)(?:-(\d+))?(?: #([\w.]+))?`/g;

const SOURCE_ROOTS = ['src', 'tests', 'scripts', 'web'];

const ANCHOR_CONTRACT_DOCS = [
  'docs/mcp-integration.md',
  'docs/terminology.md',
  'docs/design-naming-migration.md',
  'docs/design-backpressure.md',
  'docs/feature-inventory.md',
  'docs/verify-jev-backend.md',
  // 2026-10-05: the two self-host documents were written under the contract from
  // their first draft, so opting them in costs nothing and stops the next edit
  // from quietly citing an anchor that resolves to nothing.
  'docs/design-self-host-loop.md',
  'docs/verify-self-host-pilot.md',
];

function sourcePaths(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sourcePaths(full) : /\.[mc]?[jt]sx?$|\.json$|\.html$/.test(entry.name) ? [full] : [];
  });
}

const ALL_SOURCES = SOURCE_ROOTS.flatMap(sourcePaths);

type CitationScan = { findings: string[]; resolved: number; tokened: number; bareName: number };

function citationFindings(file: string, text: string, read: (path: string) => string[]): CitationScan {
  const findings: string[] = [];
  const lineCount = new Map<string, number>();
  let resolved = 0;
  let tokened = 0;
  let bare = 0;
  let bareName = 0;
  const lengthOf = (target: string): number => {
    if (!lineCount.has(target)) lineCount.set(target, read(target).length);
    return lineCount.get(target)!;
  };
  for (const match of text.matchAll(CODE_CITATION)) {
    const [, written, fromRaw, toRaw, token] = match;
    const from = Number(fromRaw);
    const to = Number(toRaw ?? fromRaw);
    if (!written!.includes('/') && !existsSync(written!)) {
      bareName += 1;
      continue;
    }
    const targets = existsSync(written!) ? [written!] : ALL_SOURCES.filter(source => source.endsWith(`/${written}`));
    if (targets.length === 0) {
      findings.push(`${written}:${from}-${to} 解析不到文件`);
      continue;
    }
    if (targets.length > 1) {
      findings.push(`${written}:${from}-${to} 有 ${targets.length} 个候选文件，短写无法确定是哪一个`);
      continue;
    }
    const target = targets[0]!;
    resolved += 1;
    if (to > lengthOf(target)) {
      findings.push(`${target}:${from}-${to} 越界（文里写成 ${written}），文件只有 ${lengthOf(target)} 行`);
      continue;
    }
    if (token === undefined) {
      bare += 1;
      continue;
    }
    tokened += 1;
    if (!read(target).slice(from - 1, to).join('\n').includes(token)) {
      findings.push(`${target}:${from}-${to} 的区间里没有校验词 #${token}`);
    }
  }
  // An opted-in document that half-converts is worse than one that never started:
  // the covered citations look like the whole set.
  if (ANCHOR_CONTRACT_DOCS.includes(file)) {
    if (tokened > 0 && bare > 0) findings.push(`本文有 ${tokened} 条带校验词、${bare} 条没带——契约只守了一半`);
    if (/[、，]`:\d|`:\d[\d-]*`/.test(text)) findings.push('仍有 `:NN` 续写形式（路径在上一条里），断言接不到它');
    if (bareName > 0) findings.push(`有 ${bareName} 条只写了文件名（如 registry.ts:210），同名文件不止一个，短写无法确定是哪一个`);
  }
  return { findings, resolved, tokened, bareName };
}

/** Relative `.md` links, resolved against the linking file's own directory. */
function relativeMdLinks(lines: DocLine[]): { at: number; target: string }[] {
  const out: { at: number; target: string }[] = [];
  for (const { at, text } of lines) {
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      if (!target.split('#')[0]!.endsWith('.md')) continue;
      out.push({ at, target });
    }
  }
  return out;
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
    const evidenceSmoke = grab(readme, /撤销契约断流，(\d+) 步）/, 'README evidence sentence smoke steps');

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

  it('keeps the inventory route and export census equal to the code', () => {
    // The inventory's headline sizes drifted with nothing to notice it: it said
    // "75 routes (3 public + 72 bearer)" while 76 registrations existed (the
    // revocation-stickiness fix added POST /api/vassals/:name/reinstate after the
    // census was written), its own per-group table summed to 70, and "116 exports"
    // matched neither the export statements in src/index.ts nor the runtime
    // surface. Every review round re-counted this by hand; counting is mechanical,
    // so it happens here instead.
    const routes = [
      ...readFileSync('src/http/server.ts', 'utf8').matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g),
    ].map(match => match[2] ?? '');
    const publicPaths = new Set(['/healthz', '/api/roster/public', '/api/roster/keys']);
    const publicCount = routes.filter(path => publicPaths.has(path)).length;
    const bearerCount = routes.length - publicCount;

    const inventory = readFileSync('docs/feature-inventory.md', 'utf8');
    const headline = /HTTP 门面 \| Fastify 长驻进程，`npm start` \| \*\*(\d+) 条路由\*\*（(\d+) 公开 \+ (\d+) bearer）/.exec(inventory);
    expect(headline, 'inventory headline route census anchor not found').not.toBeNull();
    expect([headline?.[1], headline?.[2], headline?.[3]])
      .toEqual([String(routes.length), String(publicCount), String(bearerCount)]);

    // The group table describes the bearer face, so its cells must add up to it.
    const groupRows = inventory
      .split('\n')
      .filter(line => /^\| (名册与执行 Agent|意图与编排|监督台|指标与状态|组织编制|记忆|日记|技能与带教|连接器|数据域与跨域|决策后端) \| \d+ \|/.test(line));
    expect(groupRows.length, 'internal route group table anchor not found').toBeGreaterThan(9);
    const groupSum = groupRows.reduce((sum, line) => sum + Number(line.split('|')[2]?.trim() ?? 'NaN'), 0);
    expect(groupSum, `route groups sum to ${groupSum}, the bearer face has ${bearerCount}`).toBe(bearerCount);

    const exportStatements = readFileSync('src/index.ts', 'utf8').split('\n').filter(line => /^export\b/.test(line)).length;
    const exportClaim = /\*\*(\d+) 条 export 语句\*\*/.exec(inventory);
    expect(exportClaim, 'inventory export census anchor not found').not.toBeNull();
    expect(exportClaim?.[1]).toBe(String(exportStatements));
  });

  it('never lets one document carry a second copy of its own body', () => {
    // B-39: docs/mcp-integration.md sat in HEAD across four commits as two partial
    // copies of one document - 532 lines, 30 duplicated long lines, and one bullet
    // cut in half exactly at the paste point, its second half living only in the
    // other copy. None of the checks above could see it: each anchors on a shape a
    // duplicate preserves (a version claim, a column count, a bold marker). Both
    // signals here are the mechanical readouts of a paste - the file's own title
    // reappearing below line 1, and long lines repeating.
    const body = ['a'.repeat(130), 'b'.repeat(130), 'c'.repeat(130), 'd'.repeat(130)];
    const doubled = ['# Doc', ...body, '# Doc', ...body].join('\n');
    const doubledLines = doubled.split('\n').map((text, index) => ({ at: index + 1, text }));
    const caught = duplicateBodyFindings('# Doc', doubled, doubledLines);
    expect(caught, 'a doubled document body must report both signals').toEqual([
      '标题「# Doc」在正文中又出现 1 次',
      expect.stringContaining('重复长行 4 处'),
    ]);
    const halfCut = ['# Doc', '正文', `- 一个句子写到一半 # Doc`, ...body, ...body].join('\n');
    expect(duplicateBodyFindings('# Doc', halfCut, halfCut.split('\n').map((text, index) => ({ at: index + 1, text }))).length, 'a title glued mid-line still counts').toBeGreaterThan(0);
    expect(duplicateBodyFindings('# Doc', '# Doc\n正文', [{ at: 1, text: '# Doc' }, { at: 2, text: '正文' }])).toEqual([]);

    const offenders = DOC_FILES.flatMap(file => {
      const raw = readFileSync(file, 'utf8');
      return duplicateBodyFindings(raw.split('\n')[0] ?? '', raw, visibleLines(file)).map(finding => `${file}: ${finding}`);
    });
    expect(offenders, `a document body appears twice in these files:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('pairs every code fence, so no prose is silently rendered as code', () => {
    // Found while wiring the guard above: README's tui block (opened at line 84)
    // had no closer, so the next ```bash line could not open a block - it became
    // content, and the two prose paragraphs after it stayed inside the code block
    // to the end of the file. A fence-aware scan cannot tell this apart from a
    // balanced file unless the closer rule is CommonMark's, so it is written here
    // and asserted on both shapes.
    const broken = ['```bash', 'npm run tui', '# 可选：--token', '', '监督台命令（进入后）：见下', '```bash', 'npm start', '```'].join('\n').split('\n');
    const found = fenceFindings(broken);
    expect(found.length, 'a fence opened inside an unclosed block must be reported').toBe(1);
    expect(found[0]).toContain('缺闭合');
    expect(fenceFindings(['```bash', 'npm start', '```'].join('\n').split('\n'))).toEqual([]);
    expect(fenceFindings(['```bash', 'npm start'].join('\n').split('\n'))).toEqual([expect.stringContaining('到文件结尾都没闭合')]);

    const offenders = DOC_FILES.flatMap(file =>
      fenceFindings(readFileSync(file, 'utf8').split('\n')).map(finding => `${file}: ${finding}`)
    );
    expect(offenders, `code fences out of balance:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('resolves every relative markdown link to a file that exists', () => {
    // 356 relative .md links across the document set, and a link is the only
    // navigation a reader has in these files. The dead one this sweep found (and
    // fixed in Active work 121) was handoff.md pointing at (design-realm.md) from
    // the repository root while the file lives in docs/ - no other check reads
    // link targets, so the next one of these lands silently.
    const links = DOC_FILES.flatMap(file => relativeMdLinks(visibleLines(file)).map(link => ({ ...link, file })));
    expect(links.length, 'the link population collapsed, so this check would pass by finding nothing').toBeGreaterThan(250);
    // Positive control: the dead shape must fail resolution while its fixed form
    // passes, so an empty `dead` below cannot come from a resolver that always hits.
    expect(existsSync(resolve(dirname('handoff.md'), 'design-realm.md'))).toBe(false);
    expect(existsSync(resolve(dirname('handoff.md'), 'docs/design-realm.md'))).toBe(true);
    expect(existsSync(resolve(dirname('docs/design-realm.md'), 'mcp-integration.md'))).toBe(true);

    const dead = links.filter(({ file, target }) => !existsSync(resolve(dirname(file), target.split('#')[0]!)));
    expect(
      dead,
      `relative links that resolve to no file:\n${dead.map(link => `${link.file}:${link.at} -> ${link.target}`).join('\n')}`
    ).toEqual([]);
  });

  it('pins every code anchor to the lines it actually cites', () => {
    // B-41: 19 of docs/mcp-integration.md's 37 anchors pointed at unrelated
    // implementations (a sentence about the permission vocabulary landing on a
    // duplicate-id check, an HTTP error mapping landing on DAG assembly), and no
    // check could see it because nothing was comparing an anchor to its target.
    // Line numbers will still drift, so the contract is `path:lines #word` with
    // the word required inside the cited range: drift then fails loudly here
    // rather than in front of a reader who trusted the anchor.
    const read = (file: string) => readFileSync(file, 'utf8').split('\n');
    const cite = (body: string) => '`' + body + '`';

    // Controls first: each failure shape is reported, the clean one is not.
    expect(anchorFindings(cite('src/realm/mcp.ts:29-30 #SUPPORTED_PROTOCOL_VERSIONS'), read), 'a clean anchor must pass').toEqual([]);
    expect(anchorFindings(cite('src/realm/mcp.ts:29-30 #NOT_IN_RANGE'), read)).toEqual([expect.stringContaining('没有校验词')]);
    expect(anchorFindings(cite('src/realm/mcp.ts:29-99999 #SUPPORTED_PROTOCOL_VERSIONS'), read)).toEqual([expect.stringContaining('超出文件长度')]);
    expect(anchorFindings(cite('src/realm/nope.ts:1-2 #anything'), read)).toEqual([expect.stringContaining('锚点文件不存在')]);
    expect(anchorFindings(cite('src/realm/mcp.ts:33-40'), read)).toEqual([expect.stringContaining('锚点缺校验词')]);
    expect(anchorFindings('、' + cite(':149'), read)).toEqual([expect.stringContaining('续写形式')]);

    const doc = readFileSync('docs/mcp-integration.md', 'utf8');
    const anchored = (doc.match(new RegExp(ANCHOR.source, 'g')) ?? []).length;
    expect(anchored, 'the anchored-citation population collapsed, so this check would pass by finding nothing').toBeGreaterThan(30);
    const findings = anchorFindings(doc, read).map(finding => `docs/mcp-integration.md: ${finding}`);
    expect(findings, `anchors whose cited lines do not contain their verification word:\n${findings.join('\n')}`).toEqual([]);
  });

  it('resolves every code citation in the whole document set', () => {
    // B-42: the anchor case above only sees `path:lines #word`. The rest of the repo cites
    // code as plain `path:lines`, and the ledgers favour a short form (`realm/store.ts:178`);
    // a renamed or shortened file therefore keeps every earlier gate green while the reader
    // lands on nothing. This case resolves what it can across the whole document set, and
    // holds a document that adopted the verification-word contract to it throughout.
    const read = (file: string) => readFileSync(file, 'utf8').split('\n');
    const cite = (body: string) => '`' + body + '`';
    const scan = (file: string, text: string) => citationFindings(file, text, read);

    // Controls first, on the same code path the real run uses: each failure shape is
    // reported, and the clean ones - including the short form, which has to resolve for
    // real rather than merely look like a path - are not.
    expect(scan('docs/terminology.md', cite('src/realm/store.ts:199-224 #isInsideRoot')).findings, 'a clean citation must pass').toEqual([]);
    expect(scan('docs/terminology.md', cite('realm/store.ts:199-224')).findings, 'a resolvable short form must pass').toEqual([]);
    expect(scan('docs/terminology.md', cite('src/realm/gone.ts:12 #anything')).findings).toEqual([expect.stringContaining('解析不到文件')]);
    expect(scan('docs/terminology.md', cite('realm/storre.ts:199-224')).findings).toEqual([expect.stringContaining('解析不到文件')]);
    expect(scan('docs/terminology.md', cite('src/realm/store.ts:1-99999 #x')).findings).toEqual([expect.stringContaining('越界')]);
    expect(scan('docs/terminology.md', cite('src/realm/store.ts:199-224 #NoSuchWord')).findings).toEqual([expect.stringContaining('没有校验词')]);
    expect(scan('docs/terminology.md', [cite('src/realm/store.ts:199-224 #isInsideRoot'), cite('src/realm/store.ts:199-224')].join(' 与 ')).findings).toEqual([
      expect.stringContaining('契约只守了一半'),
    ]);
    expect(scan('docs/terminology.md', cite('src/realm/store.ts:199-224 #isInsideRoot') + '、' + cite(':91')).findings).toEqual([expect.stringContaining('续写形式')]);
    expect(scan('docs/terminology.md', cite('registry.ts:210')).findings).toEqual([expect.stringContaining('只写了文件名')]);
    // A ledger is held to resolving only, not to the all-or-nothing rules.
    expect(scan('handoff.md', cite('src/realm/store.ts:199-224')).findings).toEqual([]);
    expect(scan('handoff.md', cite('registry.ts:210')).findings, 'bare basenames stay out of scope in ledgers').toEqual([]);
    // Multi-dot basenames are the shape this case's first regex silently dropped: with
    // `[\w\-]+\.ts` a citation to `tests/x.test.ts:N` matched nothing, so five anchors
    // went unseen until the two patterns were diffed against each other. Pinned here so
    // the same class of miss cannot be reintroduced by editing the pattern again.
    expect(scan('docs/terminology.md', cite('tests/mcp-connectors.test.ts:261 #bounds')).findings, 'a dotted basename must be seen').toEqual([]);
    expect(scan('docs/terminology.md', cite('tests/mcp-connectors.test.ts:261 #NoSuchWord')).findings).toEqual([expect.stringContaining('没有校验词')]);
    expect(scan('docs/terminology.md', cite('tests/mcp-connectors.test.ts:99999')).findings).toEqual([expect.stringContaining('越界')]);

    let resolved = 0;
    let tokened = 0;
    let unscoped = 0;
    const findings: string[] = [];
    for (const doc of DOC_FILES) {
      const once = citationFindings(doc, readFileSync(doc, 'utf8'), read);
      resolved += once.resolved;
      tokened += once.tokened;
      unscoped += once.bareName;
      findings.push(...once.findings.map(finding => `${doc}: ${finding}`));
    }
    expect(resolved, 'the citation population collapsed, so this check would pass by finding nothing').toBeGreaterThan(250);
    expect(tokened, 'the verification-word population collapsed').toBeGreaterThan(70);
    // Ledgers still cite by bare basename (three files are named registry.ts). They are
    // counted, never guessed at, so that "0 findings" cannot be read as "all covered".
    expect(unscoped, 'bare-basename citations: excluded by design, counted so it stays visible').toBeGreaterThan(100);
    expect(findings, `code citations that do not resolve, or a half-adopted contract:\n${findings.join('\n')}`).toEqual([]);
  });

  it('keeps the checklist quoting the same baseline and the same deferred status as the ledgers', () => {
    // Two currency claims the version and README gates cannot see. (1) The checklist
    // says its own counts "是活基线，每批现测更新" - it had fallen to 1099/101 and
    // 1109/102 while Current state moved on, and a go/no-go decision reads that file.
    // (2) Rows D5/D6 still carried deferred #30 and #31 as 登记待做 two weeks after
    // deferred-items.md recorded both as 已销项: the only surface that says "before
    // launch, do this" was telling the operator to do work that is already done.
    const lines = readFileSync('handoff.md', 'utf8').split('\n');
    const stateStart = lines.findIndex(line => line.startsWith('## Current state'));
    const stateEnd = lines.findIndex(line => line.startsWith('## New inputs'));
    const currentState = lines.slice(stateStart, stateEnd).join('\n');
    const grab = (text: string, re: RegExp, what: string): RegExpMatchArray => {
      const found = text.match(re);
      expect(found, `${what} - anchor not found, so this check would pass by finding nothing`).not.toBeNull();
      if (!found) throw new Error(what);
      return found;
    };
    const baseline = grab(currentState, /全量 \*\*(\d+) 测试 \/ (\d+) 文件 \/ \d+ 失败\*\*/, 'Current state baseline counts');

    const checklistText = readFileSync('docs/pre-launch-checklist.md', 'utf8');
    const judgement = grab(checklistText, /全量 (\d+) 总量 \/ (\d+) 文件/, 'the checklist judgement line no longer carries its baseline counts');
    const gateList = grab(checklistText, /当前 \*\*(\d+) 总量 \/ (\d+) 文件\*\*/, 'the checklist gate list no longer carries its baseline counts');
    const pairs: [string, string, string][] = [
      ['judgement tests', judgement[1]!, baseline[1]!],
      ['judgement files', judgement[2]!, baseline[2]!],
      ['gate-list tests', gateList[1]!, baseline[1]!],
      ['gate-list files', gateList[2]!, baseline[2]!],
    ];
    const drift = pairs
      .filter(([, quoted, current]) => quoted !== current)
      .map(([label, quoted, current]) => `${label}: checklist says ${quoted}, Current state says ${current}`);

    // Deferred items recorded as closed must not read as outstanding here. Only the
    // item column is consulted, because that is where the row names its deferred id;
    // ids mentioned mid-sentence are cross-references to other items' status.
    const closed = new Set(
      readFileSync('docs/deferred-items.md', 'utf8')
        .split('\n')
        .filter(line => /^### #\d+/.test(line) && /已销项/.test(line))
        .map(line => /#(\d+)/.exec(line)![1]!)
    );
    expect(closed.size, 'the deferred ledger no longer marks any item 已销项, so this check would pass by finding nothing').toBeGreaterThan(20);
    const staleRows = checklistText
      .split('\n')
      .filter(line => /^\| [A-Z]-?\d+ \|/.test(line))
      .flatMap(line => {
        const cells = line.split('|').map(cell => cell.trim());
        const [id, item, status] = [cells[1]!, cells[2]!, cells[cells.length - 2] ?? ''];
        const refs = [...item.matchAll(/#(\d+)/g)].map(match => match[1]!);
        if (!refs.some(ref => closed.has(ref))) return [];
        if (!/待做|未修|未做|待验|尚未/.test(status)) return [];
        return [`${id} 引用已销项的 ${refs.filter(ref => closed.has(ref)).join('/')}，状态列仍写「${status.slice(0, 40)}」`];
      });

    // Positive control: the shape this guard exists for must be caught by the same
    // code, not assumed away by a row that no longer parses.
    const dirty = '| D9 | #30 某项已关闭的缺陷 | 出口标准 | 命令 | 登记待做；不阻塞 |';
    const dirtyCells = dirty.split('|').map(cell => cell.trim());
    const dirtyRefs = [...dirtyCells[2]!.matchAll(/#(\d+)/g)].map(m => m[1]!);
    expect(dirtyRefs).toEqual(['30']);
    expect(closed.has('30'), 'the control needs #30 to be a closed item').toBe(true);
    expect(/待做/.test(dirtyCells[dirtyCells.length - 2]!)).toBe(true);
    // and a closed item reported as fixed must not be flagged
    expect(/待做|未修|未做|待验|尚未/.test('| D8 | #30 已修复 | x | y | 已修复（2026-09-30） |'.split('|')[5]!.trim())).toBe(false);

    expect(drift, `the checklist's live baseline disagrees with Current state:\n${drift.join('\n')}`).toEqual([]);
    expect(staleRows, `checklist rows still asking for work the deferred ledger records as closed:\n${staleRows.join('\n')}`).toEqual([]);
  });

  it('indexes every document in the handoff project-documents section', () => {
    // AGENTS.md requires a handoff index line for every new document, and that
    // section calls itself the complete single source for the document inventory.
    // The rule was enforced by memory alone: a document nobody indexes is a
    // document nobody reads, and the inventory stops being complete the moment
    // one is added without a line.
    const lines = readFileSync('handoff.md', 'utf8').split('\n');
    const start = lines.findIndex(line => line.startsWith('## Project documents'));
    const end = lines.findIndex(line => line.startsWith('## Recent changes'));
    // Positive control: a rewrite that renames either heading must fail loudly
    // rather than leave the scan looking at an empty slice.
    expect(start, 'handoff no longer carries its Project documents heading').toBeGreaterThan(0);
    expect(end, 'handoff no longer carries its Recent changes heading').toBeGreaterThan(start);
    const section = lines.slice(start, end).join('\n');

    const documents = readdirSync('docs').filter(name => name.endsWith('.md'));
    expect(documents.length, 'the docs/ population collapsed, so this check would pass by finding nothing').toBeGreaterThan(15);
    const missing = documents.filter(name => !section.includes(`docs/${name}`));
    expect(missing, `documents with no index line in handoff's Project documents:\n${missing.join('\n')}`).toEqual([]);
  });

  it('keeps .env.example in sync with the ZEUS_* variables the serve-side code reads', () => {
    // Pre-launch checklist B4 asks for a line-by-line review of every ZEUS_*
    // variable ("readable, never silently ignored") before going live. That
    // review was manual, so it could only be correct on the day it was run:
    // add a serve-side env read and the template silently falls behind; list a
    // variable nobody reads and operators wire a dead knob. Both directions are
    // mechanical, so they are asserted here instead.
    //
    // Direct reads only: `env.ZEUS_X`, `process.env.ZEUS_X` and the bracket
    // forms `env['ZEUS_X']` / `process.env['ZEUS_X']`. A variable reached
    // through a *dynamic* name (env[someFlag]) is invisible to the scan and must
    // be claimed in DYNAMIC_NAME_VARS below, each entry pointing at the file
    // that proves the indirect read; evidence that disappears fails too.
    //
    // scripts/ is deliberately out of scope: .env.example is the deployment
    // template for the serve process and its client CLIs, while developer/CI
    // fixtures such as scripts/clock-skew-setup.mjs's ZEUS_CLOCK_SKEW_DAYS are
    // never part of a deployment.
    const srcFiles = readdirSync('src', { recursive: true })
      .filter(name => typeof name === 'string' && name.endsWith('.ts') && !name.endsWith('.d.ts'));
    expect(srcFiles.length, 'the src/ population collapsed, so this check would pass by finding nothing').toBeGreaterThan(50);
    const readByCode = new Set<string>();
    for (const file of srcFiles) {
      const text = readFileSync(resolve('src', file), 'utf8');
      for (const match of text.matchAll(/(?:process\.)?env\.ZEUS_([A-Z0-9_]+)/g)) readByCode.add(`ZEUS_${match[1]}`);
      for (const match of text.matchAll(/(?:process\.)?env\[['"]ZEUS_([A-Z0-9_]+)['"]\]/g)) readByCode.add(`ZEUS_${match[1]}`);
    }
    expect(readByCode.size, 'expected dozens of serve-side env reads; the regex stopped matching').toBeGreaterThan(30);

    const example = readFileSync('.env.example', 'utf8');
    const listedInTemplate = new Set([...example.matchAll(/ZEUS_[A-Z0-9_]+/g)].map(match => match[0]));
    expect(listedInTemplate.size, 'the env template collapsed, so this check would pass by finding nothing').toBeGreaterThan(20);

    // Code reads it -> the template must document it (commented-out entries count).
    const undocumented = [...readByCode].filter(name => !listedInTemplate.has(name));
    expect(undocumented, `serve-side env reads missing from .env.example:\n${undocumented.join('\n')}`).toEqual([]);

    // Template lists it -> code must read it, unless it is a claimed dynamic-name read.
    const DYNAMIC_NAME_VARS: Array<{ name: string; file: string; evidence: RegExp }> = [
      {
        // src/vault/cli.ts resolves the key via env[envName]; envName comes from
        // --passphrase-env and defaults to the constant the evidence pins.
        name: 'ZEUS_VAULT_PASSPHRASE',
        file: 'src/vault/cli.ts',
        evidence: /DEFAULT_PASSPHRASE_ENV = 'ZEUS_VAULT_PASSPHRASE'[\s\S]*env\[envName\]/,
      },
    ];
    const dynamicNames = new Set<string>();
    for (const claim of DYNAMIC_NAME_VARS) {
      const source = readFileSync(claim.file, 'utf8');
      expect(claim.evidence.test(source), `${claim.name} is whitelisted as a dynamic-name read, but ${claim.file} no longer carries the claimed indirection`).toBe(true);
      dynamicNames.add(claim.name);
    }
    const dead = [...listedInTemplate].filter(name => !readByCode.has(name) && !dynamicNames.has(name));
    expect(dead, `.env.example entries with no ZEUS_* read in code (claim an indirect read in DYNAMIC_NAME_VARS, or remove the dead knob):\n${dead.join('\n')}`).toEqual([]);
  });
});
