import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyIndex, repairIndex, VerificationResult } from '../src/verify.js';
import { formatErrorSentinel } from '../src/summary-sentinel.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDatabase, insertExchange } from '../src/db.js';
import { ConversationExchange } from '../src/types.js';
import { summarizeConversation } from '../src/summarizer.js';

vi.mock('../src/embeddings.js', () => ({
  initEmbeddings: vi.fn(async () => {}),
  generateExchangeEmbedding: vi.fn(async () => new Array(1024).fill(0.1))
}));

vi.mock('../src/summarizer.js', () => ({
  summarizeConversation: vi.fn(async () => 'Mock summary')
}));

// Suppress console output for clean test runs
const restoreConsole = suppressConsole();

// A minimal transcript with one user/assistant exchange.
function userAssistantLines(user = 'Hi', assistant = 'Hello'): string {
  return [
    JSON.stringify({ type: 'user', message: { role: 'user', content: user }, timestamp: '2024-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: assistant }, timestamp: '2024-01-01T00:00:01Z' })
  ].join('\n');
}

describe('verifyIndex', () => {
  const testDir = path.join(os.tmpdir(), 'conversation-search-test-' + Date.now());
  const projectsDir = path.join(testDir, '.claude', 'projects');
  const archiveDir = path.join(testDir, '.config', 'superpowers', 'conversation-archive');
  const dbPath = path.join(testDir, '.config', 'superpowers', 'conversation-index', 'db.sqlite');

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(path.join(testDir, '.config', 'superpowers', 'conversation-index'), { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    // Override environment paths for testing
    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
  });

  it('should skip excluded projects', async () => {
    // Create two projects in archive
    const projectA = path.join(archiveDir, 'project-a');
    const projectB = path.join(archiveDir, 'project-b');
    fs.mkdirSync(projectA, { recursive: true });
    fs.mkdirSync(projectB, { recursive: true });

    // Create conversations (missing summaries to trigger detection)
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(path.join(projectA, 'conv1.jsonl'), messages.join('\n'));
    fs.writeFileSync(path.join(projectB, 'conv2.jsonl'), messages.join('\n'));

    // Exclude project-a
    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'project-a';
    const result = await verifyIndex();
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;

    // Only project-b should be checked (missing summary)
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].path).toContain('project-b');
  });

  it('detects missing summaries', async () => {
    // Create a test conversation file without a summary
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'test-conversation.jsonl');

    // Create proper JSONL format (one JSON object per line)
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi there!' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));

    const result = await verifyIndex();

    expect(result.missing.length).toBe(1);
    expect(result.missing[0].path).toBe(conversationPath);
    expect(result.missing[0].reason).toBe('No summary file');
  });

  it('flags conversations with an error sentinel as missing so repair re-attempts them (#96)', async () => {
    const { formatErrorSentinel } = await import('../src/summary-sentinel.js');
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'errored-conversation.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hi' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hello' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, formatErrorSentinel(new Error('Transient outage')), 'utf-8');

    const result = await verifyIndex();
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].path).toBe(conversationPath);
    expect(result.missing[0].reason).toMatch(/error sentinel/i);
  });

  it('does not flag conversations with real summaries as missing', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'summarized.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hi' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hello' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, 'A real summary of the conversation.', 'utf-8');

    const result = await verifyIndex();
    expect(result.missing.length).toBe(0);
  });

  it('does not report unsummarized subagent transcripts as missing (#31)', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    const subagentDir = path.join(projectArchive, 'a8868824-cd73-4ec9-92e5-a3fb4e827c61', 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(path.join(projectArchive, 'main.jsonl'), userAssistantLines());
    fs.writeFileSync(path.join(subagentDir, 'agent-abc123.jsonl'), userAssistantLines());

    const result = await verifyIndex();
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].path.endsWith('main.jsonl')).toBe(true);
  });

  it('does not report a subagent transcript with an error sentinel as missing', async () => {
    const { formatErrorSentinel } = await import('../src/summary-sentinel.js');
    const subagentDir = path.join(archiveDir, 'test-project', 'a8868824-cd73-4ec9-92e5-a3fb4e827c61', 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    const subagentPath = path.join(subagentDir, 'agent-abc123.jsonl');
    fs.writeFileSync(subagentPath, userAssistantLines());
    fs.writeFileSync(subagentPath.replace('.jsonl', '-summary.txt'), formatErrorSentinel(new Error('old failure')), 'utf-8');

    const result = await verifyIndex();
    expect(result.missing.length).toBe(0);
  });

  it('detects orphaned database entries', async () => {
    // Initialize database
    const db = initDatabase();

    // Create an exchange in the database
    const exchange: ConversationExchange = {
      id: 'orphan-id-1',
      project: 'deleted-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'This conversation was deleted',
      assistantMessage: 'But still in database',
      archivePath: path.join(archiveDir, 'deleted-project', 'deleted.jsonl'),
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(1024).fill(0.1);
    insertExchange(db, exchange, embedding);
    db.close();

    // Verify detects orphaned entry (file doesn't exist)
    const result = await verifyIndex();

    expect(result.orphaned.length).toBe(1);
    expect(result.orphaned[0].uuid).toBe('orphan-id-1');
    expect(result.orphaned[0].path).toBe(exchange.archivePath);
  });

  it('detects outdated files (file modified after last_indexed)', async () => {
    // Create conversation file with summary
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'updated-conversation.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');

    // Create initial conversation
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi there!' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, 'Test summary');

    // Index it
    const db = initDatabase();
    const exchange: ConversationExchange = {
      id: 'updated-id-1',
      project: 'test-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello',
      assistantMessage: 'Hi there!',
      archivePath: conversationPath,
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(1024).fill(0.1);
    insertExchange(db, exchange, embedding);

    // Get the last_indexed timestamp
    const row = db.prepare(`SELECT last_indexed FROM exchanges WHERE id = ?`).get('updated-id-1') as any;
    const lastIndexed = row.last_indexed;
    db.close();

    // Wait a bit, then modify the file
    await new Promise(resolve => setTimeout(resolve, 10));

    // Update the conversation file
    const updatedMessages = [
      ...messages,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'New message' }, timestamp: '2024-01-01T00:00:02Z' })
    ];
    fs.writeFileSync(conversationPath, updatedMessages.join('\n'));

    // Verify detects outdated file
    const result = await verifyIndex();

    expect(result.outdated.length).toBe(1);
    expect(result.outdated[0].path).toBe(conversationPath);
    expect(result.outdated[0].dbTime).toBe(lastIndexed);
    expect(result.outdated[0].fileTime).toBeGreaterThan(lastIndexed);
  });

  it('still reports an outdated subagent transcript as outdated, not missing (#31)', async () => {
    const subagentDir = path.join(archiveDir, 'test-project', 'a8868824-cd73-4ec9-92e5-a3fb4e827c61', 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    const subagentPath = path.join(subagentDir, 'agent-abc123.jsonl');
    fs.writeFileSync(subagentPath, userAssistantLines());

    const db = initDatabase();
    insertExchange(db, {
      id: 'subagent-outdated-1',
      project: 'test-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hi',
      assistantMessage: 'Hello',
      archivePath: subagentPath,
      lineStart: 1,
      lineEnd: 2
    }, new Array(1024).fill(0.1));
    const row = db.prepare(`SELECT last_indexed FROM exchanges WHERE id = ?`).get('subagent-outdated-1') as any;
    db.close();

    // Make the file newer than its last_indexed stamp.
    const newer = new Date(row.last_indexed + 60_000);
    fs.utimesSync(subagentPath, newer, newer);

    const result = await verifyIndex();

    expect(result.missing).toEqual([]);
    expect(result.outdated.map(o => o.path)).toEqual([subagentPath]);
  });

  // Note: Parser is resilient to malformed JSON - it skips bad lines
  // Corruption detection would require file system errors or permission issues
  // which are harder to test. Skipping for now as missing summaries is the
  // primary use case for verification.
});

