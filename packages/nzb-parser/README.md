# @chad3814/nzb-parser

Strictly-typed parser for NZB 1.1 documents (`http://www.newzbin.com/DTD/2003/nzb`).

**Status: 2.0.0.** Zero runtime dependencies.

```ts
import { parseNzb } from '@chad3814/nzb-parser';

const nzb = parseNzb(await readFile('release.nzb', 'utf8'));
for (const file of nzb.files) {
  console.log(file.subjectHints.name, file.segments.length, file.totalEncodedBytes);
}
```

## Scope

Parse NZB XML into a fully-typed, immutable object graph:

- `<head><meta>` entries, including the de facto `password` key.
- Per-file `poster`, `date`, `subject`, `<groups>`, `<segments>`.
- Derived conveniences: deduplicated group union, `totalEncodedBytes`, a
  `contiguous` flag, and best-effort filename/part extraction from the subject.

## Design notes

- **Nothing in an NZB is authoritative about the reconstituted file.** There is no
  filename field, no decoded size, and no checksum. `segments[].bytes` is the
  _encoded_ article size. `subjectHints` is explicitly named to keep that clear —
  the real filename and size come from the yEnc `=ybegin` header at fetch time.
- **Message-IDs are stored without angle brackets.** The parser preserves them
  verbatim; adding `<` and `>` is the transport's job.
- **`date` is the article posting time**, not the original file's mtime.

## Parsing strategy

A hand-written scanner (`src/scanner.ts`) over the NZB subset, rather than a
general-purpose XML parser. NZBs arrive from untrusted indexers, so the parser is
strict by default and rejects rather than guesses:

- **Unknown entities are an error**, not passed through. Only the five predefined
  entities and numeric character references are expanded.
- **DTD internal subsets are skipped, never interpreted.** Honouring `<!ENTITY>`
  from an untrusted document is how billion-laughs and XXE work, so the decoder
  never sees a document-defined entity table.
- **Duplicate attributes are an error.** Last-one-wins would let a crafted document
  hide a second `date` or `bytes` from a reader that displays the first.
- **Malformed structure is an error** — mismatched or unclosed tags, non-integer
  `bytes`/`number`/`date`, empty `<group>`, a `<segment>` with no Message-ID.

Accepted without complaint, because real NZBs contain them: the XML declaration,
`<!DOCTYPE>`, comments, CDATA sections, namespace-prefixed element names
(`<n:file>`), out-of-order segments, and Message-IDs a poster wrongly wrapped in
angle brackets.

Namespace URIs are not validated. Plenty of real NZBs omit `xmlns` entirely, and
rejecting them would buy nothing.
