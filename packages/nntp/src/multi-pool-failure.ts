import { NntpAuthError, NntpCapacityError, NntpProtocolError } from './errors.ts';
import type { NntpServerAttempt } from './errors.ts';
import type { NntpPool } from './pool.ts';

/**
 * Consecutive connection-level failures before a server leaves the rotation.
 *
 * Three, not one: a timeout on a single article is a bad moment, not a dead
 * provider. An auth failure bypasses this entirely -- it is deterministic.
 */
const DOWN_AFTER = 3;

/**
 * Mutable per-server state. Deliberately holds no credential -- see
 * multi-pool.ts's constructor for where that is enforced.
 */
export interface ServerEntry {
  readonly name: string;
  readonly spillover: boolean;
  readonly pool: NntpPool;
  state: 'ready' | 'down';
  downReason: Error | null;
  consecutiveFailures: number;
}

/**
 * State threaded through one `#run` walk, bundled so it can be passed to
 * {@link rule} instead of living as several loop locals in multi-pool.ts.
 */
export interface WalkState {
  requireSpillover: boolean;
  firstCapacityError: NntpCapacityError | null;
  /** Every server actually tried this walk, in order, with why it failed. */
  attempts: NntpServerAttempt[];
}

/**
 * What `#run` should do about one candidate's failure. {@link rule} decides;
 * `#run` acts. Splitting it this way is what lets this module stay ignorant
 * of `#fatal` and of any pool -- the class is the only thing with authority
 * to fail the whole `NntpMultiPool`, not just this one walk.
 */
export type FailureRuling =
  { readonly kind: 'skip' } | { readonly kind: 'fatal'; readonly error: NntpAuthError };

function markDown(entry: ServerEntry, reason: Error): void {
  entry.state = 'down';
  entry.downReason = reason;
}

/** Timeout, connection loss, or an unexpected status: transient until it is not. */
function recordConnectionFailure(entry: ServerEntry, reason: Error): void {
  entry.consecutiveFailures += 1;
  if (entry.consecutiveFailures >= DOWN_AFTER) {
    markDown(entry, reason);
  }
}

/**
 * Classify one candidate's failure, update the walk's shared state, and
 * decide what `#run` should do about it.
 *
 * Records the attempt before classifying, and unconditionally -- including
 * the 430 branch -- so that `walk.attempts` reflects every server actually
 * tried this walk, not just the ones that failed for a reason worth acting
 * on. That is what lets `#run` tell "every server said 430" from "we could
 * not find out" once the walk ends, and what stops an error type this
 * function has never seen before (a bug, not a protocol response) from
 * being silently folded into that same fallback. The fatal primary-auth
 * ruling below also records first, but not for that reason: `#run` throws
 * immediately on a `fatal` ruling and never reads `walk.attempts` on that
 * path. It records first anyway, purely so this stays one push instead of
 * several call sites each doing their own.
 *
 * Mutates `entry` -- incrementing `consecutiveFailures`, setting
 * `state`/`downReason` -- which is fine because `entry` is passed in rather
 * than reached for through `this`. This function never touches a pool, and
 * never touches `#fatal`; a `fatal` ruling only reports the auth error back
 * to `#run`, which is the one place with the authority to set it and throw.
 */
export function rule(
  entry: ServerEntry,
  error: unknown,
  walk: WalkState,
  isPrimary: boolean,
): FailureRuling {
  const reason = error instanceof Error ? error : new Error(String(error));
  walk.attempts.push({ server: entry.name, reason });

  if (reason instanceof NntpProtocolError && reason.code === 430) {
    // A gap, not a fault: this server does not have this article, which
    // says nothing about its health.
    return { kind: 'skip' };
  }
  if (reason instanceof NntpCapacityError) {
    // Only reaches here when the pool could open no connection at all; a
    // partial cap is absorbed by the pool shrinking and queueing.
    walk.requireSpillover = true;
    if (walk.firstCapacityError === null) {
      walk.firstCapacityError = reason;
    }
    return { kind: 'skip' };
  }
  if (reason instanceof NntpAuthError) {
    if (isPrimary) {
      // The server you always use must be right. Failing over would run
      // the whole job on a backup because of a typo.
      return { kind: 'fatal', error: reason };
    }
    // A backup that cannot log in is treated like one that is unreachable,
    // so a stale token does not abort a nearly-finished download. One
    // strike, because the outcome is deterministic.
    markDown(entry, reason);
    return { kind: 'skip' };
  }
  recordConnectionFailure(entry, reason);
  return { kind: 'skip' };
}
