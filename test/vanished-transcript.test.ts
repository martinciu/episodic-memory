import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { indexConversations } from '../src/indexer.js';
import { suppressConsole } from './test-utils.js';

// chmod 000 doesn't block reads on Windows or when running as root.
const chmodBlocksReads =
  process.platform !== 'win32' &&
  typeof process.getuid === 'function' &&
  process.getuid() !== 0;

/** Same transcript fixture shape as test/dangling-symlink.test.ts. */
function makeExchangeLines(seq: number, sessionId: string): string {
  const userUuid = `user-${seq}-${sessionId}`;
  const assistantUuid = `asst-${seq}-${sessionId}`;
  const ts = new Date(2026, 0, 1 + seq).toISOString();
  const userLine = JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/test/project',
    sessionId,
    version: '2.0.9',
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content: `User question ${seq} in session ${sessionId}` },
    uuid: userUuid,
    timestamp: ts,
  });
  const assistantLine = JSON.stringify({
    parentUuid: userUuid,
    isSidechain: false,
    userType: 'external',
    cwd: '/test/project',
    sessionId,
    version: '2.0.9',
    gitBranch: 'main',
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-5',
      role: 'assistant',
      content: [{ type: 'text', text: `Reply ${seq} in session ${sessionId}` }],
    },
    uuid: assistantUuid,
    timestamp: ts,
  });
  return userLine + '\n' + assistantLine + '\n';
}

describe.skipIf(!chmodBlocksReads)('indexing survives unreadable transcripts (#132 port)', () => {
  let testDir: string;
  let projectsDir: string;
  let archiveDir: string;
  let configDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-vanished-test-'));
    projectsDir = join(testDir, 'projects');
    archiveDir = join(testDir, 'archive');
    configDir = join(testDir, 'config');
    dbPath = join(testDir, 'test.db');
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = configDir;
    process.env.TEST_DB_PATH = dbPath;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    delete process.env.TEST_DB_PATH;
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it('indexConversations skips the unreadable file and still indexes the sibling', async () => {
    const projectDir = join(projectsDir, '-Users-real-project');
    mkdirSync(projectDir, { recursive: true });

    // Unreadable transcript — copyFileSync throws EACCES inside the #132 try/catch.
    const badId = '00000000-0000-0000-0000-000000000000';
    const badPath = join(projectDir, `${badId}.jsonl`);
    writeFileSync(badPath, makeExchangeLines(1, badId), 'utf-8');
    chmodSync(badPath, 0o000);

    // Healthy sibling in the same project.
    const goodId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    writeFileSync(join(projectDir, `${goodId}.jsonl`), makeExchangeLines(2, goodId), 'utf-8');

    // Without the #132 port this rejects with EACCES and aborts the run.
    await expect(indexConversations(undefined, undefined, 1, true)).resolves.toBeUndefined();

    const db = new Database(dbPath);
    const rows = db
      .prepare('SELECT DISTINCT archive_path FROM exchanges')
      .all() as Array<{ archive_path: string }>;
    db.close();
    const paths = rows.map((r) => r.archive_path);
    expect(paths.some((p) => p.includes(goodId))).toBe(true);
    expect(paths.some((p) => p.includes(badId))).toBe(false);
  });
});
