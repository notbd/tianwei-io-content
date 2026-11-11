import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // each integration test boots PGlite and runs the migration chain first
    testTimeout: 60_000,
    // the PGlite database is created in a beforeEach; on a loaded machine that passes the 10 s default
    hookTimeout: 60_000,
  },
})
