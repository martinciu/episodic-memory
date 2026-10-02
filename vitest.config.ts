import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // setup.ts strips an inherited EPISODIC_MEMORY_DB_PATH (fork #14);
    // setup-isolated-config.ts points every config dir at a tmpdir (upstream #119/#131).
    setupFiles: ['test/setup.ts', 'test/setup-isolated-config.ts'],
    // bge-m3 (570M params) embeds noticeably slower on CPU than the original
    // bge-small — indexing fixtures in tests and beforeEach hooks needs more
    // headroom than the stock 30s/10s.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
