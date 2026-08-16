import { existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

/**
 * Runtime-required packages externalized from the MCP server bundle (see the
 * `bundle` script in package.json). The bundle inline-imports these at runtime
 * via Node's resolver, so a partial node_modules extraction — directory exists
 * but the package is missing its package.json and lib/ — surfaces as a
 * confusing `ERR_MODULE_NOT_FOUND` *after* the wrapper has already declared
 * dependencies healthy and launched the server (#95 Bug 1).
 *
 * Excludes optional / OS-specific externals (sharp, fsevents) — missing those
 * is not necessarily fatal.
 */
export const REQUIRED_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@huggingface/transformers',
  'better-sqlite3',
  'onnxruntime-node',
  'proper-lockfile',
  'sqlite-vec',
];

/**
 * Return the list of required packages whose package.json is missing under
 * `<pluginRoot>/node_modules`. An empty array means the install looks complete;
 * a non-empty array is the diagnostic to print before re-running `npm install`.
 *
 * Probing each package's package.json — not just the directory — catches
 * partial extractions where the folder exists but the manifest hasn't been
 * written yet (the failure mode reported for episodic-memory@1.4.1 on Windows
 * 11 in #95).
 */
export function findMissingDeps(pluginRoot) {
  const nodeModules = join(pluginRoot, 'node_modules');
  if (!existsSync(nodeModules)) {
    return REQUIRED_PACKAGES.slice();
  }
  return REQUIRED_PACKAGES.filter(pkg => !existsSync(join(nodeModules, pkg, 'package.json')));
}

/**
 * Lock directory name, created inside the plugin root while an install runs.
 * A directory (atomic mkdir) rather than proper-lockfile, because the lock
 * must work exactly when node_modules — and therefore every dependency —
 * is missing.
 */
export const INSTALL_LOCK_DIRNAME = '.episodic-memory-install.lock';

function defaultNpmInstaller(pluginRoot) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const npmCommand = isWindows ? 'npm.cmd' : 'npm';

    console.error('Installing episodic-memory dependencies (first run only)...');
    console.error('This may take 30-60 seconds...');

    // Install dependencies - npm will auto-install optionalDependencies for current platform
    const child = spawn(npmCommand, ['install', '--no-audit', '--no-fund'], {
      cwd: pluginRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows // On Windows, we need shell: true to find npm.cmd
    });

    // Route npm output to stderr so it never corrupts an MCP stdout channel.
    child.stdout.on('data', (data) => process.stderr.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));

    child.on('exit', (code) => {
      if (code === 0) {
        console.error('Dependencies installed successfully.');
        resolve();
      } else {
        console.error('ERROR: Failed to install dependencies.');
        console.error(`Please run manually: cd "${pluginRoot}" && npm install`);
        reject(new Error(`npm install failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      console.error(`ERROR: Failed to run npm install: ${err.message}`);
      reject(err);
    });
  });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ensure the plugin's runtime dependencies are installed, installing them if
 * needed. Shared by the MCP wrapper and the CLI dispatcher (#17) so a plugin
 * update that wipes node_modules can't silently kill the SessionStart sync
 * hook — previously only the MCP path self-healed.
 *
 * Returns false when deps were already present (or another process installed
 * them while we waited), true when this call ran the installer. Throws when
 * the install fails, when packages are still missing afterwards (#95-style
 * partial extraction), or when a foreign lock never clears.
 *
 * Concurrency: the MCP wrapper and the SessionStart hook start together, so
 * two installs can race. An atomic mkdir lock serializes them; the loser polls
 * until the winner finishes, then re-probes instead of installing again. A
 * lock older than lockStaleMs is presumed dead (killed hook) and stolen.
 */
export async function ensureDepsInstalled(pluginRoot, options = {}) {
  const {
    installer = defaultNpmInstaller,
    pollMs = 1000,
    waitTimeoutMs = 5 * 60_000,
    lockStaleMs = 10 * 60_000,
    log = (msg) => console.error(msg),
  } = options;

  if (findMissingDeps(pluginRoot).length === 0) return false;

  const lockPath = join(pluginRoot, INSTALL_LOCK_DIRNAME);
  const deadline = Date.now() + waitTimeoutMs;

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs >= lockStaleMs;
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue; // lock vanished between mkdir and stat — retry acquisition
      }
      if (stale) {
        try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `another install appears to be running (lock at ${lockPath}); gave up after ${Math.round(waitTimeoutMs / 1000)}s`
        );
      }
      await sleep(pollMs);
      if (findMissingDeps(pluginRoot).length === 0) return false; // other process healed the deps
    }
  }

  try {
    // Re-probe under the lock: the process we raced may have finished between
    // our first probe and acquisition.
    const missing = findMissingDeps(pluginRoot);
    if (missing.length === 0) return false;
    log(`Missing dependencies under node_modules: ${missing.join(', ')}`);
    await installer(pluginRoot);
    const stillMissing = findMissingDeps(pluginRoot);
    if (stillMissing.length > 0) {
      throw new Error(`npm install completed but packages are still missing: ${stillMissing.join(', ')}`);
    }
    return true;
  } finally {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch {}
  }
}
