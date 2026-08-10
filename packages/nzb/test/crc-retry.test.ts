import { describe, expect, it } from 'vitest';

import { YencChecksumError, YencDecodeError } from '@chad3814/yenc';

import { fetchArticle } from '../src/fetch.ts';
import type { ArticleBody, ArticleFetchOptions, ArticleSource } from '../src/models.ts';
import { buildPost } from './post.ts';

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
    const source: ArticleSource = {
      body: () => Promise.resolve({ body: Buffer.from('not yEnc at all\r\n'), server: 'a' }),
    };

    await expect(fetchArticle(source, 'x@y', { verify: true })).rejects.toBeInstanceOf(
      YencDecodeError,
    );
  });
});
