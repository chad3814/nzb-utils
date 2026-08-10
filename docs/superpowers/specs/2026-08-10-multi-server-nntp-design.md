# Multiple NNTP servers in `@chad3814/nntp`

**Status:** designed 2026-08-10, not implemented. Targets 1.2.0.

## Why

A Usenet article that one provider has dropped is often still on another. This
repo already bet on that: `@chad3814/par2` is verification-only, and the stated
reason was that "a second provider fixes more real failures than repair would"
— measured against a real release whose recovery set protected two files, not
including the one article that had actually expired.

Nothing in the stack can act on that bet today. `NntpPool` takes one `endpoint`
and one `credentials`. This adds `NntpMultiPool`: an ordered list of servers,
tried in order, so a later one is reached only when an earlier one cannot
supply the article.

The purpose is **filling gaps**, not aggregating bandwidth. That distinction
decides several things below, and it matches how Usenet is bought: a primary
unlimited account, plus a metered block account that should only ever pay for
what the primary missed.

## Scope

In scope:

- `NntpMultiPool` in `@chad3814/nntp`, composing one `NntpPool` per server.
- An additive change to the `ArticleSource` seam so a caller can exclude a
  server it has already tried.
- A CRC-failure retry in `@chad3814/nzb`, which is the only layer that can see
  a `pcrc32` mismatch.
- An opt-in second server in `scripts/smoke.ts` (`NNTP2_*`).

Out of scope, deliberately, and left to a follow-on spec:

- `@chad3814/nzb-cli` configuration — a `servers: []` array, and what `--host`
  means when there are several. Real surface of its own; the library is usable
  and testable without it.

## Architecture

`NntpMultiPool` composes N `NntpPool` instances, one per server. Each pool keeps
its own credentials, its own connection cap (including the cap it learns from a
502), its own failure history, and its own idle/waiting state. The multi-pool
holds only ordering and policy. It manages no sockets.

Two alternatives were rejected:

- **Teaching `NntpPool` to take `endpoints: []`.** It would need a limit, a
  credential and an up/down state per endpoint — at which point it is N pools
  with worse boundaries.
- **A separate `@chad3814/nntp-multi` package.** Every server needs a
  credential, and hard rule 3 puts credentials in `@chad3814/nntp`. There is no
  boundary to draw.

### API

```ts
export interface NntpServerOptions extends NntpPoolOptions {
  /** Stable name for failure reports and exclusions. Defaults to the host. */
  readonly name?: string;
  /**
   * May this server take work an earlier one could have served, when that one
   * is at its connection cap? Default false: a metered block account should
   * pay for gaps, not for overflow.
   */
  readonly spillover?: boolean;
}

export interface NntpMultiPoolOptions {
  /** Tried in order. The first is the primary. */
  readonly servers: readonly NntpServerOptions[];
}

export interface ArticleFetchOptions {
  /** Server names already tried for this article. */
  readonly exclude?: readonly string[];
}

export class NntpMultiPool {
  constructor(options: NntpMultiPoolOptions);
  body(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse>;
  head(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse>;
  article(messageId: string, options?: ArticleFetchOptions): Promise<NntpArticleResponse>;
  stat(messageId: string, options?: ArticleFetchOptions): Promise<NntpResponse>;
  statAll(messageId: string): Promise<readonly NntpServerStat[]>;
  get servers(): readonly NntpServerStatus[];
  destroy(): void;
}
```

`NntpServerOptions extends NntpPoolOptions`, so a server is configured exactly
as a pool is today. `NntpPool` itself is unchanged apart from setting `server`
on its responses.

### Response attribution

`server` goes on `NntpResponse`, which `NntpArticleResponse` extends, so one
addition covers every method:

```ts
export interface NntpResponse {
  readonly code: number;
  readonly message: string;
  /** Which server answered. Set by NntpPool as well, to its own host. */
  readonly server?: string;
}
```

`NntpPool` setting it too means a single pool and a multi-pool report
identically, and the retry path in `@chad3814/nzb` does not need to know which
it is talking to.

### The `ArticleSource` seam

```ts
export interface ArticleFetchOptions {
  readonly exclude?: readonly string[];
}

export interface ArticleBody {
  readonly body: Buffer;
  readonly server?: string;
}

export interface ArticleSource {
  body(messageId: string, options?: ArticleFetchOptions): Promise<ArticleBody>;
}
```

