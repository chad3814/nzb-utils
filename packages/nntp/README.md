# @chad3814/nntp

Strictly-typed NNTP client (RFC 3977, `AUTHINFO` from RFC 4643) with TLS,
connection pooling, and dot-unstuffing.

**Status: implemented, not yet published.** One runtime dependency,
[`@chad3814/secret-provider`](https://github.com/chad3814/secret-provider).

```ts
import { NntpPool } from '@chad3814/nntp';
import { chain, fromEnv, fromFile } from '@chad3814/secret-provider';

const pool = new NntpPool({
  endpoint: { host: 'news.example.com', port: 563, security: 'implicit' },
  credentials: {
    user: fromEnv('NNTP_USER'),
    pass: chain(fromEnv('NNTP_PASS'), fromFile('/run/secrets/nntp')),
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
- **Every command has a deadline.** The reference implementation has no timeouts
  anywhere.
- **Message-IDs are wrapped.** NZBs store them bare and the protocol requires
  angle brackets; forgetting is a `430` on every article.
- **Payloads stay `Buffer`.** Usenet is 8-bit clean. Only status lines become
  strings, as `latin1`.

## Layout

| Module               | Role                                                   |
| -------------------- | ------------------------------------------------------ |
| `response-buffer.ts` | Wire framing: lines, dot-terminated blocks, unstuffing |
| `auth.ts`            | Resolving a credential and spending it on `AUTHINFO`   |
| `client.ts`          | One connection: commands, responses, timeouts          |
| `pool.ts`            | Lazy pool of authenticated connections                 |
| `socket.ts`          | TCP / implicit TLS / `STARTTLS` upgrade                |
| `wire.ts`            | Message-ID wrapping and redaction                      |

`ResponseBuffer` and `auth.ts` are both socket-free on purpose. Framing is where
the subtle bugs live, and authentication is where the sensitive ones are, so each
is a function of its inputs and is tested without a network: `runAuthInfo` takes
a callback that sends a line and returns a parsed response, which is enough to
test which codes mean what, when the password is fetched, and what never reaches
an error.

## Testing

88 unit tests. The client and pool run against a real TCP server (`test/fake-server.ts`)
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
