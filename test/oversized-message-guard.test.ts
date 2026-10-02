import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase, insertExchange } from '../src/db.js';
import {
  DEFAULT_MAX_MESSAGE_BYTES as CAP,
  truncationNoticeFor,
  truncateForIndex,
  capExchangeForIndex,
} from '../src/message-size.js';
import type { ConversationExchange } from '../src/types.js';
import { EMBEDDING_DIM } from '../src/embedding-migration.js';

/** vec_exchanges is declared FLOAT[EMBEDDING_DIM] and vec0 rejects zero-length vectors. */
const EMBEDDING = new Array(EMBEDDING_DIM).fill(0.1);

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

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
 *
 * Fork policy: oversize messages are truncated, not skipped (upstream #139
 * skips the whole exchange). The index call sites cap before embedding; these
 * tests pin insertExchange's backstop, the one choke point every path shares.
 */
describe('oversized message guard (insertExchange backstop)', () => {
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
    delete process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES;
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

  function stored(column: 'user_message' | 'assistant_message'): string {
    const row = db.prepare(`SELECT ${column} AS v FROM exchanges WHERE id = ?`).get('x1') as { v: string };
    return row.v;
  }

  it('leaves normal messages completely untouched', () => {
    const body = 'a normal question about the codebase';
    insertExchange(db, exchange({ userMessage: body }), EMBEDDING);
    expect(stored('user_message')).toBe(body);
  });

  it('truncates a user message far above the cap to the cap plus a notice', () => {
    const huge = 'x'.repeat(CAP * 3);
    insertExchange(db, exchange({ userMessage: huge }), EMBEDDING);
    const value = stored('user_message');
    expect(bytes(value)).toBeLessThanOrEqual(CAP + bytes(truncationNoticeFor(bytes(huge), CAP)));
  });

  it('keeps the head of the message so it stays searchable and identifiable', () => {
    const head = 'You are summarizing a Claude Code session for a daily memory log.';
    insertExchange(db, exchange({ userMessage: head + 'y'.repeat(CAP * 2) }), EMBEDDING);
    expect(stored('user_message').startsWith(head)).toBe(true);
  });

  it('marks the row as truncated rather than silently dropping content', () => {
    insertExchange(db, exchange({ userMessage: 'z'.repeat(CAP * 2) }), EMBEDDING);
    expect(stored('user_message')).toContain('[truncated by episodic-memory');
  });

  it('applies the same cap to assistant messages', () => {
    const huge = 'q'.repeat(CAP * 2);
    insertExchange(db, exchange({ assistantMessage: huge }), EMBEDDING);
    expect(stored('assistant_message').length).toBeLessThan(huge.length);
  });

  it('a 3 MB payload collapses to roughly the cap, not megabytes', () => {
    insertExchange(db, exchange({ userMessage: 'p'.repeat(3_109_374) }), EMBEDDING); // the real observed maximum
    expect(bytes(stored('user_message'))).toBeLessThan(CAP * 1.1);
  });

  it('reads EPISODIC_MEMORY_MAX_MESSAGE_BYTES at insert time ("0" disables the cap)', () => {
    process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES = '0';
    const huge = 'x'.repeat(CAP * 2);
    insertExchange(db, exchange({ userMessage: huge }), EMBEDDING);
    expect(stored('user_message')).toBe(huge);
  });
});

describe('truncateForIndex', () => {
  it('is a no-op at or below the cap', () => {
    expect(truncateForIndex('short', 100)).toBe('short');
    const exact = 'e'.repeat(100);
    expect(truncateForIndex(exact, 100)).toBe(exact);
  });

  it('handles empty and undefined input without throwing', () => {
    expect(truncateForIndex('', 100)).toBe('');
    expect(truncateForIndex(undefined as unknown as string, 100)).toBe(undefined);
  });

  it('is a no-op when the cap is disabled (0)', () => {
    const huge = 'x'.repeat(500_000);
    expect(truncateForIndex(huge, 0)).toBe(huge);
  });

  it('measures the cap in UTF-8 bytes and never splits a code point', () => {
    // '🚀' is 4 UTF-8 bytes; a 10-byte cap fits two whole rockets, not 2.5.
    const result = truncateForIndex('🚀'.repeat(100), 10);
    const head = result.slice(0, result.indexOf('\n\n[truncated'));
    expect(head).toBe('🚀🚀');
    expect(result).not.toContain('�');
    expect(result.endsWith(truncationNoticeFor(400, 10))).toBe(true);
  });

  it('cuts Polish text on a character boundary', () => {
    // 'ż' is 2 bytes; an odd cap must back off rather than emit half a character.
    const result = truncateForIndex('ż'.repeat(50), 7);
    expect(result.startsWith('żżż\n\n[truncated')).toBe(true);
  });

  it('is idempotent — truncating twice does not stack notices', () => {
    const once = truncateForIndex('w'.repeat(CAP * 2), CAP);
    expect(truncateForIndex(once, CAP)).toBe(once);
  });

  it('still truncates an oversized message that merely quotes the notice mid-body', () => {
    // Regression for a fail-open bug: an includes() check exempted ANY message
    // containing the notice text anywhere, not just our own truncated output.
    const huge =
      'quoting [truncated by episodic-memory: 999 bytes exceeded the 999-byte index cap] mid-body' +
      'x'.repeat(CAP * 2);
    const result = truncateForIndex(huge, CAP);
    expect(result.endsWith(truncationNoticeFor(bytes(huge), CAP))).toBe(true);
    expect(bytes(result)).toBeLessThanOrEqual(CAP + bytes(truncationNoticeFor(bytes(huge), CAP)));
  });

  it('still truncates when the quoted notice carries its \\n\\n prefix mid-body', () => {
    const huge =
      'a'.repeat(Math.floor(CAP / 2)) +
      '\n\n[truncated by episodic-memory: 9 bytes exceeded the 9-byte index cap]' +
      'x'.repeat(CAP);
    const result = truncateForIndex(huge, CAP);
    expect(result.endsWith(truncationNoticeFor(bytes(huge), CAP))).toBe(true);
  });

  it('still truncates a payload that ENDS with a well-formed notice but whose head exceeds the cap', () => {
    const huge = 'x'.repeat(CAP * 2) + truncationNoticeFor(12345, CAP);
    const result = truncateForIndex(huge, CAP);
    expect(bytes(result)).toBeLessThanOrEqual(CAP + bytes(truncationNoticeFor(bytes(huge), CAP)));
  });
});

describe('capExchangeForIndex', () => {
  const base = { id: 'x', userMessage: 'hello', assistantMessage: 'hi' };

  it('returns the same object when both messages fit', () => {
    expect(capExchangeForIndex(base, 100)).toBe(base);
  });

  it('returns a copy with both messages truncated, leaving the input untouched', () => {
    const input = { ...base, userMessage: 'u'.repeat(300), assistantMessage: 'a'.repeat(300) };
    const capped = capExchangeForIndex(input, 100);
    expect(capped).not.toBe(input);
    expect(capped.id).toBe('x');
    expect(capped.userMessage.startsWith('u'.repeat(100) + '\n\n[truncated')).toBe(true);
    expect(capped.assistantMessage.startsWith('a'.repeat(100) + '\n\n[truncated')).toBe(true);
    expect(input.userMessage.length).toBe(300);
  });
});
