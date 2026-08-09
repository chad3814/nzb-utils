import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { completion } from '../src/commands/completion.ts';
import { COMMAND_SPECS, GLOBAL_FLAGS, SHELLS } from '../src/spec.ts';
import { OPTION_NAMES } from '../src/parse-args.ts';

let directory = '';
/** The directory completion runs *in*, kept clear of the test's own files. */
let work = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'nzb-completion-'));
  work = join(directory, 'work');
  mkdirSync(work, { recursive: true });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Whether a shell is on this machine, so a missing one skips rather than fails. */
function has(program: string): boolean {
  try {
    execFileSync('which', [program], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('the spec agrees with the parser', () => {
  it('declares every flag the parser accepts', () => {
    // The whole risk of a second view of the flags. A flag added to parseArgs
    // and not here would silently never be offered.
    const declared = new Set<string>(Object.keys(GLOBAL_FLAGS));
    for (const spec of Object.values(COMMAND_SPECS)) {
      for (const flag of Object.keys(spec.flags)) {
        declared.add(flag);
      }
    }

    expect([...declared].toSorted()).toEqual([...OPTION_NAMES].toSorted());
  });

  it('declares no flag the parser would reject', () => {
    for (const [name, spec] of Object.entries(COMMAND_SPECS)) {
      for (const flag of Object.keys(spec.flags)) {
        expect(OPTION_NAMES, `${name} offers --${flag}`).toContain(flag);
      }
    }
  });
});

describe('generated scripts', () => {
  it('offers every command in every shell', () => {
    for (const shell of SHELLS) {
      const script = completion(shell);
      for (const name of Object.keys(COMMAND_SPECS)) {
        expect(script, `${shell} is missing ${name}`).toContain(name);
      }
    }
  });

  it('scopes flags to the command that accepts them', () => {
    // `nzb inspect --sparse` is not a thing, and completion should not imply it.
    const fish = completion('fish');
    const inspectLines = fish
      .split('\n')
      .filter((line) => line.includes('__fish_seen_subcommand_from inspect'));

    expect(inspectLines.some((line) => line.includes('-l json'))).toBe(true);
    expect(inspectLines.some((line) => line.includes('-l sparse'))).toBe(false);
    expect(inspectLines.some((line) => line.includes('-l host'))).toBe(false);
  });

  it('gives network commands their server flags', () => {
    const fish = completion('fish');
    const getLines = fish
      .split('\n')
      .filter((line) => line.includes('__fish_seen_subcommand_from get'));

    for (const flag of ['host', 'port', 'connections', 'pass-file']) {
      expect(
        getLines.some((line) => line.includes(`-l ${flag}`)),
        flag,
      ).toBe(true);
    }
  });

  it('offers the fixed choices for --security', () => {
    for (const shell of SHELLS) {
      expect(completion(shell), shell).toMatch(/implicit.*starttls.*none|starttls/su);
    }
  });

  it('never offers a flag that would take a secret in argv', () => {
    // --pass-env and --pass-file are fine: they name where a secret lives. What
    // must never be offered is a flag that takes the secret itself, since argv
    // is world-readable through ps. `\b` is the wrong boundary here -- it
    // matches inside --pass-env at the hyphen -- so this asserts that --pass
    // and --password appear only as a prefix of a longer, safe flag.
    for (const shell of SHELLS) {
      const script = completion(shell);
      expect(script, shell).not.toMatch(/--password(?![-\w])/u);
      expect(script, shell).not.toMatch(/--pass(?![-\w])/u);
    }
  });

  it('does offer the flags that name where a secret lives', () => {
    // The counterpart: proving the assertion above is not vacuous by being
    // over-broad and matching nothing at all.
    expect(completion('fish')).toContain('-l pass-env');
    expect(completion('fish')).toContain('-l pass-file');
  });

  it('completes .nzb files where an NZB is expected', () => {
    expect(completion('zsh')).toContain('*.nzb');
    expect(completion('fish')).toContain('.nzb');
    expect(completion('bash')).toContain('_filedir nzb');
  });
});

/**
 * Drive the bash script the way bash would, and return what it offers.
 *
 * String-matching the generated text only proves the generator emitted
 * something; this proves the shell agrees. It is also the check that would have
 * caught a script whose syntax was broken by a stray backtick, which
 * string-matching happily passed.
 */
function offers(line: string): string[] {
  const driver = `
source "$1"
line="$2"
read -r -a words <<< "$line"
if [[ $line == *" " ]]; then words+=(""); fi
COMP_WORDS=("\${words[@]}")
COMP_CWORD=$(( \${#words[@]} - 1 ))
COMPREPLY=()
_nzb
printf '%s\n' "\${COMPREPLY[@]}"
`;
  // The harness lives outside the directory being completed in. Writing the
  // script next to the fixtures put nzb.bash and drive.bash into every file
  // listing, which is a fine way to make a completion test lie to you.
  const script = join(directory, 'nzb.bash');
  writeFileSync(script, completion('bash'));
  const driverPath = join(directory, 'drive.bash');
  writeFileSync(driverPath, driver);

  return execFileSync('bash', [driverPath, script, line], { encoding: 'utf8', cwd: work })
    .split('\n')
    .filter((word) => word !== '');
}

describe('bash completion, driven through bash', () => {
  beforeEach(() => {
    mkdirSync(join(work, 'sub'), { recursive: true });
    writeFileSync(join(work, 'a.nzb'), '');
    writeFileSync(join(work, 'b.txt'), '');
  });

  it('offers the commands with nothing typed', () => {
    expect(offers('nzb ')).toEqual(Object.keys(COMMAND_SPECS));
  });

  it('offers only the flags a command accepts', () => {
    expect(offers('nzb inspect --')).toEqual(['--json', '--help', '--version']);
  });

  it('offers the server flags to a command that connects', () => {
    const flags = offers('nzb get --');
    expect(flags).toContain('--sparse');
    expect(flags).toContain('--host');
    expect(flags).not.toContain('--sample');
  });

  it('completes the fixed choices for --security', () => {
    expect(offers('nzb get --security ')).toEqual(['implicit', 'starttls', 'none']);
  });

  it('completes directories, not files, for --out', () => {
    expect(offers('nzb get --out ')).toEqual(['sub']);
  });

  it('completes only .nzb files where an NZB is expected', () => {
    // The fallback path, with bash-completion not loaded. Offering b.txt here
    // is not wrong exactly, but it is noise on a directory full of downloads.
    expect(offers('nzb get ').toSorted()).toEqual(['a.nzb', 'sub']);
  });

  it('completes any file for decode, which takes raw articles', () => {
    expect(offers('nzb decode ').toSorted()).toEqual(['a.nzb', 'b.txt', 'sub']);
  });

  it('completes the shell names for completion', () => {
    expect(offers('nzb completion ')).toEqual(['bash', 'zsh', 'fish']);
  });
});

describe('the scripts are valid for their shell', () => {
  it('bash parses the script', () => {
    if (!has('bash')) {
      return;
    }
    const path = join(directory, 'nzb.bash');
    // `bash -n` parses without executing, which is the check that matters:
    // a syntax error here breaks the user's whole shell startup.
    execFileSync('bash', [
      '-c',
      `cat > ${path} <<'EOF'\n${completion('bash')}\nEOF\nbash -n ${path}`,
    ]);
  });

  it('zsh parses the script', async () => {
    if (!has('zsh')) {
      return;
    }
    const path = join(directory, '_nzb');
    await writeFile(path, completion('zsh'));
    execFileSync('zsh', ['-n', path]);
  });

  it('fish parses the script', async () => {
    if (!has('fish')) {
      return;
    }
    const path = join(directory, 'nzb.fish');
    await writeFile(path, completion('fish'));
    execFileSync('fish', ['--no-execute', path]);
  });
});
