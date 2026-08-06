#!/usr/bin/env node
import { run } from './run.ts';

/**
 * Process entry point. Everything of substance is in `run.ts`, which takes its
 * argv and its output streams as arguments so it can be driven from a test
 * without spawning anything.
 */
const code = await run(process.argv.slice(2), {
  out: (text: string): void => {
    process.stdout.write(`${text}\n`);
  },
  err: (text: string): void => {
    process.stderr.write(`${text}\n`);
  },
});

// exitCode rather than exit(): stdout to a pipe may still be draining, and a
// tool that truncates its own output under `| head` is a tool people stop
// trusting.
process.exitCode = code;