describe('repairIndex', () => {
  const testDir = path.join(os.tmpdir(), 'conversation-repair-test-' + Date.now());
  const projectsDir = path.join(testDir, '.claude', 'projects');
  const archiveDir = path.join(testDir, '.config', 'superpowers', 'conversation-archive');
  const dbPath = path.join(testDir, '.config', 'superpowers', 'conversation-index', 'db.sqlite');

  beforeEach(() => {
    // Create test directories
    fs.mkdirSync(path.join(testDir, '.config', 'superpowers', 'conversation-index'), { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });

    // Override environment paths for testing
    process.env.TEST_PROJECTS_DIR = projectsDir;
    process.env.TEST_ARCHIVE_DIR = archiveDir;
    process.env.TEST_DB_PATH = dbPath;
    vi.mocked(summarizeConversation).mockReset();
    vi.mocked(summarizeConversation).mockResolvedValue('Mock summary');
  });

  afterEach(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
    delete process.env.TEST_PROJECTS_DIR;
    delete process.env.TEST_ARCHIVE_DIR;
    delete process.env.TEST_DB_PATH;
  });

  it('deletes orphaned database entries during repair', async () => {
    // Initialize database with orphaned entry
    const db = initDatabase();

    const exchange: ConversationExchange = {
      id: 'orphan-repair-1',
      project: 'deleted-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'This conversation was deleted',
      assistantMessage: 'But still in database',
      archivePath: path.join(archiveDir, 'deleted-project', 'deleted.jsonl'),
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(1024).fill(0.1);
    insertExchange(db, exchange, embedding);
    db.close();

    // Verify it's there
    const dbBefore = initDatabase();
    const beforeCount = dbBefore.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE id = ?`).get('orphan-repair-1') as { count: number };
    expect(beforeCount.count).toBe(1);
    dbBefore.close();

    // Run repair
    const issues = await verifyIndex();
    expect(issues.orphaned.length).toBe(1);
    await repairIndex(issues);

    // Verify it's gone
    const dbAfter = initDatabase();
    const afterCount = dbAfter.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE id = ?`).get('orphan-repair-1') as { count: number };
    expect(afterCount.count).toBe(0);
    dbAfter.close();
  });

  it('re-indexes outdated files during repair', { timeout: 30000 }, async () => {
    // Create conversation file with summary
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });

    const conversationPath = path.join(projectArchive, 'outdated-repair.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');

    // Create initial conversation
    const messages = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: '2024-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi there!' }, timestamp: '2024-01-01T00:00:01Z' })
    ];
    fs.writeFileSync(conversationPath, messages.join('\n'));
    fs.writeFileSync(summaryPath, 'Old summary');

    // Index it
    const db = initDatabase();
    const exchange: ConversationExchange = {
      id: 'outdated-repair-1',
      project: 'test-project',
      timestamp: '2024-01-01T00:00:00Z',
      userMessage: 'Hello',
      assistantMessage: 'Hi there!',
      archivePath: conversationPath,
      lineStart: 1,
      lineEnd: 2
    };

    const embedding = new Array(1024).fill(0.1);
    insertExchange(db, exchange, embedding);

    // Get the last_indexed timestamp
    const beforeRow = db.prepare(`SELECT last_indexed FROM exchanges WHERE id = ?`).get('outdated-repair-1') as any;
    const beforeIndexed = beforeRow.last_indexed;
    db.close();

    // Wait a bit, then modify the file
    await new Promise(resolve => setTimeout(resolve, 10));

    // Update the conversation file (add new exchange)
    const updatedMessages = [
      ...messages,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'New message' }, timestamp: '2024-01-01T00:00:02Z' }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'New response' }, timestamp: '2024-01-01T00:00:03Z' })
    ];
    fs.writeFileSync(conversationPath, updatedMessages.join('\n'));

    // Verify detects outdated
    const issues = await verifyIndex();
    expect(issues.outdated.length).toBe(1);

    // Wait a bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    // Run repair
    await repairIndex(issues);

    // Verify it was re-indexed with new timestamp
    const dbAfter = initDatabase();
    const afterRow = dbAfter.prepare(`SELECT MAX(last_indexed) as last_indexed FROM exchanges WHERE archive_path = ?`).get(conversationPath) as any;
    expect(afterRow.last_indexed).toBeGreaterThan(beforeIndexed);

    // Verify no longer outdated
    const verifyAfter = await verifyIndex();
    expect(verifyAfter.outdated.length).toBe(0);

    dbAfter.close();
  });

  it('repair never summarizes a subagent transcript', async () => {
    const subagentDir = path.join(archiveDir, 'test-project', 'a8868824-cd73-4ec9-92e5-a3fb4e827c61', 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    const subagentPath = path.join(subagentDir, 'agent-abc123.jsonl');
    fs.writeFileSync(subagentPath, userAssistantLines('Subagent task', 'Subagent result'));

    const issues: VerificationResult = {
      missing: [],
      orphaned: [],
      outdated: [{ path: subagentPath, fileTime: 1, dbTime: 0 }],
      corrupted: []
    };
    await repairIndex(issues);

    expect(vi.mocked(summarizeConversation)).not.toHaveBeenCalled();
    const db = initDatabase();
    const row = db.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?`).get(subagentPath) as { count: number };
    db.close();
    expect(row.count).toBeGreaterThan(0);
  });

  it('repair writes an error sentinel for a missing summary that fails, and still indexes (#20)', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'fails.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    fs.writeFileSync(conversationPath, userAssistantLines('Will fail', 'Indeed'));
    vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error('boom'));

    await repairIndex({
      missing: [{ path: conversationPath, reason: 'No summary file' }],
      orphaned: [],
      outdated: [],
      corrupted: []
    });

    const content = fs.readFileSync(summaryPath, 'utf-8');
    expect(content.startsWith('__ERRORED__\n')).toBe(true);
    expect(content).toContain('boom');
    const db = initDatabase();
    const row = db.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?`).get(conversationPath) as { count: number };
    db.close();
    expect(row.count).toBeGreaterThanOrEqual(1);
  });

  it('repair keeps the old summary of an outdated conversation when re-summarizing fails', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'old.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    fs.writeFileSync(conversationPath, userAssistantLines('Old question', 'Old answer'));
    fs.writeFileSync(summaryPath, 'Old summary', 'utf-8');
    vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error('boom'));

    await repairIndex({
      missing: [],
      orphaned: [],
      outdated: [{ path: conversationPath, fileTime: 2, dbTime: 1 }],
      corrupted: []
    });

    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe('Old summary');
    // A summary failure must not stop indexing.
    const db = initDatabase();
    const row = db.prepare(`SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?`).get(conversationPath) as { count: number };
    db.close();
    expect(row.count).toBeGreaterThanOrEqual(1);
  });

  it('repair reports failed summaries instead of an unqualified success line (#20)', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const failedMissing = path.join(projectArchive, 'failed-missing.jsonl');
    const failedOutdated = path.join(projectArchive, 'failed-outdated.jsonl');
    fs.writeFileSync(failedMissing, userAssistantLines('Q1', 'A1'));
    fs.writeFileSync(failedOutdated, userAssistantLines('Q2', 'A2'));
    fs.writeFileSync(failedOutdated.replace('.jsonl', '-summary.txt'), 'Old summary', 'utf-8');
    vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error('boom1'));
    vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error('boom2'));

    const logSpy = vi.spyOn(console, 'log');
    try {
      await repairIndex({
        missing: [{ path: failedMissing, reason: 'No summary file' }],
        orphaned: [],
        outdated: [{ path: failedOutdated, fileTime: 2, dbTime: 1 }],
        corrupted: []
      });
      const lines = logSpy.mock.calls.map(c => String(c[0]));
      expect(lines).toContain(
        "⚠️  2 summaries failed: 1 marked for retry by the next verify --fix or sync; 1 kept the previous summary and won't be retried automatically."
      );
      expect(lines).not.toContain('✅ Repair complete.');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('repair prints the success line when no summary failed', async () => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'fine.jsonl');
    fs.writeFileSync(conversationPath, userAssistantLines());

    const logSpy = vi.spyOn(console, 'log');
    try {
      await repairIndex({
        missing: [{ path: conversationPath, reason: 'No summary file' }],
        orphaned: [],
        outdated: [],
        corrupted: []
      });
      const lines = logSpy.mock.calls.map(c => String(c[0]));
      expect(lines).toContain('✅ Repair complete.');
      expect(lines.some(l => l.includes('failed'))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each([
    ['an empty sentinel', () => ''],
    ['a stale __ERRORED__ file', () => formatErrorSentinel(new Error('old failure'))]
  ])('repair overwrites %s with a fresh error sentinel when an outdated re-summarize fails', async (_label, makeContent) => {
    const projectArchive = path.join(archiveDir, 'test-project');
    fs.mkdirSync(projectArchive, { recursive: true });
    const conversationPath = path.join(projectArchive, 'sentinel.jsonl');
    const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
    fs.writeFileSync(conversationPath, userAssistantLines());
    fs.writeFileSync(summaryPath, makeContent(), 'utf-8');
    vi.mocked(summarizeConversation).mockRejectedValueOnce(new Error('boom'));

    await repairIndex({
      missing: [],
      orphaned: [],
      outdated: [{ path: conversationPath, fileTime: 2, dbTime: 1 }],
      corrupted: []
    });

    const content = fs.readFileSync(summaryPath, 'utf-8');
    expect(content.startsWith('__ERRORED__\n')).toBe(true);
    expect(content).toContain('boom');
    expect(content).not.toContain('old failure');
  });

  it('repair summarizes a main transcript even when the archive root is under a "subagents" directory', async () => {
    const rootedArchive = path.join(testDir, 'subagents', 'archive');
    fs.mkdirSync(path.join(rootedArchive, 'test-project'), { recursive: true });
    process.env.TEST_ARCHIVE_DIR = rootedArchive;
    const conversationPath = path.join(rootedArchive, 'test-project', 'main-convo.jsonl');
    fs.writeFileSync(conversationPath, userAssistantLines());

    await repairIndex({
      missing: [{ path: conversationPath, reason: 'No summary file' }],
      orphaned: [],
      outdated: [],
      corrupted: []
    });

    expect(vi.mocked(summarizeConversation)).toHaveBeenCalledTimes(1);
  });
});
