import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspect } from '../src/commands/inspect.ts';
import { CliError } from '../src/errors.ts';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-inspect-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Two files: a three-article mkv and a single-article nfo. */
const NZB = `<?xml version="1.0" encoding="utf-8"?>
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="title">Example Release</meta></head>
  <file poster="p &lt;p@example.invalid&gt;" date="1767225600" subject="Example [1/2] - &quot;show.mkv&quot; yEnc (1/3)">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
      <segment bytes="1000" number="1">a1@example.invalid</segment>
      <segment bytes="1000" number="2">a2@example.invalid</segment>
      <segment bytes="500" number="3">a3@example.invalid</segment>
    </segments>
  </file>
  <file poster="p &lt;p@example.invalid&gt;" date="1767225600" subject="Example [2/2] - &quot;show.nfo&quot; yEnc (1/1)">
    <groups><group>alt.binaries.other</group></groups>
    <segments><segment bytes="300" number="1">b1@example.invalid</segment></segments>
  </file>
</nzb>`;

async function write(xml: string, name = 'test.nzb'): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, xml);
  return path;
}

describe('inspect', () => {
  it('reports file, article and byte totals', async () => {
    const output = await inspect({ nzbPath: await write(NZB), json: false });

    expect(output).toContain('2 files');
    expect(output).toContain('4 articles');
  });

  it('reports the union of groups across files', async () => {
    const output = await inspect({ nzbPath: await write(NZB), json: false });

    expect(output).toContain('alt.binaries.test');
    expect(output).toContain('alt.binaries.other');
  });

  it('reports head metadata', async () => {
    const output = await inspect({ nzbPath: await write(NZB), json: false });

    expect(output).toContain('title: Example Release');
  });

  it('labels sizes as encoded, since an NZB knows no other kind', async () => {
    // 2800 encoded bytes here. Presenting that as a file size is the mistake
    // this line exists to avoid.
    const output = await inspect({ nzbPath: await write(NZB), json: false });

    expect(output).toMatch(/encoded/u);
  });

  it('flags a single-article file', async () => {
    // The case nzb-file throws a TypeError on, and the cheapest thing to fetch.
    const output = await inspect({ nzbPath: await write(NZB), json: false });

    expect(output).toContain('single');
  });

  it('names the subject-derived name as advisory', async () => {
    const output = await inspect({ nzbPath: await write(NZB), json: false });

    expect(output).toContain('advisory');
    expect(output).toContain('show.mkv');
  });

  it('warns about non-contiguous numbering without calling it missing', async () => {
    const gapped = NZB.replace('number="2"', 'number="7"');

    const output = await inspect({ nzbPath: await write(gapped), json: false });

    expect(output).toContain('non-contiguous');
    expect(output).toContain('nzb stat');
  });

  it('says nothing about gaps when there are none', async () => {
    const output = await inspect({ nzbPath: await write(NZB), json: false });

    expect(output).not.toContain('non-contiguous');
  });

  it('emits parseable JSON with --json', async () => {
    const output = await inspect({ nzbPath: await write(NZB), json: true });

    const parsed: unknown = JSON.parse(output);
    expect(parsed).toMatchObject({
      totals: { files: 2, segments: 4, encodedBytes: 2800 },
      groups: ['alt.binaries.test', 'alt.binaries.other'],
    });
  });

  it('names the byte total "encodedBytes" in JSON too', async () => {
    const output = await inspect({ nzbPath: await write(NZB), json: true });

    expect(output).toContain('encodedBytes');
    expect(output).not.toMatch(/"size"|"bytes":/u);
  });

  it('fails helpfully on a missing file', async () => {
    await expect(inspect({ nzbPath: join(directory, 'absent.nzb'), json: false })).rejects.toThrow(
      CliError,
    );
  });

  it('fails helpfully on a file that is not an NZB', async () => {
    const path = await write('not xml at all', 'bad.nzb');

    await expect(inspect({ nzbPath: path, json: false })).rejects.toThrow(CliError);
  });

  it('names the offending file when parsing fails', async () => {
    const path = await write('<nzb><file></nzb>', 'broken.nzb');

    await expect(inspect({ nzbPath: path, json: false })).rejects.toThrow(/broken\.nzb/u);
  });
});
