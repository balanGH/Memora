import { defineConfig } from 'vitest/config'

// Unit tests for pure renderer logic (no DOM needed).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
