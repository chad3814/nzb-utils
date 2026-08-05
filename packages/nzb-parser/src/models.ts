/**
 * Domain model for NZB 1.1 documents.
 *
 * Namespace: `http://www.newzbin.com/DTD/2003/nzb`
 *
 * An NZB is an index of Usenet articles, not a manifest of files. It carries no
 * authoritative filename, no decoded size, and no checksum — those live in the
 * yEnc article headers and in the PAR2 set respectively. Every field here that
 * is derived rather than read verbatim is marked as such.
 */

/** A `<meta>` entry from the NZB `<head>` block. */
export interface NzbMeta {
  readonly type: string;
  readonly value: string;
}

/**
 * `<meta type="...">` values seen in the wild. Anything else is passed through
 * verbatim in {@link NzbMeta.type}; this union exists for ergonomic lookups, not
 * for validation.
 *
 * - `title` / `tag` / `category`: advisory indexer metadata.
 * - `password`: de facto standard, read by SABnzbd and NZBGet to unpack
 *   encrypted archives.
 */
export type KnownNzbMetaType = 'title' | 'tag' | 'category' | 'password';

/** One Usenet article backing part of a file. */
export interface NzbSegment {
  /** 1-based ordering index, from the `number` attribute. */
  readonly number: number;
  /**
   * Size of the *article* in bytes: yEnc-encoded, including line breaks and
   * escape overhead. Typically 2–4% larger than the decoded payload. Never
   * treat this as a decoded byte count.
   */
  readonly bytes: number;
  /** Message-ID with angle brackets stripped, exactly as stored in the NZB. */
  readonly messageId: string;
}

/**
 * Filename and part counters recovered from the article subject.
 *
 * NZB has no filename field — the name is conventionally quoted inside the
 * Usenet subject, followed by a `(part/total)` counter and sometimes a trailing
 * decoded byte count. All of it is advisory. The authoritative filename and
 * size come from the yEnc `=ybegin name=` / `size=` headers at fetch time.
 */
export interface NzbSubjectHints {
  readonly name: string | null;
  readonly part: number | null;
  readonly totalParts: number | null;
  /** Trailing byte count some posters append to the subject. Advisory only. */
  readonly declaredSize: number | null;
}

export interface NzbFile {
  /** `From:` header of the article. Frequently randomized per file. */
  readonly poster: string;
  /** Article *posting* time, not the original file's mtime. */
  readonly date: Date;
  readonly subject: string;
  /** Newsgroups the articles can be fetched from; usable as fallbacks. */
  readonly groups: readonly string[];
  /** Sorted ascending by {@link NzbSegment.number}. */
  readonly segments: readonly NzbSegment[];
  readonly subjectHints: NzbSubjectHints;
  /** Derived: sum of `segments[].bytes`. Encoded size, not decoded size. */
  readonly totalEncodedBytes: number;
  /**
   * Derived: true when segment numbers form a contiguous `1..n` run.
   *
   * A contiguous index says nothing about whether those articles are still
   * retained by any given provider — only that the NZB itself has no gaps.
   */
  readonly contiguous: boolean;
}

export interface Nzb {
  readonly meta: readonly NzbMeta[];
  readonly files: readonly NzbFile[];
  /** Derived: union of every `<group>` across every file, deduplicated. */
  readonly groups: readonly string[];
}

/** Signature of the parser entry point. */
export type ParseNzb = (xml: string) => Nzb;
