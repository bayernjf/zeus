#!/usr/bin/env node
// @ts-check
/**
 * 评审镜像层四件套的脚本化复刻（A3，2026-10-19）。
 *
 * 评审（review-mvp-2026-09.md §F）每轮手工重拍的四项容器级证据，本脚本一次
 * 跑完并逐项判定：
 *   1. HEALTHCHECK：容器 healthy（轮询 docker inspect，默认 90s 超时）
 *   2. 密钥权限：/data/rsk.key 0600 且属主 node（容器内 stat）
 *   3. SIGTERM 落盘：docker stop（SIGTERM 直达 PID 1）后 /data/kernel-state.json
 *      存在、0600、非空
 *   4. 重启恢复：docker start 后恢复日志（kernel-state-restored / restored N vassals）
 *   5. 名册验签：GET /api/roster/keys 拿 spkiPem，宿主 verify-roster.mjs 对
 *      /api/roster 信封验真（签名链可独立复核，无需信任发布端）——重启后再验一次
 *
 * 步骤与 docs/deployment.md §4.4 一致：密钥由镜像内 gen-rsk-key.mjs 写入挂载的
 * /data（容器内 node 用户创建，owner node:node 0600——避免宿主 uid 带入导致
 * USER node 读不到密钥拒启）。
 *
 * Usage:
 *   node scripts/verify-image.mjs [--tag zeus:verify] [--build] [--keep]
 *       [--data-dir /tmp/zeus-verify-data] [--port 18787]
 *
 * Exit: 0 全部通过；1 任一项失败；2 用法或前置错误（docker 不可用等）。
 * 零依赖（node:child_process / node:fs / node:path / node:url）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
/** @param {string} flag @param {string} fallback */
const argString = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const tag = argString('--tag', 'zeus:verify');
const dataDir = argString('--data-dir', '/tmp/zeus-verify-data');
const port = Number(argString('--port', '18787'));
const build = args.includes('--build');
const keep = args.includes('--keep');
const container = 'zeus-verify-img';
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** @param {string[]} cmd @param {import('node:child_process').SpawnSyncOptions} [opts] */
function run(cmd, opts = {}) {
  return spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8',
    timeout: opts.timeout ?? 180_000,
    ...opts,
  });
}

/** 轮询容器 HEALTHCHECK 状态；超时返回 null */
function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = run(['docker', 'inspect', '-f', '{{.State.Health.Status}}', container], { timeout: 20_000 });
    const status = (out.stdout || '').trim();
    if (status === 'healthy') return true;
    if (status === 'unhealthy') return false;
    if (Date.now() >= deadline) return false;
    spawnSync('sleep', ['3']);
  }
}

