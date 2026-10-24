/**
 * User-facing notifications for the caller-owned watch daemon (design-self-host
 * §3.2 / design-personal-agent-host §6 P1-4).
 *
 * The kernel deliberately holds no timer and never pings a user itself; when a
 * watch fires, the caller-owned `scripts/run-watch-tick.mjs` loop decides what
 * to do about it. This module is that loop's "tell the human" step: pick the
 * best available desktop-notification channel, build a short message from the
 * fired watch ids, and hand it to an injected exec (so tests never actually pop
 * a notification).
 *
 * No top-level side effects: importing this file does not shell out. The
 * channel probe and the notification itself are explicit async calls.
 */
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Mirrors the TickReport shape POST /api/watch-tick returns. */
export type TickReport = {
  evaluated: number;
  fired: string[];
  unavailable: string[];
  autoDisabled: string[];
};

export type NotifyChannel = 'osascript' | 'terminal-notifier';

export type NotifyResult = {
  delivered: boolean;
  channel: NotifyChannel | 'log';
  title: string;
  body: string;
};

export type NotifyDeps = {
  /** Run a command to completion. Injected in tests; defaults to node:child_process execFile. */
  execFile?: (cmd: string, args: string[]) => Promise<void>;
  /** Resolve a command on PATH, or null when absent. Default uses `which`. */
  which?: (name: string) => string | null;
  /** Fallback log line when no channel is available. */
  log?: (line: string) => void;
};

/** Double-quote escape for a shell-quoted osascript string. */
function appleString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds the notification for a tick report. Returns null when nothing fired —
 * an empty tick is healthy and must not nag the operator.
 */
export function buildNotification(report: TickReport): { title: string; body: string } | null {
  if (!report.fired || report.fired.length === 0) return null;
  return {
    title: `Zeus watch fired (${report.fired.length})`,
    body: report.fired.join(', '),
  };
}

/** Default `which`: ask the shell, since terminal-notifier may live under a homebrew prefix. */
function defaultWhich(name: string): string | null {
  // osascript ships at /usr/bin/osascript on every macOS; check it directly so a
  // stripped PATH (the cron/systemd case) still finds it.
  if (name === 'osascript' && existsSync('/usr/bin/osascript')) return '/usr/bin/osascript';
  try {
    const result = execFileSync('which', [name]);
    return result ? result.toString().trim() : null;
  } catch {
    return null;
  }
}

/**
 * Pick the desktop channel. macOS osascript first (zero install), then
 * terminal-notifier when the operator installed it; null when neither exists.
 */
export async function selectChannel(deps: NotifyDeps = {}): Promise<NotifyChannel | null> {
  const which = deps.which ?? defaultWhich;
  if (which('osascript')) return 'osascript';
  if (which('terminal-notifier')) return 'terminal-notifier';
  return null;
}

/** Default execFile promise wrapper. */
function defaultExecFile(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000 }, error => (error ? reject(error) : resolve()));
  });
}

/**
 * Notify the operator that watches fired. Falls back to a log line when no
 * desktop channel exists, and never throws — a failed notification must not
 * kill the watch loop.
 */
export async function notify(report: TickReport, deps: NotifyDeps = {}): Promise<NotifyResult> {
  const built = buildNotification(report);
  if (!built) return { delivered: false, channel: 'log', title: '', body: '' };
  const exec = deps.execFile ?? defaultExecFile;
  const log = deps.log ?? (line => console.log(line));

  let channel: NotifyChannel | null;
  try {
    channel = await selectChannel(deps);
  } catch (error) {
    log(`watch fired [${report.fired.join(',')}] but channel probe failed: ${(error as Error).message}`);
    return { delivered: false, channel: 'log', title: built.title, body: built.body };
  }
  if (!channel) {
    log(`watch fired [${report.fired.join(',')}] (no notification channel installed; logging only)`);
    return { delivered: false, channel: 'log', title: built.title, body: built.body };
  }
  try {
    if (channel === 'osascript') {
      await exec('osascript', ['-e', `display notification "${appleString(built.body)}" with title "${appleString(built.title)}"`]);
    } else {
      await exec('terminal-notifier', ['-title', built.title, '-message', built.body]);
    }
  } catch (error) {
    log(`watch fired [${report.fired.join(',')}] but ${channel} failed: ${(error as Error).message}`);
    return { delivered: false, channel: 'log', title: built.title, body: built.body };
  }
  return { delivered: true, channel, title: built.title, body: built.body };
}
