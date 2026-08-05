import { describe, expect, it } from 'vitest';
import type { YencArticle } from '@chad3814/yenc';

import { NzbGeometryError } from '../src/errors.ts';
import { probeGeometry, verifyPlacement } from '../src/geometry.ts';
import type { SegmentGeometry } from '../src/models.ts';
import { buildPost } from './post.ts';

describe('probeGeometry', () => {
  it('costs exactly one article', async () => {
    // Opening a handle must not walk the whole post. The reference stack's
    // sin is the opposite one -- work proportional to the file for a question
    // about its first bytes.
    const post = buildPost({ segmentSizes: [100, 100, 100, 40] });

    await probeGeometry(post.file, post.source);

    expect(post.source.requested).toEqual([post.file.segments[0]?.messageId]);
  });

  it('takes the name from the yEnc header, not the subject', async () => {
    // An NZB has no filename field at all; the subject is a poster's habit.
    const post = buildPost({ name: 'real.mkv', segmentSizes: [50, 50] });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.name).toBe('real.mkv');
  });

  it('takes the total size from =ybegin size=, not from summed segment bytes', async () => {
    // NzbSegment.bytes is the *encoded* article size, 2-4% larger than the
    // payload. Summing it and calling the result a file size is off by
    // megabytes on a feature-length release.
    const post = buildPost({ segmentSizes: [100, 100, 40] });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry.totalSize).toBe(240);
    expect(post.file.totalEncodedBytes).toBeGreaterThan(240);
  });

  it('predicts uniform geometry from segment 1 and the declared size', async () => {
    const post = buildPost({ segmentSizes: [100, 100, 100, 40] });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry).toEqual({
      segmentSize: 100,
      lastSegmentSize: 40,
      totalSize: 340,
      segmentCount: 4,
      uniform: true,
    });
  });

  it('handles a final segment that is exactly as long as the others', async () => {
    const post = buildPost({ segmentSizes: [100, 100] });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry.lastSegmentSize).toBe(100);
    expect(probe.geometry.uniform).toBe(true);
  });

  it('opens a single-part file, which carries no =ypart line at all', async () => {
    // nzb-file@1.1.18 reads props!.part.end unconditionally and throws a
    // TypeError here -- on exactly the .nfo and thumbnail you would fetch for
    // a cheap preview.
    const post = buildPost({ name: 'readme.nfo', segmentSizes: [37] });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry).toEqual({
      segmentSize: 37,
      lastSegmentSize: 37,
      totalSize: 37,
      segmentCount: 1,
      uniform: true,
    });
  });

  it('accepts a single-part file whose poster did include =ypart', async () => {
    const post = buildPost({
      segmentSizes: [37],
      declaredRanges: new Map([[0, [0, 37] as const]]),
    });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry.segmentSize).toBe(37);
  });

  it('refuses a file with no segments', async () => {
    const post = buildPost({ segmentSizes: [10] });
    const empty = { ...post.file, segments: [] };

    await expect(probeGeometry(empty, post.source)).rejects.toThrow(NzbGeometryError);
    expect(post.source.requestCount).toBe(0);
  });

  it('refuses a multi-segment file whose first article has no =ypart', async () => {
    // Without =ypart there is nothing that says where the part sits, and
    // guessing is the whole class of bug this package exists to avoid.
    const post = buildPost({
      segmentSizes: [100, 40],
      declaredRanges: new Map([[0, null]]),
    });

    await expect(probeGeometry(post.file, post.source)).rejects.toThrow(/=ypart/u);
  });

  it('refuses a first article that does not begin at offset zero', async () => {
    const post = buildPost({
      segmentSizes: [100, 40],
      declaredRanges: new Map([[0, [100, 200] as const]]),
    });

    await expect(probeGeometry(post.file, post.source)).rejects.toThrow(NzbGeometryError);
  });

  it('reports non-uniform when the declared size exceeds what the segments can hold', async () => {
    // Four 100-byte segments cannot hold 900 bytes, so the segments are not
    // all 100 bytes and arithmetic from segment 1 would place every one of
    // them wrong.
    const post = buildPost({ segmentSizes: [100, 100, 100, 40], declaredTotalSize: 900 });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry.uniform).toBe(false);
  });

  it('reports non-uniform when the declared size is smaller than the segments imply', async () => {
    const post = buildPost({ segmentSizes: [100, 100, 100, 40], declaredTotalSize: 150 });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry.uniform).toBe(false);
  });

  it('reports non-uniform when the prediction leaves the last segment empty', async () => {
    const post = buildPost({ segmentSizes: [100, 100], declaredTotalSize: 100 });

    const probe = await probeGeometry(post.file, post.source);

    expect(probe.geometry.uniform).toBe(false);
  });
});