`@chad3814/nzb` declares its own `ArticleFetchOptions` rather than importing the
one from `@chad3814/nntp`. It must: `nzb` depends on `nzb-parser` and `yenc` and
on nothing else, and the whole point of the seam is that it is structural —
satisfied by a pool, a cache, or a fixture, none of which should have to take a
dependency on the transport. The two declarations are identical by construction,
and the multi-pool satisfying `ArticleSource` is what a test asserts.

Both additions are optional, so every existing source and test double still
satisfies the interface. A method declared with fewer parameters is assignable
to one declared with more, so `NntpPool.body(messageId)` needs no change to keep
satisfying it. This is the compatibility promise, and it gets a test.

### `stat` vs `statAll`

Two methods, because there are two different questions.

`stat` keeps today's signature and fails over: "can I get this from anywhere",
with `response.server` naming who said yes.

`statAll` reports per server:

```ts
export type NntpServerStat = { readonly server: string } & (
  | { readonly status: 'present' }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: Error }
);
```

Three states, and that is the reason the method exists. Today `stat` _throws_ on
a 430, so "the server does not have it" and "I could not ask the server" are
both just errors — visible in the smoke output as `1:NNTP 430: No Such Article`
sitting in the same column as `1:223`. Across several servers that is the
difference between **gone everywhere** and **gone from the ones I could reach**,
and only the first justifies giving up on a file. `statAll` maps a 430 to
`absent` and reserves `unknown` for down, unreachable or refused — including
servers already marked down, reported with their recorded reason rather than
silently omitted.

`statAll` queries servers concurrently. `STAT` transfers no body, so it costs a
round trip and no meaningful bytes; it is not gated by `spillover`.

Note the cost: `stat` across a 1971-article post becomes 1971 × servers requests
if a caller uses `statAll` throughout. Cheap per request, not free. Choosing
between them is the CLI's decision, in the follow-on spec.

## Request flow

For one `body(messageId, { exclude })`, candidates are the servers in configured
order, minus any named in `exclude` and any marked down. They are tried
**sequentially**. Trying them concurrently would spend backup bytes on every
article, which is the thing the ordering exists to prevent.

| Outcome on a candidate                    | Action                                                           |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Success                                   | Return it with `server` set; reset that server's failure count   |
| `430`                                     | Genuine gap — advance to the next candidate                      |
| Timeout / connection error                | Count one consecutive failure; advance                           |
| `NntpCapacityError` that escaped the pool | Advance only to candidates with `spillover: true`                |
| `NntpAuthError` on the primary            | Enter a fatal state and throw; every later request throws it too |
| `NntpAuthError` on any other server       | Mark it down immediately; advance                                |

Auth has a threshold of one because it is deterministic: a password that was
wrong a moment ago will be wrong again, and retrying it once per article is
noise. Connection failures have a threshold of three consecutive failures with
no success between them, because those are transient until they are not. A 430
never counts toward it — that is a fact about an article, not about a server. A
server marked down stays down for the life of the pool.

"Escaped the pool" is load-bearing in the capacity row. A pool at a partial cap
raises nothing: it shrinks its limit and parks the caller. `NntpCapacityError`
reaches the multi-pool only when the pool can open no connection at all, which
is the "primary can serve nothing" case.

### When every candidate is exhausted

If **all** candidates answered 430, rethrow a 430 `NntpProtocolError`. This
preserves an existing contract: `nzb get` skips and reports a file it cannot
open, which is what lets a run continue past the expired `.nfo` in the Linux
Journal post. Changing the error type there would silently turn a skip into a
crash.

Any other mixture throws:

```ts
export class NntpUnavailableError extends Error {
  readonly attempts: readonly { server: string; reason: Error }[];
}
```

## CRC retry in `@chad3814/nzb`

A `pcrc32` mismatch means the bytes are wrong, and another provider is the only
fix. It is detected by `decodeArticle` in `@chad3814/nzb`, above the transport,
which is why the seam needs `exclude` at all.

On a mismatch, re-request with the serving server added to `exclude`. This
terminates without a retry counter: each attempt removes one candidate, so the
pool eventually throws. Two guards:

- If the response carries no `server` — a plain `NntpPool`, or a test double —
  there is nothing to exclude, and behaviour is exactly as today.
- If a source ignores `exclude` and returns a server already in the list, stop
  rather than loop.

Each of `nzb`'s prefetched articles goes through this independently, so a gap on
one article does not serialise the others.

## Credentials

