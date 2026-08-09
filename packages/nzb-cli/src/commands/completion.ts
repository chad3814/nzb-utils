import { COMMAND_SPECS, GLOBAL_FLAGS } from '../spec.ts';
import type { CommandSpec, FlagSpec, Shell, ValueKind } from '../spec.ts';

/**
 * `nzb completion <shell>` — print a completion script to stdout.
 *
 * Generated from {@link COMMAND_SPECS} rather than written by hand three times,
 * because a completion script that disagrees with the parser is worse than none
 * at all: it offers flags that do not exist and hides ones that do, and nothing
 * about it fails loudly.
 *
 * The scripts complete subcommands, the flags each one actually accepts,
 * `.nzb` files where an NZB is expected, directories for `--out`, and the fixed
 * choices for `--security`. Descriptions are included for zsh and fish, which
 * show them; bash has nowhere to put them.
 */
export function completion(shell: Shell): string {
  switch (shell) {
    case 'bash': {
      return bash();
    }
    case 'zsh': {
      return zsh();
    }
    default: {
      return fish();
    }
  }
}

const entries = (flags: Readonly<Record<string, FlagSpec>>): [string, FlagSpec][] =>
  Object.entries(flags);

/** Every flag a command accepts, its own plus the global ones. */
function flagsFor(spec: CommandSpec): [string, FlagSpec][] {
  return [...entries(spec.flags), ...entries(GLOBAL_FLAGS)];
}

function takesValue(kind: ValueKind): boolean {
  return kind !== 'none';
}

