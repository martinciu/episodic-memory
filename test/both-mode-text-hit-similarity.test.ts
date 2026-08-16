import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDatabase, insertExchange } from '../src/db.js';
import { searchConversations } from '../src/search.js';
import { initEmbeddings, generateQueryEmbedding } from '../src/embeddings.js';
import { ConversationExchange } from '../src/types.js';

describe('both-mode search — text-LIKE hits carry no similarity (#18)', () => {
  let testDir: string;
  const originalDbPath = process.env.TEST_DB_PATH;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-both-mode-'));
    process.env.TEST_DB_PATH = join(testDir, 'index.sqlite');
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.TEST_DB_PATH;
    else process.env.TEST_DB_PATH = originalDbPath;
    rmSync(testDir, { recursive: true, force: true });
  });

  function seedExchange(
    partial: Partial<ConversationExchange> & Pick<ConversationExchange, 'id' | 'userMessage' | 'assistantMessage'>,
    embedding: number[]
  ): void {
    const archiveDir = join(testDir, 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `${partial.id}.jsonl`);
    writeFileSync(archivePath, '{}\n', 'utf-8');

    const db = initDatabase();
    const exchange: ConversationExchange = {
      project: 'test-project',
      timestamp: '2026-05-12T20:00:00.000Z',
      lineStart: 1,
      lineEnd: 2,
      archivePath,
      harness: 'claude',
      sessionId: `session-${partial.id}`,
      ...partial,
    };
    insertExchange(db, exchange, embedding);
    db.close();
  }

  it('returns undefined similarity for rows that arrive only via the text branch, real similarity for vector hits', async () => {
    await initEmbeddings();
    const queryEmbedding = await generateQueryEmbedding('deployment pipeline');
    // Vector-near rows: identical to the query embedding (distance 0), text
    // deliberately missing the query tokens so the text branch skips them.
    const farEmbedding = queryEmbedding.map(v => -v);
    for (const id of ['near-1', 'near-2', 'near-3']) {
      seedExchange(
        {
          id,
          userMessage: 'Refactored the build scripts today.',
          assistantMessage: 'Looks good to me.',
        },
        queryEmbedding
      );
    }
    // Vector-far row (negated query embedding → similarity -1, outside k=3),
    // but its text contains every query token → arrives via the text branch only.
    seedExchange(
      {
        id: 'text-hit',
        userMessage: 'Our deployment broke the release pipeline yesterday.',
        assistantMessage: 'Rolled it back.',
      },
      farEmbedding
    );

    const results = await searchConversations('deployment pipeline', { mode: 'both', limit: 3 });

    const textHit = results.find(r => r.exchange.id === 'text-hit');
    expect(textHit).toBeDefined();
    expect(textHit!.similarity).toBeUndefined();

    const vectorHits = results.filter(r => r.exchange.id !== 'text-hit');
    expect(vectorHits).toHaveLength(3);
    for (const hit of vectorHits) {
      expect(typeof hit.similarity).toBe('number');
    }
  }, 120_000);

  it('still returns undefined similarity for every row in pure text mode', async () => {
    seedExchange(
      {
        id: 'text-only',
        userMessage: 'Our deployment broke the release pipeline yesterday.',
        assistantMessage: 'Rolled it back.',
      },
      new Array(1024).fill(0.1)
    );

    const results = await searchConversations('deployment pipeline', { mode: 'text', limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBeUndefined();
  });
});
