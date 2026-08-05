# @chad3814/nntp

Strictly-typed NNTP client (RFC 3977 + RFC 4643 `AUTHINFO`) with no runtime dependencies.

**Status: types only.** The protocol model in `src/models.ts` is complete; the
client implementation has not landed yet.

## Scope

`connect` / `authenticate` / `group` / `stat` / `head` / `body` / `article` / `quit`,
over cleartext (119), implicit TLS (563), or `STARTTLS`. Built on `node:tls` and
`node:net` only.

## Two invariants this package owns

**Dot-unstuffing happens here.** Multi-line responses are dot-stuffed on the wire:
a body line beginning with `.` is transmitted as `..`, and a lone `.` terminates
the block. Every `Buffer` this package returns is already unstuffed.

This is load-bearing, because yEnc decoders do not do it — `@thaunknown/yencode`
calls its decoder with `stripDots = false`. If unstuffing is skipped here, nothing
downstream catches it, and roughly one article in a few hundred is silently
corrupted.

**Payloads are `Buffer`, never `string`.** Usenet is 8-bit clean and yEnc depends
on it; a UTF-8 round-trip mangles article data irrecoverably. Only status lines are
decoded to text, as `latin1`.

## Credentials

`NntpCredentials` is accepted by `authenticate()` and nowhere else. It is never
stored on the client, written to a log, embedded in an error message, or
re-emitted. No other package in this repo accepts the type — `@chad3814/nzb` takes
an already-authenticated article source instead.

## Protocol notes worth keeping straight

- **Message-IDs are passed without angle brackets** (the form NZB stores); the
  client adds `<` and `>`. Forgetting this yields `430 No Such Article`.
- **`GROUP` is not required for Message-ID lookup** (RFC 3977 §6.2.1). It is only
  needed for article-number access, or for providers that insist.
- **Connections are reusable.** Issue the next command immediately after the
  terminating dot; throughput comes from pipelining many connections, not from
  anything clever in the protocol.
- `430` = article gone, `480` = auth required, `502` = permission denied or
  connection limit reached. These must stay individually distinguishable —
  see `NntpConnectionOutcome`.
