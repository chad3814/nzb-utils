# @chad3814/nntp

Strictly-typed NNTP client (RFC 3977, `AUTHINFO` from RFC 4643) with TLS,
connection pooling, and dot-unstuffing.

**Status: implemented, not yet published.** Zero runtime dependencies.

```ts
import { NntpPool } from '@chad3814/nntp';

const pool = new NntpPool({
  endpoint: { host: 'news.example.com', port: 563, security: 'implicit' },
  credentials: { user, pass }, // used to log connections in, then dropped
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

Errors are built from the status code and the server's own text, never from the
command line — otherwise `AUTHINFO PASS <secret>` lands in logs and stack traces.
`redact()` covers the timeout path, where the label would otherwise be the raw
command.

One honest limit, worth stating because it is easy to assume otherwise: a
`#private` field is invisible to `JSON.stringify`, `Reflect.ownKeys` **and**
`util.inspect({ showHidden: true })` alike, so "the client does not retain the
password" cannot be asserted at runtime. It is enforced against the source
instead, by a test that fails on any `this.x = credentials` assignment in the
package.

## What this does that the reference stack does not

- **Dot-unstuffing happens here.** NNTP transmits a body line beginning with `.`
  as `..`. yEnc decoders do not undo it — `@thaunknown/yencode` calls its
  decoder with `stripDots = false` — so a transport that skips it silently
  corrupts roughly one article in a few hundred.
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
| `client.ts`          | One connection: commands, responses, timeouts          |
| `pool.ts`            | Lazy pool of authenticated connections                 |
| `socket.ts`          | TCP / implicit TLS / `STARTTLS` upgrade                |
| `wire.ts`            | Message-ID wrapping and redaction                      |

`ResponseBuffer` is synchronous and socket-free on purpose. Framing is where the
subtle bugs live, so it is a pure function of the bytes fed in and is tested
without a network.

## Testing

45 unit tests. The client and pool run against a real TCP server (`test/fake-server.ts`)
rather than a mocked socket — the bugs worth catching are framing bugs, and a
mock that hands over whole responses cannot produce a split terminator. The
fake server can deliver a reply as several writes specifically to force awkward
chunk boundaries.

Mutation-tested: dropping angle brackets, skipping dot-unstuffing, removing the
split-terminator lookback, reading a body after a `430`, leaking the password
into an auth error, stashing it in a private field, ignoring the connection cap,
and never reusing a connection each fail at least one test.
