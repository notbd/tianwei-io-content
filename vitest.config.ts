import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // each integration test boots PGlite and runs the migration chain first
    testTimeout: 20_000,
  },
})
