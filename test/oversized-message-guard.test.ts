import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase, insertExchange } from '../src/db.js';
import {
  MAX_INDEXED_MESSAGE_BYTES,
  truncationNoticeFor,
  truncateForIndex,
} from '../src/constants.js';
import type { ConversationExchange } from '../src/types.js';
import { EMBEDDING_DIM } from '../src/embedding-migration.js';

/** vec_exchanges is declared FLOAT[EMBEDDING_DIM] and vec0 rejects zero-length vectors. */
const EMBEDDING = new Array(EMBEDDING_DIM).fill(0.1);

/**
 * Guard against machine-generated prompt payload being indexed as conversation.
 *
 * Third-party plugins that summarize conversations spawn subagents whose prompt
 * embeds the whole conversation being summarized. Those subagent sessions get
 * indexed like any other, so a single "user message" can be megabytes. Measured
 * on a real install: median user_message 1,636 bytes, largest 3,109,374, and
 * 1,301 such rows were 97.2% of a 3.04 GB database.
 *
 * The existing EXCLUSION_MARKERS defence is cooperative — it only works for
 * agents that emit a marker. This guard needs no cooperation.
 */
describe('oversized message guard', () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-oversize-'));
    // initDatabase() resolves its own path; TEST_DB_PATH is the supported override.
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

  function exchange(overrides: Partial<ConversationExchange> = {}): ConversationExchange {
    return {
      id: 'x1',
      project: 'proj',
      timestamp: '2026-07-29T00:00:00.000Z',
      userMessage: 'hello',
      assistantMessage: 'hi',
      archivePath: '/archive/x.jsonl',
      lineStart: 1,
      lineEnd: 2,
      ...overrides,
    } as ConversationExchange;
  }

  it('leaves normal messages completely untouched', () => {
    const body = 'a normal question about the codebase';
    insertExchange(db, exchange({ userMessage: body }), EMBEDDING);
    const row = db.prepare('SELECT user_message FROM exchanges WHERE id = ?').get('x1') as {
      user_message: string;
    };
    expect(row.user_message).toBe(body);
  });

  it('truncates a user message far above the cap', () => {
    const huge = 'x'.repeat(MAX_INDEXED_MESSAGE_BYTES * 3);
    insertExchange(db, exchange({ userMessage: huge }), EMBEDDING);
    const row = db.prepare('SELECT user_message FROM exchanges WHERE id = ?').get('x1') as {
      user_message: string;
    };
    expect(row.user_message.length).toBeLessThan(huge.length);
    expect(row.user_message.length).toBeLessThanOrEqual(
      MAX_INDEXED_MESSAGE_BYTES + truncationNoticeFor(huge.length).length
    );
  });

  it('keeps the head of the message so it stays searchable and identifiable', () => {
    const head = 'You are summarizing a Claude Code session for a daily memory log.';
    const huge = head + 'y'.repeat(MAX_INDEXED_MESSAGE_BYTES * 2);
    insertExchange(db, exchange({ userMessage: huge }), EMBEDDING);
    const row = db.prepare('SELECT user_message FROM exchanges WHERE id = ?').get('x1') as {
      user_message: string;
    };
    expect(row.user_message.startsWith(head)).toBe(true);
  });

  it('marks the row as truncated rather than silently dropping content', () => {
    const huge = 'z'.repeat(MAX_INDEXED_MESSAGE_BYTES * 2);
    insertExchange(db, exchange({ userMessage: huge }), EMBEDDING);
    const row = db.prepare('SELECT user_message FROM exchanges WHERE id = ?').get('x1') as {
      user_message: string;
    };
    expect(row.user_message).toContain('[truncated by episodic-memory');
  });

  it('applies the same cap to assistant messages', () => {
    const huge = 'q'.repeat(MAX_INDEXED_MESSAGE_BYTES * 2);
    insertExchange(db, exchange({ assistantMessage: huge }), EMBEDDING);
    const row = db.prepare('SELECT assistant_message FROM exchanges WHERE id = ?').get('x1') as {
      assistant_message: string;
    };
    expect(row.assistant_message.length).toBeLessThan(huge.length);
  });

  it('a 3 MB payload collapses to roughly the cap, not megabytes', () => {
    const threeMB = 'p'.repeat(3_109_374); // the real observed maximum
    insertExchange(db, exchange({ userMessage: threeMB }), EMBEDDING);
    const row = db.prepare('SELECT length(user_message) AS n FROM exchanges WHERE id = ?').get('x1') as {
      n: number;
    };
    expect(row.n).toBeLessThan(MAX_INDEXED_MESSAGE_BYTES * 1.1);
  });

  describe('truncateForIndex', () => {
    it('is a no-op below the cap', () => {
      expect(truncateForIndex('short')).toBe('short');
    });

    it('handles empty and undefined input without throwing', () => {
      expect(truncateForIndex('')).toBe('');
      expect(truncateForIndex(undefined as unknown as string)).toBe(undefined);
    });

    it('is idempotent — truncating twice does not stack notices', () => {
      const huge = 'w'.repeat(MAX_INDEXED_MESSAGE_BYTES * 2);
      const once = truncateForIndex(huge);
      expect(truncateForIndex(once)).toBe(once);
    });
  });
});
