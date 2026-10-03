import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll } from 'vitest';

/**
 * Isolate every test run from the developer's real ~/.config/superpowers.
 * Without this, getSuperpowersDir()'s ensureDir side effect creates real dirs
 * (and sometimes a real db.sqlite) when EPISODIC_MEMORY_CONFIG_DIR is unset.
 * See https://github.com/obra/episodic-memory/issues/119
 */
const isolatedRoot = mkdtempSync(join(tmpdir(), 'episodic-memory-vitest-'));

process.env.EPISODIC_MEMORY_CONFIG_DIR = join(isolatedRoot, 'superpowers');
process.env.CLAUDE_CONFIG_DIR = join(isolatedRoot, 'claude');
process.env.CODEX_HOME = join(isolatedRoot, 'codex');

// Every other conversation source too (test/setup-isolation.test.ts). Left on
// their defaults, a spawned `sync` reads the developer's real Cursor, Oh My Pi
// and opencode data — it once exported real opencode sessions into a test
// tmpdir, one step short of summarizing them through the real Claude API.
process.env.CURSOR_HOME = join(isolatedRoot, 'cursor');
process.env.OMP_HOME = join(isolatedRoot, 'omp');
// opencode resolves EPISODIC_MEMORY_OPENCODE_* > OPENCODE_DATA_DIR > XDG_DATA_HOME;
// drop inherited overrides and pin the lowest-precedence one, so tests that set
// a higher-precedence variable themselves still win.
delete process.env.EPISODIC_MEMORY_OPENCODE_DATA_DIR;
delete process.env.EPISODIC_MEMORY_OPENCODE_DB_PATH;
delete process.env.EPISODIC_MEMORY_OPENCODE_TRANSCRIPT_DIR;
delete process.env.OPENCODE_DATA_DIR;
process.env.XDG_DATA_HOME = join(isolatedRoot, 'xdg-data');

// Clear any ambient summarizer-billing signals so tests get deterministic
// cost-guard (#104) and timeout (#160) behavior regardless of the developer's
// shell. No test needs a real API key — they all mock the SDK query(). Tests
// that exercise the metered guard set these vars in their own bodies.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.EPISODIC_MEMORY_ALLOW_METERED_API;
delete process.env.EPISODIC_MEMORY_API_BASE_URL;
delete process.env.EPISODIC_MEMORY_API_TOKEN;
delete process.env.EPISODIC_MEMORY_SUMMARY_TIMEOUT_MS;

// setupFiles run once per test file, so without this every `npm test` leaves
// one episodic-memory-vitest-* dir per file behind in the OS tmpdir.
afterAll(() => {
  rmSync(isolatedRoot, { recursive: true, force: true });
});
