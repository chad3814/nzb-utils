import { describe, expect, it } from 'vitest';

import { YencChecksumError, YencDecodeError } from '@chad3814/yenc';

import { fetchArticle } from '../src/fetch.ts';
import { openNzbFile } from '../src/handle.ts';
import type { ArticleBody, ArticleFetchOptions, ArticleSource } from '../src/models.ts';
import { buildPost } from './post.ts';
import type { Post } from './post.ts';

/**
 * The fixture's raw article bytes for segment 1, plus a copy whose payload has
 * been altered so the `=yend pcrc32` no longer describes it.
 *
 * `Post` is `{ file, source, data }` — there is no map of articles on it, so
 * the encoded bytes come back through the source itself.
 *
 * One payload byte is set to a specific safe value rather than XORed: an
 * arbitrary flip can produce `=`, CR or LF, which changes the article's
 * *structure* and raises YencDecodeError instead of the checksum error this is
 * meant to provoke.
 */
async function corruptible(): Promise<{ id: string; good: Buffer; corrupt: Buffer }> {
  const post = buildPost({ segmentSizes: [100] });
  const id = post.file.segments[0]?.messageId;
  if (id === undefined) {
    throw new Error('fixture has no segments');
  }

  const { body: good } = await post.source.body(id);
  const corrupt = Buffer.from(good);
  // First byte after the =ybegin line. A single-segment post has no =ypart, so
  // the payload starts immediately.
  const at = good.indexOf('\r\n') + 2;
  const original = corrupt[at];
  if (original === undefined) {
    throw new Error('fixture article is shorter than its header');
  }
  corrupt[at] = original === 0x41 ? 0x42 : 0x41;

  return { id, good, corrupt };
}

/** A source where the server named `bad` serves the corrupted copy. */
function twoServers(good: Buffer, corrupt: Buffer): ArticleSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    body(_messageId: string, options?: ArticleFetchOptions): Promise<ArticleBody> {
      const excluded = new Set(options?.exclude ?? []);
      const server = excluded.has('bad') ? 'good' : 'bad';
      asked.push(server);
      return Promise.resolve({ body: server === 'bad' ? corrupt : good, server });
    },
  };
}

describe('fetchArticle', () => {
  it('retries on another server when the CRC does not match', async () => {
    const { id, good, corrupt } = await corruptible();
    const source = twoServers(good, corrupt);

    const article = await fetchArticle(source, id, { verify: true });

    expect(source.asked).toEqual(['bad', 'good']);
    expect(article.data.byteLength).toBe(100);
  });

  it('does not retry when the source names no server', async () => {
    // A plain NntpPool or a test double. Nothing to exclude, so behaviour is
    // exactly what it was before multi-server existed: the error propagates.
    const { id, corrupt } = await corruptible();
    let calls = 0;
    const source: ArticleSource = {
      body: () => {
        calls += 1;
        return Promise.resolve({ body: corrupt });
      },
    };

    await expect(fetchArticle(source, id, { verify: true })).rejects.toBeInstanceOf(
      YencChecksumError,
    );
    expect(calls).toBe(1);
  });

  it('does not loop when a source ignores exclude', async () => {
    const { id, corrupt } = await corruptible();
    let calls = 0;
    const source: ArticleSource = {
      body: () => {
        calls += 1;
        return Promise.resolve({ body: corrupt, server: 'stubborn' });
      },
    };

    await expect(fetchArticle(source, id, { verify: true })).rejects.toBeInstanceOf(
      YencChecksumError,
    );
    expect(calls).toBe(2);
  });

  it('does not retry a malformed article, which is malformed everywhere', async () => {
    // The mock reports a fixed `server: 'a'` on every call, same as the
    // "ignores exclude" case above. So it is `calls` that proves the
    // `instanceof YencChecksumError` gate did its job here: without it, a
    // decode failure would retry once (hitting the `tried.includes('a')`
    // guard) and still reject with the same YencDecodeError, and an assertion
    // on the error type alone would not catch that regression.
    let calls = 0;
    const source: ArticleSource = {
      body: () => {
        calls += 1;
        return Promise.resolve({ body: Buffer.from('not yEnc at all\r\n'), server: 'a' });
      },
    };

    await expect(fetchArticle(source, 'x@y', { verify: true })).rejects.toBeInstanceOf(
      YencDecodeError,
    );
    expect(calls).toBe(1);
  });

  it('reports the checksum failure, not the empty walk, when nowhere else has it', async () => {
    // What a single-server NntpMultiPool does: attempt 1 answers as 'a' with
    // corrupt bytes, attempt 2 excludes 'a', the walk's loop body never runs,
    // and the pool reports that no server was available to try. That is the
    // opposite of what happened -- a server was available and its copy was
    // wrong -- and it is the one case this whole feature exists for.
    const { id, corrupt } = await corruptible();
    const exhausted = new Error('no configured server could supply the article');
    const source: ArticleSource = {
      body(_messageId: string, options?: ArticleFetchOptions): Promise<ArticleBody> {
        return (options?.exclude ?? []).includes('a')
          ? Promise.reject(exhausted)
          : Promise.resolve({ body: corrupt, server: 'a' });
      },
    };

    const error = await fetchArticle(source, id, { verify: true }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(YencChecksumError);
    // The source's account of the walk is kept rather than discarded: it is
    // still the only thing that says which servers were ruled out and why.
    expect((error as Error).cause).toBe(exhausted);
  });
});

/** Decoded bytes per segment for the failover posts below. Three, with a short tail. */
const SEGMENTS = [100, 100, 40];

function segmentId(post: Post, number: number): string {
  const id = post.file.segments[number - 1]?.messageId;
  if (id === undefined) {
    throw new Error(`fixture has no segment ${String(number)}`);
  }
  return id;
}

/**
 * Two servers holding the same post, one of which has a damaged copy.
 *
 * `bad` answers first and serves `damaged`'s articles; naming it in `exclude`
 * moves the request to `good` and `intact`'s. Both posts are built from the
 * same options, so every Message-ID and every undamaged article is
 * byte-identical between them — the only difference is the article the caller
 * asked `buildPost` to corrupt.
 *
 * Records `<server> <message-id>` per request, which is what distinguishes
 * "retried elsewhere" from "happened to be asked twice".
 */
function failover(intact: Post, damaged: Post): ArticleSource & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async body(messageId: string, options?: ArticleFetchOptions): Promise<ArticleBody> {
      const server = new Set(options?.exclude ?? []).has('bad') ? 'good' : 'bad';
      asked.push(`${server} ${messageId}`);
      const { body } = await (server === 'bad' ? damaged : intact).source.body(messageId);
      return { body, server };
    },
  };
}

