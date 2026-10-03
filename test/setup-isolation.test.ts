import { describe, it, expect } from 'vitest';
import os from 'os';
import {
  getClaudeDir,
  getCodexDir,
  getCursorDir,
  getOmpDir,
  getOpencodeDataDir,
  getOpencodeDbPath,
  getSuperpowersDir,
} from '../src/paths.js';

/**
 * test/setup-isolated-config.ts must point every conversation source and the
 * config dir away from the developer's home. A source left on its default
 * reads real transcripts: a spawned `sync` once exported the developer's real
 * opencode sessions into a test tmpdir, one step short of summarizing them
 * through the real Claude API.
 */
describe('vitest setup isolates every harness source from the real home', () => {
  const home = os.homedir();
  const sources: Record<string, () => string> = {
    claude: getClaudeDir,
    codex: getCodexDir,
    cursor: getCursorDir,
    omp: getOmpDir,
    'opencode data dir': getOpencodeDataDir,
    'opencode db': getOpencodeDbPath,
    superpowers: getSuperpowersDir,
  };

  it.each(Object.entries(sources))('%s resolves outside the home directory', (_name, resolve) => {
    const dir = resolve();
    expect(dir.startsWith(home + '/')).toBe(false);
    expect(dir).toContain('episodic-memory-vitest-');
  });
});
