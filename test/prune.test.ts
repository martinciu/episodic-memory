import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase, insertExchange } from '../src/db.js';
import { pruneProjects } from '../src/prune.js';
import type { ConversationExchange } from '../src/types.js';
import { EMBEDDING_DIM } from '../src/embedding-migration.js';

/** vec_exchanges is declared FLOAT[EMBEDDING_DIM] and vec0 rejects zero-length vectors. */
const EMBEDDING = new Array(EMBEDDING_DIM).fill(0.1);

/**
 * exclude.txt / CONVERSATION_SEARCH_EXCLUDE_PROJECTS are applied at index time only
 * (indexer.ts:62-63). Adding a project to the exclude list stops new rows appearing
 * but leaves everything already indexed in place, searchable, forever — and users
 * only ever discover the exclude list *after* something has flooded the index.
 *
 * Two traps this must respect:
 *   - tool_calls has an FK to exchanges, so deletion order matters (see #81).
 *   - vec_exchanges is a vec0 virtual table. A client without the extension loaded
 *     silently skips it, leaving orphaned vectors. initDatabase() loads sqlite-vec.
 */
describe('pruneProjects', () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-prune-'));
    process.env.TEST_DB_PATH = join(testDir, 'test.db');
    db = initDatabase();
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    try {
      db.close();
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  function seed(id: string, project: string, tools: string[] = []): void {
    // insertExchange reads exchange.toolCalls; its 4th `toolNames` param is unused.
    const exchange: ConversationExchange = {
      id,
      project,
      timestamp: '2026-07-29T00:00:00.000Z',
      userMessage: `msg ${id}`,
      assistantMessage: 'reply',
      archivePath: `/archive/${id}.jsonl`,
      lineStart: 1,
      lineEnd: 2,
      toolCalls: tools.map((toolName, i) => ({
        id: `${id}-tc${i}`,
        exchangeId: id,
        toolName,
        isError: false,
        timestamp: '2026-07-29T00:00:00.000Z',
      })),
    } as ConversationExchange;
    insertExchange(db, exchange, EMBEDDING);
  }

  function counts() {
    return {
      exchanges: (db.prepare('SELECT COUNT(*) n FROM exchanges').get() as { n: number }).n,
      toolCalls: (db.prepare('SELECT COUNT(*) n FROM tool_calls').get() as { n: number }).n,
      vectors: (db.prepare('SELECT COUNT(*) n FROM vec_exchanges_rowids').get() as { n: number }).n,
    };
  }

  it('removes only the named project, leaving others intact', () => {
    seed('a1', 'noisy');
    seed('a2', 'noisy');
    seed('b1', 'keep');

    const result = pruneProjects(db, ['noisy']);

    expect(result.exchangesDeleted).toBe(2);
    const after = counts();
    expect(after.exchanges).toBe(1);
    const remaining = db.prepare('SELECT project FROM exchanges').all() as { project: string }[];
    expect(remaining.map((r) => r.project)).toEqual(['keep']);
  });

  it('deletes dependent tool_calls rather than tripping the FK constraint (#81)', () => {
    seed('a1', 'noisy', ['Read', 'Bash']);
    seed('b1', 'keep', ['Grep']);

    expect(counts().toolCalls).toBe(3);
    const result = pruneProjects(db, ['noisy']);

    expect(result.toolCallsDeleted).toBe(2);
    expect(counts().toolCalls).toBe(1);
  });

  it('deletes the vec0 vectors too, leaving no orphans', () => {
    seed('a1', 'noisy');
    seed('a2', 'noisy');
    seed('b1', 'keep');

    pruneProjects(db, ['noisy']);

    const after = counts();
    // the invariant that matters: one vector per exchange, always
    expect(after.vectors).toBe(after.exchanges);
    expect(after.vectors).toBe(1);
  });

  it('dry-run reports what would go without deleting anything', () => {
    seed('a1', 'noisy', ['Read']);
    seed('a2', 'noisy');
    seed('b1', 'keep');

    const before = counts();
    const result = pruneProjects(db, ['noisy'], { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.exchangesDeleted).toBe(2);
    expect(result.toolCallsDeleted).toBe(1);
    expect(counts()).toEqual(before);
  });

  it('reports reclaimable bytes so the benefit is visible before committing', () => {
    seed('a1', 'noisy');
    seed('a2', 'noisy');

    const result = pruneProjects(db, ['noisy'], { dryRun: true });
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  it('handles several projects in one call', () => {
    seed('a1', 'noisy');
    seed('b1', 'alsoNoisy');
    seed('c1', 'keep');

    const result = pruneProjects(db, ['noisy', 'alsoNoisy']);

    expect(result.exchangesDeleted).toBe(2);
    expect(counts().exchanges).toBe(1);
  });

  it('is a no-op for an unknown project', () => {
    seed('a1', 'keep');
    const before = counts();

    const result = pruneProjects(db, ['neverIndexed']);

    expect(result.exchangesDeleted).toBe(0);
    expect(counts()).toEqual(before);
  });

  it('is a no-op for an empty project list rather than deleting everything', () => {
    seed('a1', 'keep');
    seed('b1', 'noisy');
    const before = counts();

    const result = pruneProjects(db, []);

    expect(result.exchangesDeleted).toBe(0);
    expect(counts()).toEqual(before);
  });
});
