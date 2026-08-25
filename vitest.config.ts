import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file gets its own process. `test/race.test.ts` opens several real
    // connections to one WAL file on purpose, and must not share state.
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
