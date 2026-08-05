import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // TEMPORARY: remove once the first package lands its tests. Every package
    // is expected to ship unit tests before its `private` flag is cleared.
    passWithNoTests: true,
  },
});
