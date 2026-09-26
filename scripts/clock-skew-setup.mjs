// Wall-clock dependency gate (deferred #24).
//
// Loaded as a vitest setup file ONLY by the `clock-skew` CI job. It shifts the
// JavaScript clock forward so that every `new Date()` / `Date.now()` the test
// code observes lands ~2 years in the future. If any test or production path
// silently depends on the real wall clock (a pinned past timestamp, a TTL check
// that should have expired, a "recent" assertion), it goes red here instead of
// "someday, on its own" — which is the whole point of the gate.
//
// Why a JS-level shift and not `sudo date -s` on the runner: GitHub-hosted
// runners do not grant CAP_SYS_TIME, and moving the OS clock would also break
// TLS to the npm registry during install. The wall-clock risk in this codebase
// is entirely in JS (every production `new Date()` sits behind an injectable
// `now`), so shifting the JS clock is the faithful, privilege-free proxy.
//
// Override the offset with ZEUS_CLOCK_SKEW_DAYS (integer days) if needed.
const SkewDays = Number(process.env.ZEUS_CLOCK_SKEW_DAYS ?? '730');
const OFFSET_MS = SkewDays * 24 * 60 * 60 * 1000;

const RealDate = Date;

class SkewedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) {
      super(RealDate.now() + OFFSET_MS);
    } else {
      // @ts-ignore - spread a constructor argument list
      super(...args);
    }
  }
  static now() {
    return RealDate.now() + OFFSET_MS;
  }
}

globalThis.Date = SkewedDate;
