import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSink } from '../src/sink.ts';

let directory = '';
const target = (name = 'out.bin'): string => join(directory, name);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-sink-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('openSink, contiguous', () => {
  it('writes the range from offset zero', async () => {
    const sink = await openSink(target(), { sparse: false, declaredSize: 1000, rangeStart: 400 });
    await sink.write(400, Buffer.from('abcd'));
    await sink.close();

    expect(await readFile(target())).toEqual(Buffer.from('abcd'));
  });

  it('produces a file exactly as long as the range', async () => {
    const sink = await openSink(target(), {
      sparse: false,
      declaredSize: 1_000_000,
      rangeStart: 0,
    });
    await sink.write(0, Buffer.alloc(64, 1));
    await sink.close();

    expect((await stat(target())).size).toBe(64);
  });

  it('joins consecutive chunks in order', async () => {
    const sink = await openSink(target(), { sparse: false, declaredSize: 100, rangeStart: 10 });
    await sink.write(10, Buffer.from('one'));
    await sink.write(13, Buffer.from('two'));
    await sink.close();

    expect(await readFile(target())).toEqual(Buffer.from('onetwo'));
  });
});

describe('openSink, sparse', () => {
  it('gives the file its declared full length', async () => {
    // The point: ffmpeg gets one seekable input of the right size, whatever
    // fraction of it was actually fetched.
    const sink = await openSink(target(), { sparse: true, declaredSize: 1_000_000, rangeStart: 0 });
    await sink.write(0, Buffer.from('head'));
    await sink.close();

    expect((await stat(target())).size).toBe(1_000_000);
  });

  it('writes each chunk at its true offset', async () => {
    const sink = await openSink(target(), { sparse: true, declaredSize: 1000, rangeStart: 900 });
    await sink.write(900, Buffer.from('tail'));
    await sink.close();

    const contents = await readFile(target());
    expect(contents.subarray(900, 904)).toEqual(Buffer.from('tail'));
  });

  it('reads unwritten regions as zeroes', async () => {
    const sink = await openSink(target(), { sparse: true, declaredSize: 4096, rangeStart: 0 });
    await sink.write(0, Buffer.from('head'));
    await sink.write(4092, Buffer.from('tail'));
    await sink.close();

    const contents = await readFile(target());
    expect(contents.subarray(4, 4092).every((byte) => byte === 0)).toBe(true);
  });

  it('places a head and a tail fetch in one file, the moov case', async () => {
    // Segment 1 and segment N of a file whose moov atom could be at either end.
    const sink = await openSink(target(), { sparse: true, declaredSize: 10_000, rangeStart: 0 });
    await sink.write(0, Buffer.from('ftyp'));
    await sink.write(9996, Buffer.from('moov'));
    await sink.close();

    const contents = await readFile(target());
    expect(contents.subarray(0, 4)).toEqual(Buffer.from('ftyp'));
    expect(contents.subarray(9996)).toEqual(Buffer.from('moov'));
    expect(contents.length).toBe(10_000);
  });
});

describe('openSink, generally', () => {
  it('creates missing parent directories', async () => {
    const nested = join(directory, 'a', 'b', 'out.bin');
    const sink = await openSink(nested, { sparse: false, declaredSize: 4, rangeStart: 0 });
    await sink.write(0, Buffer.from('abcd'));
    await sink.close();

    expect(await readFile(nested)).toEqual(Buffer.from('abcd'));
  });

  it('truncates an existing file rather than writing into its gaps', async () => {
    // A rerun that fetches less than last time must not leave the previous
    // run's bytes lying in the holes, which would look like a complete file.
    await writeFile(target(), Buffer.alloc(5000, 0xff));

    const sink = await openSink(target(), { sparse: false, declaredSize: 5000, rangeStart: 0 });
    await sink.write(0, Buffer.from('new'));
    await sink.close();

    expect(await readFile(target())).toEqual(Buffer.from('new'));
  });
});