/**
 * The same failover, through the surface a caller actually uses.
 *
 * The tests above call {@link fetchArticle} directly, which pins the retry
 * loop but pins nothing about the library reaching it: both of `@chad3814/nzb`'s
 * call sites can be reverted to fetch-and-decode inline and every other test
 * still passes. These two go through `openNzbFile` and a sliced read instead
 * and assert on the bytes that come out, so a call site that stops routing
 * through `fetchArticle` fails here.
 */
describe('CRC retry through the public surface', () => {
  it('recovers when the probe article arrives corrupt', async () => {
    // Segment 1 is fetched once by the probe and retained for the life of the
    // handle, so a corrupt copy is not a one-read problem: it is the copy every
    // later read and every later geometry check would compare against.
    const intact = buildPost({ segmentSizes: SEGMENTS });
    const damaged = buildPost({ segmentSizes: SEGMENTS, corrupt: new Set([0]) });
    const source = failover(intact, damaged);

    const handle = await openNzbFile(intact.file, source);
    const head = handle.slice(0, 100);

    expect(Buffer.from(await head.bytes())).toEqual(intact.data.subarray(0, 100));
    // One retry for the probe, and nothing further: the read is served from the
    // retained article, which must be the good copy rather than the first one.
    expect(source.asked).toEqual([`bad ${segmentId(intact, 1)}`, `good ${segmentId(intact, 1)}`]);
  });

  it('recovers when a later segment arrives corrupt', async () => {
    // Segment 1 is fine on both servers here, so the probe is not what is
    // being exercised: this is the `#articleFor` path that every segment after
    // the first goes through.
    const intact = buildPost({ segmentSizes: SEGMENTS });
    const damaged = buildPost({ segmentSizes: SEGMENTS, corrupt: new Set([1]) });
    const source = failover(intact, damaged);

    const handle = await openNzbFile(intact.file, source);
    const middle = handle.slice(100, 200);

    expect(Buffer.from(await middle.bytes())).toEqual(intact.data.subarray(100, 200));
    expect(source.asked).toEqual([
      `bad ${segmentId(intact, 1)}`,
      `bad ${segmentId(intact, 2)}`,
      `good ${segmentId(intact, 2)}`,
    ]);
  });
});
