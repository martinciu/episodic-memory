import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
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
 * until the winner finishes, then re-probes instead of installing again.
 * "Healthy" is manifests-present AND no lock: during a live install the
 * top-level manifests appear before transitive deps finish extracting, so a
 * lock-blind probe would hand off to a half-written tree.
 *
 * Liveness vs. theft: the lock holder refreshes the lock's mtime every
 * heartbeatMs while npm runs, so a live install is never stolen regardless of
 * duration. A lock whose mtime is older than lockStaleMs has no live holder
 * (killed hook) and is stolen. lockStaleMs < waitTimeoutMs by default, so an
 * orphaned lock is always stolen within a waiter's patience — with the old
 * 10-min stale / 5-min wait ordering every waiter gave up before the steal
 * threshold and a killed hook wedged the MCP server for the whole session.
 * Every waiting path is bounded by the deadline and paced by sleep: a lock
 * that cannot be removed (EPERM/EBUSY, root-owned) degrades to a clear
 * timeout error instead of a silent synchronous spin.
 */
export async function ensureDepsInstalled(pluginRoot, options = {}) {
  const {
    installer = defaultNpmInstaller,
    pollMs = 1000,
    waitTimeoutMs = 5 * 60_000,
    lockStaleMs = 2 * 60_000,
    heartbeatMs = 30_000,
    log = (msg) => console.error(msg),
  } = options;

  const lockPath = join(pluginRoot, INSTALL_LOCK_DIRNAME);
  const tokenPath = join(lockPath, 'owner');
  const healthy = () => findMissingDeps(pluginRoot).length === 0 && !existsSync(lockPath);

  if (healthy()) return false;

  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + waitTimeoutMs;
  let announcedWait = false;

  for (;;) {
    if (healthy()) return false; // another process installed and released
    let acquired = false;
    try {
      mkdirSync(lockPath);
      writeFileSync(tokenPath, token, 'utf-8');
      acquired = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs >= lockStaleMs;
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        // Lock vanished between mkdir and stat — fall through to the bounded
        // wait below and retry acquisition next iteration.
      }
      if (stale) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
          continue; // stolen — retry acquisition immediately
        } catch (rmErr) {
          log(`episodic-memory: could not remove stale install lock at ${lockPath}: ${rmErr.message}`);
          // Fall through to the deadline/sleep below — never spin on a lock
          // we cannot remove.
        }
      } else if (!announcedWait) {
        announcedWait = true;
        log(`episodic-memory: waiting for another install to finish (lock at ${lockPath})...`);
      }
    }
    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `another install appears to be running (lock at ${lockPath}); gave up after ${Math.round(waitTimeoutMs / 1000)}s`
      );
    }
    await sleep(pollMs);
  }

  const ownsLock = () => {
    try {
      return readFileSync(tokenPath, 'utf-8') === token;
    } catch {
      return false; // token unreadable/gone — assume stolen, never delete a foreign lock
    }
  };
  const releaseLock = () => {
    if (!ownsLock()) return;
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch (rmErr) {
      log(`episodic-memory: could not remove install lock at ${lockPath}; remove it manually (${rmErr.message})`);
    }
  };

  // Best-effort release if the hook harness kills us mid-install; SIGKILL
  // can't be caught — that orphan goes stale and is stolen after lockStaleMs.
  const exitHandler = () => releaseLock();
  const signalHandler = () => {
    releaseLock();
    process.exit(143);
  };
  process.once('exit', exitHandler);
  process.once('SIGTERM', signalHandler);
  process.once('SIGINT', signalHandler);

  // Keep the lock's mtime fresh while npm runs so a slow (cold-cache) install
  // is never mistaken for a dead one and stolen into a concurrent npm run.
  let heartbeatWarned = false;
  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch (hbErr) {
      if (!heartbeatWarned) {
        heartbeatWarned = true;
        log(`episodic-memory: could not refresh install lock at ${lockPath}: ${hbErr.message}`);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

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
    clearInterval(heartbeat);
    process.removeListener('exit', exitHandler);
    process.removeListener('SIGTERM', signalHandler);
    process.removeListener('SIGINT', signalHandler);
    releaseLock();
  }
}