Each server's credential lives where it does today: inside one `NntpPool`'s
memoized providers, bounded by that server's own `credentialTtlMs`. Servers
memoize separately, so eight connections across two providers is two vault
trips, not sixteen.

`NntpMultiPool` must not retain `options.servers`. Those objects contain
`credentials`, and keeping them on a field would put a credential — or a
provider closure — on an instance, which hard rule 3 forbids and the
source-level test in `@chad3814/nntp` is written to catch. The constructor
destructures and discards:

```ts
this.#servers = options.servers.map((server) => ({
  name: server.name ?? server.endpoint.host,
  spillover: server.spillover ?? false,
  pool: new NntpPool(server), // the only thing that sees `credentials`
  state: 'ready',
  consecutiveFailures: 0,
}));
```

Extend the source-level credential test to cover the new file rather than
relying on review.

## Reporting and lifecycle

```ts
export interface NntpServerStatus {
  readonly name: string;
  readonly state: 'ready' | 'down';
  /** Why it went down. Null while ready. */
  readonly downReason: Error | null;
  /** Learned connection limit, which may be below the configured one. */
  readonly limit: number;
  readonly failures: readonly NntpConnectionFailure[];
}
```

This composes what each pool already tracks; `NntpPool` gains no new
bookkeeping. It keeps "failures stay attributable" true across servers — after a
run you can say that _this_ server refused 100 connections and _that_ one is
down because its token expired.

Two construction-time validations, both because the failure is otherwise silent:

- **Duplicate names throw.** Exclusion is by name, so two servers called
  `news.example.com` would make one `exclude` remove both, turning a CRC retry
  into "no candidates".
- **An empty `servers` array throws.**

`destroy()` destroys every pool. The fatal primary-auth state is sticky: once
entered, every request rejects with that error rather than quietly running on
the backups.

## Testing

`startFakeServer` returns its own port and records every command it received, so
several instances with different behaviours is the entire harness. That
`commands` array makes the important assertions negative ones.

- **The backup is never contacted when the primary has the article** — the
  secondary's `commands` is empty. This protects a metered account and is what a
  "make it faster" change breaks first.
- **430 on the primary is served by the secondary**, and `response.server` names
  the secondary.
- **`spillover` gates capacity and nothing else.** Primary refusing every
  connection: without the flag the call throws `NntpCapacityError` and the
  secondary sees nothing; with it, the secondary serves. Same fixture, one flag.
- **Auth on the primary is fatal and sticky** — the secondary is never
  contacted, and a second call throws the same error.
- **Auth on a backup marks it down** — it receives nothing on later articles.
- **The threshold is consecutive** — two failures, a success, two failures
  leaves the server up; three in a row marks it down.
- **Unanimous 430 still throws a 430.** Mixed outcomes throw
  `NntpUnavailableError` naming each server.
- **`exclude` is honoured** — the named server receives nothing.
- **`statAll` returns all three states**, including `unknown` for a server
  already marked down.
- **Construction rejects duplicate names and an empty list.**
- **The seam stays structural** — a bare `{ body(id) }` object still satisfies
  `ArticleSource`.
- **In `@chad3814/nzb`:** a source serving corrupt bytes from A and good bytes
  from B yields correct output; a source with no `server` does not retry.

Mutation targets to run afterwards, since that has found real gaps in every
increment here: drop the `spillover` check; make selection concurrent; ignore
`exclude`; reset the failure counter on failure instead of success; drop the
unanimous-430 rethrow.

### Live

`scripts/smoke.ts` takes an optional second server from `NNTP2_HOST`,
`NNTP2_PORT`, `NNTP2_USER`, `NNTP2_PASS`, `NNTP2_SECURITY` and
`NNTP2_CONNECTIONS`. When present it runs the fill-the-gaps path against the
`.nfo` in the Linux Journal post — a real article Newshosting has lost — which
is the first live proof the feature does what it exists for. Opt-in by the
presence of `NNTP2_HOST`, in the same spirit as `NNTP_PROBE_CAP`.

## Decisions, and what would reverse them

| Decision                           | Reverse it if                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| Ordered list, tried sequentially   | The goal changes from filling gaps to aggregating bandwidth                    |
| `spillover` defaults to false      | Nobody is using a metered account and the flag is only ever set true           |
| Auth fatal on the primary only     | A misconfigured backup silently costing money turns out to be the worse hazard |
| Down is for the life of the pool   | Long-running processes want a provider to come back without a restart          |
| CRC retry lives in `@chad3814/nzb` | Never — the transport does not decode yEnc, by design                          |