const geometry: SegmentGeometry = {
  segmentSize: 100,
  lastSegmentSize: 40,
  totalSize: 340,
  segmentCount: 4,
  uniform: true,
};
const header = { name: 'payload.bin', size: 340 };

/** A decoded article carrying nothing but the fields verifyPlacement reads. */
function article(part: { begin: number; end: number } | null, length: number): YencArticle {
  return {
    header: { part: null, total: null, line: null, size: 340, name: 'payload.bin' },
    part,
    trailer: { size: length, part: null, crc32: null, pcrc32: null },
    data: Buffer.alloc(length),
    checksum: { expected: null, actual: 0, matches: null },
    sizeMatches: true,
  };
}

describe('verifyPlacement', () => {
  it('accepts an article that is where the geometry predicted', () => {
    expect(() => {
      verifyPlacement(article({ begin: 200, end: 300 }, 100), 3, geometry, header);
    }).not.toThrow();
  });

  it('accepts the short final segment', () => {
    expect(() => {
      verifyPlacement(article({ begin: 300, end: 340 }, 40), 4, geometry, header);
    }).not.toThrow();
  });

  it('rejects an article that begins somewhere else', () => {
    // This is the payoff for predicting: the prediction is checked against the
    // article's own header before any of its bytes are used, so a
    // variable-size post fails loudly instead of returning wrong bytes.
    expect(() => {
      verifyPlacement(article({ begin: 190, end: 290 }, 100), 3, geometry, header);
    }).toThrow(NzbGeometryError);
  });

  it('names the segment and both offsets in the error', () => {
    expect(() => {
      verifyPlacement(article({ begin: 190, end: 290 }, 100), 3, geometry, header);
    }).toThrow(/segment 3.*200.*190/su);
  });

  it('rejects an article that ends somewhere else', () => {
    expect(() => {
      verifyPlacement(article({ begin: 200, end: 250 }, 50), 3, geometry, header);
    }).toThrow(NzbGeometryError);
  });

  it('rejects a longer-than-predicted article that starts in the right place', () => {
    // The end check earns its keep here. This part begins where predicted and
    // carries more than enough bytes, so the length check waves it through --
    // but it spans 150 bytes, which means every segment after it sits 50 bytes
    // further along than the arithmetic believes.
    expect(() => {
      verifyPlacement(article({ begin: 200, end: 350 }, 150), 3, geometry, header);
    }).toThrow(/\[200, 300\).*\[200, 350\)/su);
  });

  it('rejects a missing =ypart on a multi-segment file', () => {
    expect(() => {
      verifyPlacement(article(null, 100), 3, geometry, header);
    }).toThrow(/=ypart/u);
  });

  it('accepts a missing =ypart on a single-segment file', () => {
    const single = { ...geometry, segmentCount: 1, segmentSize: 340, lastSegmentSize: 340 };

    expect(() => {
      verifyPlacement(article(null, 340), 1, single, header);
    }).not.toThrow();
  });

  it('rejects an article whose payload is shorter than its declared range', () => {
    // The range says 100 bytes; the body decoded to 60. Copying from it would
    // read past the end and pad the output with zeroes.
    expect(() => {
      verifyPlacement(article({ begin: 200, end: 300 }, 60), 3, geometry, header);
    }).toThrow(NzbGeometryError);
  });

  it('rejects an article declaring a different file size', () => {
    // Every article of a post repeats the whole-file size. A disagreement
    // means these articles are not all the same file.
    const wrong = {
      ...article({ begin: 200, end: 300 }, 100),
      header: { part: null, total: null, line: null, size: 999, name: 'payload.bin' },
    };

    expect(() => {
      verifyPlacement(wrong, 3, geometry, header);
    }).toThrow(/size/u);
  });

  it('accepts an article whose filename differs from segment 1', () => {
    // Obfuscated posts randomise =ybegin name= per article -- verified against
    // a real 1868-article post where all seven probed articles carried
    // different names and identical size= and =ypart values. Requiring the
    // names to agree rejects most of Usenet, and the size and placement checks
    // already cover what the name check was reaching for.
    const renamed = {
      ...article({ begin: 200, end: 300 }, 100),
      header: { part: null, total: null, line: null, size: 340, name: 'T08H0qZlxYZamAanLn' },
    };

    expect(() => {
      verifyPlacement(renamed, 3, geometry, header);
    }).not.toThrow();
  });
});
