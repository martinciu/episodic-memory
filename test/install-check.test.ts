import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { findMissingDeps, ensureDepsInstalled, INSTALL_LOCK_DIRNAME, REQUIRED_PACKAGES } from '../cli/install-check.js';

function stagePackage(nodeModules: string, name: string, manifest: object = { name, version: '0.0.0' }): void {
  const dir = join(nodeModules, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest), 'utf-8');
}

describe('findMissingDeps — wrapper install-health probe (#95 Bug 1)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'episodic-memory-install-check-'));
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('returns the full required-packages list when node_modules is missing entirely', () => {
    const missing = findMissingDeps(testDir);
    expect(missing).toEqual([...REQUIRED_PACKAGES]);
  });

  it('returns the full list when node_modules is empty (recently-created folder)', () => {
    mkdirSync(join(testDir, 'node_modules'), { recursive: true });
    expect(findMissingDeps(testDir)).toEqual([...REQUIRED_PACKAGES]);
  });

  it('returns an empty list when every required package has a package.json', () => {
    const nodeModules = join(testDir, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
    for (const pkg of REQUIRED_PACKAGES) {
      stagePackage(nodeModules, pkg);
    }
    expect(findMissingDeps(testDir)).toEqual([]);
  });

  it('flags the partial-extraction case where a package directory exists but its package.json is missing (the reporter\'s exact failure on Windows 11)', () => {
    const nodeModules = join(testDir, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
    for (const pkg of REQUIRED_PACKAGES) {
      stagePackage(nodeModules, pkg);
    }
    // Simulate the bug from #95: better-sqlite3 directory exists with `deps/` and `LICENSE` but no package.json.
    const broken = join(nodeModules, 'better-sqlite3');
    rmSync(join(broken, 'package.json'));
    mkdirSync(join(broken, 'deps'), { recursive: true });
    writeFileSync(join(broken, 'LICENSE'), 'MIT', 'utf-8');

    expect(findMissingDeps(testDir)).toEqual(['better-sqlite3']);
  });

  it('returns multiple missing packages so the operator can see the full scope of damage in one log line', () => {
    const nodeModules = join(testDir, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
    // Only stage two of the required packages, leaving the rest missing.
    stagePackage(nodeModules, '@anthropic-ai/claude-agent-sdk');
    stagePackage(nodeModules, 'sqlite-vec');

    const missing = findMissingDeps(testDir);
    expect(missing).toContain('better-sqlite3');
    expect(missing).toContain('@huggingface/transformers');
    expect(missing).toContain('onnxruntime-node');
    expect(missing).not.toContain('@anthropic-ai/claude-agent-sdk');
    expect(missing).not.toContain('sqlite-vec');
  });

  it('does not require optional / OS-specific deps (sharp, fsevents) — those are excluded by design', () => {
    const nodeModules = join(testDir, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
    for (const pkg of REQUIRED_PACKAGES) {
      stagePackage(nodeModules, pkg);
    }
    // sharp and fsevents are NOT staged — should still report no missing deps.
    expect(findMissingDeps(testDir)).toEqual([]);
    expect(REQUIRED_PACKAGES).not.toContain('sharp');
    expect(REQUIRED_PACKAGES).not.toContain('fsevents');
  });
});

describe('ensureDepsInstalled — self-heal shared by the MCP wrapper and the CLI (#17)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'episodic-memory-ensure-deps-'));
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  function stageAll(root: string): void {
    const nodeModules = join(root, 'node_modules');
    mkdirSync(nodeModules, { recursive: true });
    for (const pkg of REQUIRED_PACKAGES) {
      stagePackage(nodeModules, pkg);
    }
  }

  const lockDir = () => join(testDir, INSTALL_LOCK_DIRNAME);
  const quiet = { log: () => {} };

  it('returns false without invoking the installer when every required package is present', async () => {
    stageAll(testDir);
    let called = 0;
    const result = await ensureDepsInstalled(testDir, { ...quiet, installer: async () => { called++; } });
    expect(result).toBe(false);
    expect(called).toBe(0);
  });

  it('runs the installer once and returns true when packages are missing', async () => {
    const calls: string[] = [];
    const result = await ensureDepsInstalled(testDir, {
      ...quiet,
      installer: async (root: string) => { calls.push(root); stageAll(root); },
    });
    expect(result).toBe(true);
    expect(calls).toEqual([testDir]);
    expect(existsSync(lockDir())).toBe(false);
  });

  it('rejects when the installer completes but required packages are still missing (partial extraction, #95)', async () => {
    await expect(
      ensureDepsInstalled(testDir, { ...quiet, installer: async () => {} })
    ).rejects.toThrow(/still missing/);
    expect(existsSync(lockDir())).toBe(false);
  });

  it('releases the lock when the installer fails', async () => {
    await expect(
      ensureDepsInstalled(testDir, { ...quiet, installer: async () => { throw new Error('npm exploded'); } })
    ).rejects.toThrow(/npm exploded/);
    expect(existsSync(lockDir())).toBe(false);
  });

  it('waits on a concurrent fresh lock and skips its own install when the other process heals the deps', async () => {
    mkdirSync(lockDir(), { recursive: true });
    let called = 0;
    const pending = ensureDepsInstalled(testDir, {
      ...quiet,
      pollMs: 25,
      waitTimeoutMs: 2000,
      installer: async () => { called++; },
    });
    // Simulate the other process finishing: stage deps, then release its lock.
    setTimeout(() => { stageAll(testDir); rmSync(lockDir(), { recursive: true, force: true }); }, 60);
    const result = await pending;
    expect(result).toBe(false);
    expect(called).toBe(0);
  });

  it('steals a stale lock (dead installer) and installs', async () => {
    mkdirSync(lockDir(), { recursive: true });
    const staleEpoch = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(lockDir(), staleEpoch, staleEpoch);
    let called = 0;
    const result = await ensureDepsInstalled(testDir, {
      ...quiet,
      pollMs: 25,
      installer: async (root: string) => { called++; stageAll(root); },
    });
    expect(result).toBe(true);
    expect(called).toBe(1);
  });

  it('rejects with a clear message when a fresh foreign lock is never released within the wait timeout', async () => {
    mkdirSync(lockDir(), { recursive: true });
    await expect(
      ensureDepsInstalled(testDir, { ...quiet, pollMs: 25, waitTimeoutMs: 120, installer: async () => {} })
    ).rejects.toThrow(/another install/i);
  });
});

describe('episodic-memory CLI dispatcher — dependency self-heal before dist import (#17)', () => {
  let pluginRoot: string;
  let fakeBin: string;
  const cliPath = join(__dirname, '../cli/episodic-memory.js');

  beforeEach(() => {
    pluginRoot = mkdtempSync(join(tmpdir(), 'episodic-memory-cli-root-'));
    fakeBin = mkdtempSync(join(tmpdir(), 'episodic-memory-fake-npm-'));
  });

  afterEach(() => {
    for (const dir of [pluginRoot, fakeBin]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  function writeFakeNpm(script: string): void {
    const npmPath = join(fakeBin, 'npm');
    writeFileSync(npmPath, `#!/bin/sh\n${script}\n`, 'utf-8');
    chmodSync(npmPath, 0o755);
  }

  function runCli(args: string[]) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        // Keep the spawned sync-cli inert (exits 0 immediately) so the happy
        // path never touches the real archive/index.
        EPISODIC_MEMORY_SUMMARIZER_GUARD: '1',
      },
      encoding: 'utf-8',
      timeout: 30_000,
    });
  }

  it('fails with one clear line — not ERR_MODULE_NOT_FOUND — when deps are missing and npm install fails', () => {
    writeFakeNpm('echo "npm install failed (fake)" >&2; exit 1');
    const run = runCli(['sync', '--background']);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/episodic-memory: dependency install failed/);
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
  });

  it('installs missing deps, then proceeds to the requested command', () => {
    // The fake npm heals the plugin root the way a real install would.
    const stageScript = REQUIRED_PACKAGES.map(pkg =>
      `mkdir -p "$PWD/node_modules/${pkg}" && printf '{"name":"x"}' > "$PWD/node_modules/${pkg}/package.json"`
    ).join(' && ');
    writeFakeNpm(stageScript);
    const run = runCli(['sync', '--background']);
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/Installing episodic-memory dependencies/);
  });

  it('does not run the install check for --help', () => {
    writeFakeNpm('exit 1');
    const run = runCli(['--help']);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('USAGE:');
  });
});
