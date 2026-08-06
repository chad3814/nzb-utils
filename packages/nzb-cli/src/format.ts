/**
 * Output helpers.
 *
 * Human output goes to stdout as aligned columns; anything advisory or
 * progress-related goes to stderr, so `nzb inspect --json … | jq` and
 * `nzb get … > file` both work without the report contaminating the data.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

/** Human-readable size. Binary units, labelled as binary units. */
export function bytes(count: number): string {
  let value = count;
  let unit = 0;

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit] ?? 'B'}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * Render rows as aligned columns.
 *
 * The last column is never padded, so a long trailing filename does not leave
 * a wall of trailing spaces in a terminal or a pasted log.
 */
export function table(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return '';
  }

  const widths: number[] = [];
  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    }
  }

  return rows
    .map((row) =>
      row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
