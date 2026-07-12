import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The `electron` module only exists inside a running Electron process. Any
// main-process file that does `import { app } from 'electron'` would throw the
// moment Vitest loaded it, so we alias the bare specifier to a dumb stand-in
// (src/main/__mocks__/electron.ts). Tests written under this harness therefore
// target PURE logic only — see that file's header for the rationale.
const electronMock = fileURLToPath(new URL('./src/main/__mocks__/electron.ts', import.meta.url))

export default defineConfig({
  test: {
    // Main-process modules are Node code; renderer helpers covered here are
    // pure (no DOM). A DOM-dependent test can opt in per-file with a
    // `// @vitest-environment jsdom` docblock once jsdom is added.
    environment: 'node',
    // Picks up both `src/main/__tests__/*.test.ts` and any co-located
    // `src/**/*.test.ts` other work lands (main, renderer, shared).
    include: ['src/**/*.{test,spec}.{ts,tsx}']
  },
  resolve: {
    alias: {
      electron: electronMock,
      // Mirror electron.vite.config.ts so renderer/shared helper tests can use
      // the same import aliases the app does.
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url))
    }
  }
})
