# @chad3814/nntp

Strictly-typed NNTP client (RFC 3977, `AUTHINFO` from RFC 4643) with TLS,
connection pooling, and dot-unstuffing.

**Status: 1.0.0.** One runtime dependency,
[`@chad3814/secret-provider`](https://github.com/chad3814/secret-provider).

```ts
import { NntpPool } from '@chad3814/nntp';
import { chain, fromEnv, fromFile } from '@chad3814/secret-provider';

const pool = new NntpPool({
  endpoint: { host: 'news.example.com', port: 563, security: 'implicit' },
  credentials: {
    user: fromEnv('NNTP_USERNAME'),
    pass: chain(fromEnv('NNTP_PASSWORD'), fromFile('/run/secret/nntp_password')),
  },
  credentialTtlMs: 15 * 60_000, // if the source issues short-lived credentials
  connections: 8,
});

const { body } = await pool.body('abc123@news.example.com'); // no angle brackets
```

## Credentials

This is the only package in the repo that accepts a credential. `NntpCredentials`
is taken by `NntpClient.authenticate()` and `NntpPool`'s constructor, used to
build one command, and never assigned to a readable field, logged, serialized, or
included in an error. `@chad3814/nzb` takes an injected `ArticleSource` instead
and has no credential-shaped parameter at all.

There is one deliberate qualification to that, about what the pool holds in
memory rather than what it exposes; it is spelled out below.

### Literals or providers

Each field is an `NntpSecret` — a literal, or a `Provider<string>` from
[`@chad3814/secret-provider`](https://github.com/chad3814/secret-provider):

```ts
type NntpSecret = string | Provider<string>;
```

So `chain`, `fromEnv`, `fromFile`, `fromStatic` and anything else of that shape
go straight in. Providers are the better form for a secret: nothing is fetched by
constructing a pool, the value can come straight from a vault or a subprocess
without passing through a config file, and a rotated credential is picked up
without rebuilding anything.

This follows the pattern that library's README lays out for consumers, including
the parts that are easy to get wrong:

- **Normalised and memoized once, here.** A literal becomes `fromStatic`, and
  both fields are memoized at the pool's boundary. A pool of eight connections
  makes **one** trip to the underlying source, not eight, and a caller who never
  thought about memoization does not get a subprocess spawn per connection.
- **Resolved at use, never in the constructor.** Construction stays synchronous
  and no credential is fetched until a connection is actually opened.
- **Expiry is supported.** `credentialTtlMs` re-resolves a credential once it is
  that old, for sources that issue them with a lifetime. The clock starts when
  the value _arrives_, so a vault taking three seconds to answer does not burn
  three seconds of a five-second lifetime. Without it, the value is cached for
  the life of the pool.
- **The password is resolved only if the server asks for one.** Some servers
  answer `281` to `AUTHINFO USER` alone, and there is no reason to fetch a secret
  that will not be sent.
- **`ProviderError` propagates untouched.** Wrapping it would destroy
  `tryNextLink` and the aggregated list of every source a chain tried — which is
  the part that makes a misconfiguration diagnosable, and, since that list names
  the variables and paths, what identifies which credential failed. Only this
  package's own validation raises `NntpCredentialError`.

**What that costs, stated plainly:** a memoized provider holds the resolved
credential in its closure, so the pool does retain the secret in memory — until
`credentialTtlMs` elapses, or for the pool's lifetime if it is not set. That is a
deliberate trade against a vault round-trip per connection, not an oversight. If
you would rather nothing were retained, pass credentials to
`NntpClient.authenticate()` directly and manage connections yourself; that path
resolves per call and caches nothing.

### Line breaks are rejected

`AUTHINFO PASS ${secret}` is built by interpolation, so a credential containing
CR or LF would terminate the line early and append whatever follows as a second
NNTP command. Both literals and resolved values are rejected if they contain one.
This matters more with providers than it did without: a value read from a file,
an environment variable or a subprocess is exactly where a stray newline comes
from.

### What cannot be asserted

Errors are built from the status code and the server's own text, never from the
command line — otherwise `AUTHINFO PASS <secret>` lands in logs and stack traces.
`redact()` covers the timeout path, where the label would otherwise be the raw
command.

One honest limit, worth stating because it is easy to assume otherwise: a
`#private` field is invisible to `JSON.stringify`, `Reflect.ownKeys` **and**
`util.inspect({ showHidden: true })` alike, so "the client does not retain the
password" cannot be asserted at runtime. It is enforced against the source
instead, by a test that fails on any `this.x = credentials` assignment in the
package — and, since providers made it possible to stash the _resolved_ value
under another name, on any `this.x = resolveSecret(...)` too.

That rule covers `NntpClient`, which retains nothing. It does **not** claim the
same of `NntpPool`, which by design holds memoized providers whose closures
retain the resolved value; see above.

## What this does that the reference stack does not

- **Dot-unstuffing happens here.** NNTP transmits a body line beginning with `.`
  as `..`. yEnc decoders do not undo it — `@thaunknown/yencode` calls its
  decoder with `stripDots = false` — so a transport that skips it corrupts the
  article silently, with no checksum failure to point at it.

  How often that fires depends entirely on the encoder. yEnc's spec _recommends_
  escaping `.` at the start of a line, and an encoder that follows the
  recommendation never produces a line NNTP would stuff. Measured against a real
  post: **0 stuffed lines in 66,563**, across two 4 MiB articles. So this is a
  correctness requirement, not a common event — earlier drafts of these docs
  claimed "roughly one article in a few hundred", which that measurement does not
  support for encoders that escape leading dots. It still has to be right,
  because the encoders that skip the recommendation exist and nothing downstream
  would catch them.

- **Empty bodies do not hang.** A body that is only a terminator has no
  preceding line, so the usual scan for `\r\n.\r\n` never matches and the read
  blocks until the socket times out.
- **A split terminator is found.** `\r\n.` and `\r\n` can arrive in separate TCP
  segments. The scanner keeps a lookback window, because the client polls after
  every `data` event rather than once at the end.
- **Connections open on demand.** The reference pool opens all 24 in its
  constructor: 24 TLS handshakes and 24 logins to fetch a 172 KB preview.
- **Failures stay attributable.** The reference pool catches every
  per-connection error bare and reports one generic "failed to establish any
  NNTP connections", making a wrong password indistinguishable from a provider
  connection cap. Here the originating error propagates, and `pool.failures`
  keeps the per-attempt history.
- **A failed connection is discarded, not re-enqueued.** The reference pool
  returns connections in a `finally` with no health check and then hands the
  same dead socket out repeatedly.
- **A caller waiting for a connection can always be woken, or told why not.**
  Parked callers are resolved _or rejected_, and parking happens only after
  checking for a connection that has already gone idle. Both matter at
  saturation: see below.
- **Every command has a deadline.** The reference implementation has no timeouts
  anywhere.
- **Message-IDs are wrapped.** NZBs store them bare and the protocol requires
  angle brackets; forgetting is a `430` on every article.
- **Payloads stay `Buffer`.** Usenet is 8-bit clean. Only status lines become
  strings, as `latin1`.

## At a provider's connection cap

`502 Too many connections` is not an authentication failure, and treating it as
one sends people to rotate a working password. It raises `NntpCapacityError`,
and the pool responds by shrinking `limit` to what the account actually gives
and running the work on the connections it has, rather than failing requests
that are perfectly fetchable.

Measured against a real 100-connection account, asking for 200 at once:

```
200 concurrent requests all settled in 11.9 s; 99 refused, limit shrank 200 -> 101
```

Two things worth knowing from that run:

- **The shrunk limit is approximate, and self-correcting.** It is set to the
  number of connections open at the moment of a refusal, which counts opens
  still in flight, so it can land a little above the true cap. The next refusal
  brings it down again.
- **Saturation is where pool liveness actually gets tested.** Every open starts
  before any completes, so the connections that succeed finish their work and go
  _idle_ while the refusals are still arriving. An earlier version parked the
  refused callers without looking at the idle list, and nothing was left running
  to wake them: 200 concurrent requests hung with no error and no work in
  flight. Parking now checks for an idle connection first, and a parked caller
  is failed outright when the pool provably cannot serve it — no live
  connections, none openable, or destroyed. At 40 requests against a cap of 10
  the interleaving does not occur, which is why it took a live account to find.

`scripts/smoke.ts` reproduces this against a real provider under
`NNTP_PROBE_CAP=1`. It is opt-in because it deliberately saturates the account.

## More than one server

An article one provider has dropped is often still on another. `NntpMultiPool`
takes an ordered list and reaches a later server only when an earlier one cannot
supply the article — filling gaps, not aggregating bandwidth.

```ts
const pool = new NntpMultiPool({
  servers: [
    { name: 'primary', endpoint, credentials, connections: 20 },
    { name: 'block', endpoint: other, credentials: blockCreds, connections: 8 },
  ],
});

const { body, server } = await pool.body('abc123@news.example.com');
```

Servers are tried **sequentially**, and the reason is money: a second provider
is usually a metered block account, and asking everyone at once would spend its
bytes on every article the primary already had. For the same reason, taking
overflow from a server that is at its connection cap is opt-in per server via
`spillover`, and off by default — a metered account should pay for gaps, not
for overflow the primary would have covered a moment later. `spillover` gates
only that path; a genuine gap (a `430`) still falls through to a non-spillover
server.

| Outcome                                 | What happens                                                                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `430`                                   | A gap. Advance to the next server. Never counts against the server's health.                                                                                                                                                                           |
| Timeout or connection loss              | Counted. Three in a row with no success between takes the server out of rotation for the life of the pool.                                                                                                                                             |
| At the connection cap, nothing openable | Advance only to servers with `spillover: true`. When more than one server is saturated, the error surfaced is the **earliest** one's — the primary's cap is the actionable account, and a downstream server's cap is just where the walk gave up next. |
| Auth refused on the primary             | Fatal, and sticky. Failing over would run a whole download on a backup because of a typo.                                                                                                                                                              |
| Auth refused on any other server        | That server is marked down immediately, on the first strike — a wrong password will still be wrong next time.                                                                                                                                          |

If every server answers `430`, the article is gone and a `430`
`NntpProtocolError` is thrown, so callers that skip-and-report (`nzb get`) keep
working. Any other mixture throws `NntpUnavailableError`, whose `attempts`
names each server and its reason.

`statAll(messageId)` reports per server, with three states rather than two:
`present`, `absent` (the server said 430) and `unknown` (it could not be
asked). `absent` and `unknown` are different facts, and only unanimous `absent`
justifies giving up on a file.

A third-party credential provider's error can end up here too, by the same
route as `NntpUnavailableError`'s messages: `NntpServerStatus.downReason` and
each failed attempt carry the provider's `error.message` unwrapped, per
`resolveSecret`'s policy in `auth.ts` of letting a provider's rejection
propagate rather than wrapping it. That is existing, deliberate behavior, not
new — providers already own their own error hygiene. It is just newly visible
here, across more than one server, and worth stating plainly for the
`@chad3814/secret-provider-*` vault packages that are coming: a provider must
not put the secret in the error it throws.

## Layout

| Module                  | Role                                                    |
| ----------------------- | ------------------------------------------------------- |
| `response-buffer.ts`    | Wire framing: lines, dot-terminated blocks, unstuffing  |
| `auth.ts`               | Resolving a credential and spending it on `AUTHINFO`    |
| `client.ts`             | One connection: commands, responses, timeouts           |
| `pool.ts`               | Lazy pool of authenticated connections                  |
| `multi-pool.ts`         | An ordered list of pools, walked until one answers      |
| `multi-pool-failure.ts` | Classifying one candidate's failure; the down threshold |
| `multi-pool-models.ts`  | Per-server options, status, and the `statAll` verdict   |
| `socket.ts`             | TCP / implicit TLS / `STARTTLS` upgrade                 |
| `wire.ts`               | Message-ID wrapping and redaction                       |

`NntpMultiPool` composes one `NntpPool` per server rather than teaching one pool
about several endpoints, because the learned connection cap, the credential and the
up/down state are all per-server. It manages no sockets of its own. Failure
classification is split into `multi-pool-failure.ts` so that deciding what a failure
means is a pure function of an entry, an error and the current walk — the class is
left as the only thing holding the authority to fail every walk rather than just
this one.

`ResponseBuffer` and `auth.ts` are both socket-free on purpose. Framing is where
the subtle bugs live, and authentication is where the sensitive ones are, so each
is a function of its inputs and is tested without a network: `runAuthInfo` takes
a callback that sends a line and returns a parsed response, which is enough to
test which codes mean what, when the password is fetched, and what never reaches
an error.

## Testing

131 unit tests. The client and pool run against a real TCP server (`test/fake-server.ts`)
rather than a mocked socket — the bugs worth catching are framing bugs, and a
mock that hands over whole responses cannot produce a split terminator. The
fake server can deliver a reply as several writes specifically to force awkward
chunk boundaries.

Mutation-tested: dropping angle brackets, skipping dot-unstuffing, removing the
split-terminator lookback, reading a body after a `430`, leaking the password
into an auth error, stashing it in a private field, ignoring the connection cap,
and never reusing a connection each fail at least one test. So do the credential
mutations: removing the line-break check, checking only CR and not LF, accepting
an empty or non-string value, resolving the password before the server asks for
it, dropping the pool's memoization, ignoring `credentialTtlMs`, starting the
expiry clock before the resolution instead of after, and re-wrapping
`ProviderError`.
