import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SYNC_CLI = join(REPO_ROOT, 'dist', 'sync-cli.js');

/**
 * The background path forks a detached sync that outlives spawnSync. Removing
 * testDir while it still runs lets it recreate dirs under the deleted path,
 * leaking an episodic-memory-disable-auto-sync-* dir per run. Wait for it.
 */
async function waitForExit(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

describe('sync-cli auto-sync off switch (#163)', () => {
  let testDir: string;
  let envOverrides: Record<string, string>;
  let backgroundPid: number | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'episodic-memory-disable-auto-sync-'));
    mkdirSync(join(testDir, 'projects'), { recursive: true });
    mkdirSync(join(testDir, 'config'), { recursive: true });

    envOverrides = {
      TEST_PROJECTS_DIR: join(testDir, 'projects'),
      TEST_DB_PATH: join(testDir, 'test.db'),
      EPISODIC_MEMORY_CONFIG_DIR: join(testDir, 'config'),
    };
  });

  afterEach(async () => {
    if (backgroundPid !== undefined) {
      await waitForExit(backgroundPid);
      backgroundPid = undefined;
    }
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('exits 0 silently and skips the background sync when EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1 is set with --background', () => {
    const result = spawnSync(process.execPath, [SYNC_CLI, '--background'], {
      env: {
        ...process.env,
        ...envOverrides,
        EPISODIC_MEMORY_DISABLE_AUTO_SYNC: '1',
        EPISODIC_MEMORY_SUMMARIZER_GUARD: undefined as any,
      },
      timeout: 5000,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/auto-sync disabled/i);
    expect(result.stdout).not.toMatch(/Sync started in background/);
  });

  it('does not disable an explicit foreground sync when EPISODIC_MEMORY_DISABLE_AUTO_SYNC=1 is set without --background', () => {
    const result = spawnSync(process.execPath, [SYNC_CLI], {
      env: {
        ...process.env,
        ...envOverrides,
        EPISODIC_MEMORY_DISABLE_AUTO_SYNC: '1',
        EPISODIC_MEMORY_SUMMARIZER_GUARD: undefined as any,
      },
      timeout: 5000,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/auto-sync disabled/i);
  });

  it('runs the background sync normally when EPISODIC_MEMORY_DISABLE_AUTO_SYNC is unset', () => {
    const result = spawnSync(process.execPath, [SYNC_CLI, '--background'], {
      env: {
        ...process.env,
        ...envOverrides,
        EPISODIC_MEMORY_DISABLE_AUTO_SYNC: undefined as any,
        EPISODIC_MEMORY_SUMMARIZER_GUARD: undefined as any,
      },
      timeout: 5000,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    const started = result.stdout.match(/Sync started in background \(pid (\d+)\)/);
    expect(started).not.toBeNull();
    backgroundPid = Number(started![1]);
  });
});
