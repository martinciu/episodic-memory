import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';

// No model loads and no Claude calls: mock the embedding backend and the
// summarizer. indexer.ts imports both statically, so vi.mock registered here
// intercepts them.
vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => new Array(1024).fill(0)),
  generateQueryEmbedding: vi.fn(),
  generateEmbedding: vi.fn(),
  initEmbeddingsFailed: false,
}));
vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async () => 'Mock summary'),
}));

import { indexConversations, indexSession, indexUnprocessed } from '../src/indexer.js';
import { summarizeConversation } from '../src/summarizer.js';
import { suppressConsole } from './test-utils.js';

const MAIN_SID = 'a8868824-cd73-4ec9-92e5-a3fb4e827c61';

function exchangeLines(sessionId: string, isSidechain: boolean, text: string): string {
  const user = {
    type: 'user',
    uuid: `user-${text}`,
    parentUuid: null,
    sessionId,
    isSidechain,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: `question about ${text}` },
  };
  const assistant = {
    type: 'assistant',
    uuid: `asst-${text}`,
    parentUuid: `user-${text}`,
    sessionId,
    isSidechain,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: `answer about ${text}` }] },
  };
  return JSON.stringify(user) + '\n' + JSON.stringify(assistant) + '\n';
}

function findFiles(root: string, suffix: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
  return found;
}

describe('indexer: subagent transcripts are never summarized (#31)', () => {
  let testDir: string;
  let projectsDir: string;
  let archiveDir: string;
  let dbPath: string;
  let restoreConsole: () => void;

  const mainRel = join('project-a', `${MAIN_SID}.jsonl`);
  const subagentRel = join('project-a', MAIN_SID, 'subagents', 'agent-abc123.jsonl');

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'em-indexer-subagent-'));
    projectsDir = join(testDir, 'projects');
    archiveDir = join(testDir, 'archive');
    dbPath = join(testDir, 'test.db');
    mkdirSync(join(projectsDir, 'project-a', MAIN_SID, 'subagents'), { recursive: true });
    mkdirSync(join(testDir, 'config'), { recursive: true });

    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
    process.env.EPISODIC_MEMORY_CONFIG_DIR = join(testDir, 'config');

    vi.mocked(summarizeConversation).mockClear();
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
    delete process.env.EPISODIC_MEMORY_CONFIG_DIR;
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  function writeMainAndSubagent(): void {
    writeFileSync(join(projectsDir, mainRel), exchangeLines(MAIN_SID, false, 'main'), 'utf-8');
    writeFileSync(join(projectsDir, subagentRel), exchangeLines(MAIN_SID, true, 'subagent'), 'utf-8');
  }

  function rowCount(archivePath: string): number {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?').get(archivePath) as { count: number };
    db.close();
    return row.count;
  }

  function expectMainSummarizedSubagentSkipped(): void {
    expect(vi.mocked(summarizeConversation)).toHaveBeenCalledTimes(1);
    expect(findFiles(archiveDir, 'agent-abc123-summary.txt')).toEqual([]);
    expect(rowCount(join(archiveDir, mainRel))).toBeGreaterThan(0);
    expect(rowCount(join(archiveDir, subagentRel))).toBeGreaterThan(0);
  }

  it('indexUnprocessed summarizes the main session but not the subagent transcript', async () => {
    writeMainAndSubagent();
    await indexUnprocessed(1, false);
    expectMainSummarizedSubagentSkipped();
  });

  it('indexConversations skips subagent summaries', async () => {
    writeMainAndSubagent();
    await indexConversations(undefined, undefined, 1, false);
    expectMainSummarizedSubagentSkipped();
  });

  it('indexSession skips the summary for a subagent transcript', async () => {
    writeFileSync(join(projectsDir, subagentRel), exchangeLines(MAIN_SID, true, 'subagent'), 'utf-8');
    await indexSession(MAIN_SID, 1, false);
    expect(vi.mocked(summarizeConversation)).not.toHaveBeenCalled();
    expect(rowCount(join(archiveDir, subagentRel))).toBeGreaterThan(0);
  });
});