/** Single-quote for a POSIX shell, closing and reopening around any quote. */
function quote(text: string): string {
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

function bashCases(): string {
  const cases = Object.entries(COMMAND_SPECS)
    .map(([name, spec]) => {
      const flags = flagsFor(spec)
        .map(([flag]) => `--${flag}`)
        .join(' ');
      // `_filedir` comes from bash-completion and descends directories properly;
      // the compgen fallback is flat but better than offering nothing.
      const positional =
        spec.positional === 'nzb-file'
          ? `_nzb_nzbfiles`
          : spec.positional === 'files'
            ? `if declare -F _filedir >/dev/null; then _filedir; else COMPREPLY=($(compgen -f -- "$cur")); fi`
            : spec.positional === 'shell'
              ? `COMPREPLY=($(compgen -W 'bash zsh fish' -- "$cur"))`
              : 'COMPREPLY=()';

      return `    ${name})
      if [[ $cur == -* ]]; then
        COMPREPLY=($(compgen -W '${flags}' -- "$cur"))
      else
        ${positional}
      fi
      ;;`;
    })
    .join('\n');

  return cases;
}

/**
 * Value completion, keyed on the previous word — which is how bash sees
 * `--out <TAB>`. Directories and fixed choices are worth the special case;
 * plain text falls through to the default.
 */
function bashValueCases(): string {
  const valueCases = new Set<string>();
  for (const spec of Object.values(COMMAND_SPECS)) {
    for (const [flag, meta] of entries(spec.flags)) {
      if (meta.value === 'directory') {
        valueCases.add(`      --${flag}) _nzb_dirs; return ;;`);
      } else if (meta.value === 'file') {
        valueCases.add(`      --${flag}) _nzb_files; return ;;`);
      } else if (typeof meta.value === 'object') {
        valueCases.add(
          `      --${flag}) COMPREPLY=($(compgen -W '${meta.value.choices.join(' ')}' -- "$cur")); return ;;`,
        );
      }
    }
  }

  return [...valueCases].join('\n');
}

/**
 * File-completion helpers, shared by every command's branch.
 *
 * `_filedir` comes from bash-completion and descends directories properly. The
 * fallbacks matter more than they look: without bash-completion loaded a bare
 * `compgen -f` offers every file in the directory, so the .nzb case filters and
 * still offers directories rather than being merely present.
 */
const BASH_HELPERS = `# bash completion for nzb. Install with:
#   nzb completion bash > /usr/local/etc/bash_completion.d/nzb
# or source it directly from your profile:
#   source <(nzb completion bash)

_nzb_dirs() {
  if declare -F _filedir >/dev/null; then _filedir -d; else COMPREPLY=($(compgen -d -- "$cur")); fi
}

_nzb_files() {
  if declare -F _filedir >/dev/null; then _filedir; else COMPREPLY=($(compgen -f -- "$cur")); fi
}

_nzb_nzbfiles() {
  if declare -F _filedir >/dev/null; then
    _filedir nzb
  else
    COMPREPLY=($(compgen -f -X '!*.nzb' -- "$cur") $(compgen -d -- "$cur"))
  fi
}
`;

function bash(): string {
  const commands = Object.keys(COMMAND_SPECS).join(' ');

  return `${BASH_HELPERS}
_nzb() {
  local cur prev command i
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # The first non-flag word after the program name is the subcommand.
  for (( i=1; i < COMP_CWORD; i++ )); do
    case "\${COMP_WORDS[i]}" in
      -*) ;;
      *) command="\${COMP_WORDS[i]}"; break ;;
    esac
  done

  if [[ -n $command ]]; then
    case "$prev" in
${bashValueCases()}
    esac
  fi

  case "$command" in
${bashCases()}
    *)
      if [[ $cur == -* ]]; then
        COMPREPLY=($(compgen -W '--help --version' -- "$cur"))
      else
        COMPREPLY=($(compgen -W '${commands}' -- "$cur"))
      fi
      ;;
  esac
}

complete -F _nzb nzb
`;
}

function zshPerCommand(): string {
  return Object.entries(COMMAND_SPECS)
    .map(([name, spec]) => {
      const args = flagsFor(spec)
        .map(([flag, meta]) => {
          const description = meta.describe.replaceAll('[', '\\[').replaceAll(']', '\\]');
          if (!takesValue(meta.value)) {
            return `        ${quote(`--${flag}[${description}]`)}`;
          }
          const action =
            meta.value === 'directory'
              ? ':directory:_files -/'
              : meta.value === 'file'
                ? ':file:_files'
                : typeof meta.value === 'object'
                  ? `:value:(${meta.value.choices.join(' ')})`
                  : ':value:';
          return `        ${quote(`--${flag}[${description}]${action}`)}`;
        })
        .join(' \\\n');

      const positional =
        spec.positional === 'nzb-file'
          ? ' \\\n        \'*:nzb file:_files -g "*.nzb"\''
          : spec.positional === 'files'
            ? " \\\n        '*:article:_files'"
            : spec.positional === 'shell'
              ? " \\\n        '1:shell:(bash zsh fish)'"
              : '';

      return `      ${name})
        _arguments \\
${args}${positional}
        ;;`;
    })
    .join('\n');
}

function zsh(): string {
  const commandList = Object.entries(COMMAND_SPECS)
    .map(([name, spec]) => `    ${quote(`${name}:${spec.describe}`)}`)
    .join(' \\\n');

  return `#compdef nzb
# zsh completion for nzb. Install with:
#   nzb completion zsh > "\${fpath[1]}/_nzb"
# then restart the shell, or source it directly:
#   source <(nzb completion zsh)

_nzb() {
  local context state line
  typeset -A opt_args

  _arguments -C \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe -t commands 'nzb command' _nzb_commands
      ;;
    args)
      case $line[1] in
${zshPerCommand()}
      esac
      ;;
  esac
}

_nzb_commands=(
${commandList}
)

_nzb "$@"
`;
}

function fish(): string {
  const lines: string[] = [
    '# fish completion for nzb. Install with:',
    '#   nzb completion fish > ~/.config/fish/completions/nzb.fish',
    '',
    '# No file completion unless a rule below asks for it, so `nzb <TAB>` offers',
    '# commands rather than the contents of the working directory.',
    'complete -c nzb -f',
    '',
    'function __nzb_no_command',
    '  not __fish_seen_subcommand_from ' + Object.keys(COMMAND_SPECS).join(' '),
    'end',
    '',
  ];

  for (const [name, spec] of Object.entries(COMMAND_SPECS)) {
    lines.push(`complete -c nzb -n __nzb_no_command -a ${name} -d ${quote(spec.describe)}`);
  }
  lines.push('');

  for (const [name, spec] of Object.entries(COMMAND_SPECS)) {
    const condition = `-n '__fish_seen_subcommand_from ${name}'`;

    for (const [flag, meta] of flagsFor(spec)) {
      const parts = [`complete -c nzb ${condition} -l ${flag} -d ${quote(meta.describe)}`];
      if (meta.value === 'directory') {
        parts.push('-r -a "(__fish_complete_directories)"');
      } else if (meta.value === 'file') {
        parts.push('-r -F');
      } else if (typeof meta.value === 'object') {
        parts.push(`-x -a ${quote(meta.value.choices.join(' '))}`);
      } else if (takesValue(meta.value)) {
        parts.push('-x');
      }
      lines.push(parts.join(' '));
    }

    if (spec.positional === 'nzb-file') {
      lines.push(`complete -c nzb ${condition} -a "(__fish_complete_suffix .nzb)" -d 'NZB file'`);
    } else if (spec.positional === 'files') {
      lines.push(`complete -c nzb ${condition} -F`);
    } else if (spec.positional === 'shell') {
      lines.push(`complete -c nzb ${condition} -x -a 'bash zsh fish'`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
