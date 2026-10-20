// #10 取证：P0 文件扫描检索在 2 万文件 Realm 上的行为（2026-10-19 一次性探针）
// 目的：对照 deferred #10 触发条件（单 Realm 文件数 > 2 万 或 P50 检索 > 500ms）
//   a) 默认 scanLimits（maxItems=5000）：确认截断行为与 skipped 记录
//   b) 调大 scanLimits（maxItems=25000）：连接全量扫描耗时 + 检索 P50/P95
// 不入库，取证数据由执行者记录进 deferred-items #10。
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FsRealmStore } from '../dist/realm/store.js';

const root = '/tmp/zeus-realm-probe';
const DIRS = 200;
const FILES_PER_DIR = 100; // 20000 files

async function seed() {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const tasks = [];
  for (let d = 0; d < DIRS; d++) {
    const dir = join(root, `dir-${String(d).padStart(4, '0')}`);
    await mkdir(dir, { recursive: true });
    for (let f = 0; f < FILES_PER_DIR; f++) {
      const i = d * FILES_PER_DIR + f;
      const body = `# note ${i}\nalpha-${i} beta common\nline two with filler text for size ${i} ${i * 7}\nunique-token-${i % 97}\n`;
      tasks.push(writeFile(join(dir, `note-${String(f).padStart(4, '0')}.md`), body));
    }
  }
  await Promise.all(tasks);
}

async function connectTimed(scanLimits) {
  const t0 = performance.now();
  const store = new FsRealmStore(scanLimits ? { scanLimits } : {});
  const manifest = await store.connect(root, 'personal');
  const connectMs = performance.now() - t0;
  return { store, manifest, connectMs };
}

async function probe(label, store, realmId, terms, runs = 10) {
  const times = [];
  let hits = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const res = await store.search(realmId, { text: terms[i % terms.length], limit: 50 });
    times.push(performance.now() - t0);
    hits = res.length;
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`  ${label}: runs=${runs} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms lastHits=${hits} min=${times[0].toFixed(1)} max=${times[times.length - 1].toFixed(1)}`);
  return { p50, p95 };
}

console.log('seeding 20000 files...');
const seedT0 = performance.now();
await seed();
console.log(`seeded in ${((performance.now() - seedT0) / 1000).toFixed(1)}s`);

// a) 默认配置
console.log('\n[a] default scanLimits (maxItems=5000):');
{
  const { store, manifest, connectMs } = await connectTimed(undefined);
  console.log(`  connect(scan): ${connectMs.toFixed(0)}ms, manifest items=${manifest.items}, skipped=${manifest.skipped?.length ?? 0}`);
  if (manifest.skipped?.length) console.log(`  skipped[0]: ${manifest.skipped[0].reason}`);
  await probe('search(common, all-hit)', store, manifest.realmId, ['common'], 10);
  await probe('search(sparse token)', store, manifest.realmId, ['alpha-12345', 'alpha-8888', 'alpha-1', 'alpha-19999', 'unique-token-3'], 10);
  const conn = store.connections()[0];
  console.log(`  connected realm: ${conn.realmId} ${conn.type}`);
}

// b) 调大 scanLimits 全量
console.log('\n[b] scanLimits maxItems=25000 (full 20000):');
{
  const { store, manifest, connectMs } = await connectTimed({ maxItems: 25000, maxTotalBytes: 256 * 1024 * 1024 });
  console.log(`  connect(scan): ${connectMs.toFixed(0)}ms, manifest items=${manifest.items}, skipped=${manifest.skipped?.length ?? 0}`);
  await probe('search(common, all-hit)', store, manifest.realmId, ['common'], 10);
  await probe('search(sparse)', store, manifest.realmId, ['alpha-12345', 'alpha-8888', 'alpha-1', 'alpha-19999', 'unique-token-3'], 10);
  await probe('search(multi-term)', store, manifest.realmId, ['beta filler', 'note line unique', 'alpha-9 common'], 10);
}

await rm(root, { recursive: true, force: true });
console.log('\nprobe done (realm dir cleaned)');
