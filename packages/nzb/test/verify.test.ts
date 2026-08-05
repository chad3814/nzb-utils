import { describe, expect, it } from 'vitest';

import { NzbGeometryError } from '../src/errors.ts';
import { openNzbFile } from '../src/handle.ts';
import { buildPost } from './post.ts';

describe('predict-then-verify', () => {
  it('refuses to read a post whose articles are not where they were predicted', async () => {
    // Segment 3 really holds bytes [190, 290). Uniform arithmetic says
    // [200, 300). nzb-file returns the bytes anyway, ten bytes out of place,
    // with no error at any layer.
    const post = buildPost({
      segmentSizes: [100, 100, 100, 40],
      declaredRanges: new Map([[2, [190, 290] as const]]),
    });
    const handle = await openNzbFile(post.file, post.source);

    await expect(handle.slice(205, 215).bytes()).rejects.toThrow(NzbGeometryError);
  });

  it('reads the segments that are where they were predicted', async () => {
    // Verification is per article, so a bad segment 3 does not poison a read
    // that never touches it.
    const post = buildPost({
      segmentSizes: [100, 100, 100, 40],
      declaredRanges: new Map([[2, [190, 290] as const]]),
    });
    const handle = await openNzbFile(post.file, post.source);

    await expect(handle.slice(105, 115).bytes()).resolves.toEqual(
      new Uint8Array(post.data.subarray(105, 115)),
    );
  });

  it('refuses a genuinely variable-size post that starts out looking uniform', async () => {
    // The realistic shape of a non-uniform post: segments 1 and 2 are 100
    // bytes, segment 3 is 150, and the declared total still divides plausibly.
    // Nothing is detectable until segment 3's own header arrives -- which is
    // exactly why the prediction is checked per article rather than once.
    const post = buildPost({ segmentSizes: [100, 100, 150, 40] });
    const handle = await openNzbFile(post.file, post.source);

    expect(handle.geometry.uniform).toBe(true);
    await expect(handle.slice(205, 215).bytes()).rejects.toThrow(NzbGeometryError);
  });

  it('refuses a post whose declared size contradicts its segment count', async () => {
    // Detected at probe time, from the one article already fetched: four
    // 100-byte segments cannot hold 900 bytes.
    const post = buildPost({ segmentSizes: [100, 100, 100, 40], declaredTotalSize: 900 });
    const handle = await openNzbFile(post.file, post.source);

    expect(handle.geometry.uniform).toBe(false);
    await expect(handle.slice(0, 10).bytes()).rejects.toThrow(/uniform/u);
  });

  it('refuses when a provider serves an article from a different file', async () => {
    const post = buildPost({
      segmentSizes: [100, 100],
      declaredNames: new Map([[1, 'somethingelse.bin']]),
    });
    const handle = await openNzbFile(post.file, post.source);

    await expect(handle.slice(100, 110).bytes()).rejects.toThrow(NzbGeometryError);
  });

  it('rejects a corrupt article rather than returning its bytes', async () => {
    // yEnc's pcrc32 covers each article on its own, so corruption is caught
    // without PAR2. fromPost never reads the trailer, so "verified" downloads
    // verified nothing.
    const post = buildPost({ segmentSizes: [100, 40], corrupt: new Set([1]) });
    const handle = await openNzbFile(post.file, post.source);

    await expect(handle.slice(100, 110).bytes()).rejects.toThrow(/CRC32/u);
  });

  it('can be told not to verify checksums', async () => {
    const post = buildPost({ segmentSizes: [100, 40], corrupt: new Set([1]) });
    const handle = await openNzbFile(post.file, post.source, { verify: false });

    await expect(handle.slice(100, 110).bytes()).resolves.toHaveLength(10);
  });
});