async function main() {
  console.log(`verify-image: ${tag} (data-dir ${dataDir}, port ${port})`);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    console.error(`error: bad --port ${argString('--port', '')}`);
    process.exit(2);
  }

  // 前置：宿主 dist 需存在——名册验签在宿主侧跑 verify-roster.mjs，它
  // import dist/registry/signing.js；CI 工作树没有编译产物（build 只在
  // Docker builder 阶段做），缺了就宿主侧构建一次。
  if (!existsSync(path.join(repoRoot, 'dist/registry/signing.js'))) {
    console.log('verify-image: host dist missing, building once (npm run build)');
    const b = run(['npm', 'run', 'build'], { cwd: repoRoot, timeout: 180_000 });
    if (b.status !== 0) {
      console.error(b.stdout + b.stderr);
      console.error('error: host build (npm run build) failed, needed for roster verification');
      process.exit(1);
    }
  }

  // 前置：docker 可用
  const dockerProbe = run(['docker', 'info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
  if (dockerProbe.status !== 0) {
    console.error('error: docker is not available (docker info failed)');
    process.exit(2);
  }

  // 0. 可选 build
  if (build) {
    console.log('building image...');
    const b = run(['docker', 'build', '-t', tag, '.']);
    if (b.status !== 0) {
      console.error(b.stdout + b.stderr);
      console.error('error: docker build failed');
      process.exit(1);
    }
  }

  // 清理上次运行
  run(['docker', 'rm', '-f', container], { timeout: 30_000 });
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  // 1. 生成 RSK 密钥（容器内 node 用户写挂载目录 → owner node:node 0600）
  //    注意：bind mount 会用宿主目录属主遮蔽镜像内 `chown node:node /data`，
  //    在 Linux CI 上宿主目录属主非 uid 1000 时 node 用户写卷根会 EACCES
  //    （macOS Docker Desktop 权限宽松所以本机不触发）。先以 root 把卷根
  //    chown 给 node:node，再以 node 用户生成密钥。
  const own = run(['docker', 'run', '--rm', '-v', `${dataDir}:/data`, '--user', 'root', tag, 'chown', 'node:node', '/data'], { timeout: 30_000 });
  if (own.status !== 0) {
    console.error(own.stdout + own.stderr);
    console.error('error: chown /data inside the image failed');
    process.exit(1);
  }
  const gen = run(['docker', 'run', '--rm', '-v', `${dataDir}:/data`, tag, 'node', 'scripts/gen-rsk-key.mjs', '/data/rsk.key'], { timeout: 60_000 });
  if (gen.status !== 0) {
    console.error(gen.stdout + gen.stderr);
    console.error('error: gen-rsk-key inside the image failed');
    process.exit(1);
  }
  check('rsk key generated inside the image', existsSync(path.join(dataDir, 'rsk.key')));

  // 2. 启动容器
  const start = run(['docker', 'run', '-d', '--name', container, '-p', `${port}:8787`, '-v', `${dataDir}:/data`, '-e', 'ZEUS_RSK_KEY_FILE=/data/rsk.key', '-e', 'ZEUS_RSK_KEY_ID=zeus-verify', tag], { timeout: 60_000 });
  if (start.status !== 0) {
    console.error(start.stdout + start.stderr);
    console.error('error: docker run failed');
    process.exit(1);
  }

  // 3. healthy
  console.log('waiting for HEALTHCHECK...');
  check('container healthy', waitHealthy(90_000));

  // 4. 密钥权限：0600 且 node 属主（容器内 stat）
  const st = run(['docker', 'exec', container, 'stat', '-c', '%a %U:%G', '/data/rsk.key'], { timeout: 30_000 });
  const perms = (st.stdout || '').trim();
  check('rsk.key 0600 node:node', perms === '600 node:node', perms || st.stderr);

  // 5. 名册验签（重启前）
  async function verifyRoster(label) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/roster/keys`);
      if (!res.ok) throw new Error(`GET /api/roster/keys -> ${res.status}`);
      const body = /** @type {any} */ (await res.json());
      const spki = body?.spkiPem ?? body?.keys?.[0]?.spkiPem;
      if (!spki) throw new Error('no spkiPem in /api/roster/keys response');
      // pem 放宿主 tmp 而非挂载卷：bind mount 卷根在 Linux CI 上被 chown 成
      // node(uid 1000)，宿主 runner 进程写卷内文件会 EACCES。
      const pemFile = path.join(os.tmpdir(), `zeus-verify-${process.pid}.pem`);
      writeFileSync(pemFile, spki);
      const vr = run(['node', path.join(repoRoot, 'scripts/verify-roster.mjs'), '--url', `http://127.0.0.1:${port}/api/roster/public`, '--key', pemFile], { timeout: 60_000 });
      const ok = vr.status === 0;
      check(label, ok, (vr.stderr || vr.stdout || '').trim().split('\n')[0]);
    } catch (error) {
      check(label, false, error instanceof Error ? error.message : String(error));
    }
  }
  await verifyRoster('roster verifies (pre-restart)');

  // 6. SIGTERM 落盘
  const stop = run(['docker', 'stop', '--time', '10', container], { timeout: 60_000 });
  check('SIGTERM stops the container', stop.status === 0);
  const stateFile = path.join(dataDir, 'kernel-state.json');
  const stateExists = existsSync(stateFile);
  check('kernel-state.json written on shutdown', stateExists);
  if (stateExists) {
    const mode = statSync(stateFile).mode & 0o777;
    check('kernel-state.json 0600', mode === 0o600, `mode ${mode.toString(8)}`);
    check('kernel-state.json non-empty', statSync(stateFile).size > 0);
  }

  // 7. 重启恢复
  const startAgain = run(['docker', 'start', container], { timeout: 60_000 });
  check('container restarts', startAgain.status === 0);
  if (startAgain.status === 0) {
    check('healthy after restart', waitHealthy(90_000));
    const logs = run(['docker', 'logs', container], { timeout: 30_000 });
    const logText = logs.stdout || logs.stderr || '';
    check('kernel state restored on boot', /kernel-state-restored/.test(logText), logText.slice(-400));
    await verifyRoster('roster verifies (post-restart)');
  }

  // 8. 清理
  if (!keep) {
    run(['docker', 'rm', '-f', container], { timeout: 30_000 });
    // 卷内文件属主 node（uid 1000），宿主进程删不动（Linux CI）：交给容器内
    // root 清空；再把卷根属主 chown 回宿主 uid:gid——Linux /tmp 带 sticky bit，
    // 目录属主非宿主进程时 rmdir 会 EPERM（macOS 无此语义所以本机不触发）。
    run(['docker', 'run', '--rm', '-v', `${dataDir}:/data`, '--user', 'root', tag, 'find', '/data', '-mindepth', '1', '-delete'], { timeout: 30_000 });
    run(['docker', 'run', '--rm', '-v', `${dataDir}:/data`, '--user', 'root', tag, 'chown', `${process.getuid()}:${process.getgid()}`, '/data'], { timeout: 30_000 });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(path.join(os.tmpdir(), `zeus-verify-${process.pid}.pem`), { force: true });
    console.log('cleaned up container and data dir');
  }

  if (failures > 0) {
    console.error(`\nverify-image: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nverify-image: all checks passed');
  process.exit(0);
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exit(1);
});
