import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');

describe('summarizer title-stub E2E check (#31)', () => {
  it('exposes an opt-in npm script', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['test:summarizer-title-e2e']).toBe('node scripts/summarizer-title-e2e.js');
  });

  it('gates on real auth, uses the product query options, and keeps the non-vacuous control run', () => {
    const scriptPath = join(REPO_ROOT, 'scripts/summarizer-title-e2e.js');
    expect(existsSync(scriptPath)).toBe(true);

    const script = readFileSync(scriptPath, 'utf-8');
    expect(script).toContain('EPISODIC_MEMORY_RUN_CLAUDE_E2E');
    expect(script).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC');
    expect(script).toContain('buildSummarizerQueryOptions');
    expect(script).toContain('control produced no stub');
  });
});
