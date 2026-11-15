#!/usr/bin/env node
// Opt-in live check for #31: a summarizer query must not leave an
// `ai-title`-only session file under ~/.claude/projects/.
//
// Two real (non-resume) summarizer queries, each in its own fresh mkdtemp
// workspace so any stub lands in a project dir that only this script created:
//   - control: the product's query options with both CLI title gates removed:
//     CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC (set by getApiEnv()) and
//     CLAUDE_CODE_DISABLE_TERMINAL_TITLE (in case the shell sets it). It must
//     produce a title-only stub; if it doesn't, this check cannot see stubs and fails.
//   - fixed: the product's buildSummarizerQueryOptions()/getApiEnv() options,
//     with cwd pointed at the workspace. It must produce no *.jsonl at all and
//     return a non-empty summary.
//
// Cost: two summarizer queries (Haiku unless EPISODIC_MEMORY_API_MODEL is set).
// The control also triggers the CLI's own title call. Uses real Claude Code auth.
// Run: npm run build, then
//   EPISODIC_MEMORY_RUN_CLAUDE_E2E=1 npm run test:summarizer-title-e2e
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_SUMMARIZER = path.join(REPO_ROOT, 'dist', 'summarizer.js');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'short-conversation.jsonl');

const POLL_INTERVAL_MS = 1000;
const POLL_WINDOW_MS = 30000;

function die(message) {
  console.error(`summarizer-title-e2e: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function listDirNames(dir) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  );
}

// Project dirs that did not exist before this case and whose encoded name ends
// with the workspace basename. Only these are ever inspected or deleted.
function candidateDirs(projectsRoot, before, workspace) {
  const suffix = path.basename(workspace);
  return [...listDirNames(projectsRoot)]
    .filter(name => !before.has(name) && name.endsWith(suffix))
    .map(name => path.join(projectsRoot, name));
}

function jsonlFiles(dirs) {
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

function isTitleOnly(file) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(line => line.trim());
  if (lines.length === 0) return false;
  return lines.every(line => {
    try {
      return JSON.parse(line).type === 'ai-title';
    } catch {
      return false;
    }
  });
}

async function buildPrompt(SUMMARIZER_CONTEXT_MARKER, parseConversation, formatConversationText) {
  // Production-shaped prompt (same instruction text summarizeConversation
  // uses for the direct path) so the query runs long enough for the CLI's
  // async title write to land before the subprocess is torn down.
  const exchanges = await parseConversation(FIXTURE, 'summarizer-title-e2e', FIXTURE);
  if (exchanges.length === 0) {
    throw new Error(`fixture ${FIXTURE} parsed to zero exchanges`);
  }
  const conversationText = formatConversationText(exchanges.slice(0, 15));
  return `${SUMMARIZER_CONTEXT_MARKER}.

Please write a concise, factual summary of this conversation. Output ONLY the summary - no preamble. Claude will see this summary when searching previous conversations for useful memories and information.

Summarize what happened in 2-4 sentences. Be factual and specific. Output in <summary></summary> tags.

Include:
- What was built/changed/discussed (be specific)
- Key technical decisions or approaches
- Problems solved or current state

Exclude:
- Apologies, meta-commentary, or your questions
- Raw logs or debug output
- Generic descriptions - focus on what makes THIS conversation unique

Good:
<summary>Built JWT authentication for React app with refresh tokens and protected routes. Fixed token expiration bug by implementing refresh-during-request logic.</summary>

Bad:
<summary>I apologize. The conversation discussed authentication and various approaches were considered...</summary>

${conversationText}`;
}

async function runCase({ label, stripTitleGuard, projectsRoot, prompt, deps }) {
  const { query, buildSummarizerQueryOptions, runSummarizerQuery, summaryTimeoutMs } = deps;
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'em-title-e2e-')));
  const before = listDirNames(projectsRoot);
  let created = [];

  try {
    const options = {
      ...buildSummarizerQueryOptions({ model: process.env.EPISODIC_MEMORY_API_MODEL || 'haiku' }),
      cwd: workspace,
    };
    if (stripTitleGuard) {
      const env = { ...options.env };
      delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
      // The CLI's second title gate, removed in case the shell sets it.
      delete env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE;
      options.env = env;
    }

    const text = await runSummarizerQuery(query, prompt, options, summaryTimeoutMs());

    // The title write is async: poll. The control stops at the first file it
    // sees; the fixed run waits the full window before declaring "no stub".
    let files = [];
    const start = Date.now();
    while (Date.now() - start < POLL_WINDOW_MS) {
      created = candidateDirs(projectsRoot, before, workspace);
      files = jsonlFiles(created);
      if (stripTitleGuard && files.length > 0) break;
      await sleep(POLL_INTERVAL_MS);
    }
    created = candidateDirs(projectsRoot, before, workspace);
    files = jsonlFiles(created);

    const inspected = created.length > 0 ? created.join(', ') : `(no new project dir ending in ${path.basename(workspace)})`;
    let ok;
    let detail;
    if (stripTitleGuard) {
      if (files.length === 0) {
        ok = false;
        detail = 'control produced no stub; this check cannot see stubs';
      } else {
        const notTitleOnly = files.filter(file => !isTitleOnly(file));
        ok = notTitleOnly.length === 0;
        detail = ok
          ? `${files.length} ai-title-only file(s): ${files.join(', ')}`
          : `file(s) with non-ai-title lines: ${notTitleOnly.join(', ')}`;
      }
    } else {
      if (files.length > 0) {
        ok = false;
        detail = `found *.jsonl after the fix: ${files.join(', ')}`;
      } else if (!text.trim()) {
        ok = false;
        detail = 'summary text was empty';
      } else {
        ok = true;
        detail = `no *.jsonl after ${POLL_WINDOW_MS / 1000}s; summary: ${text.trim().slice(0, 120)}`;
      }
    }

    console.log(`${ok ? 'PASS' : 'FAIL'} [${label}] workspace=${workspace}`);
    console.log(`  inspected: ${inspected}`);
    console.log(`  ${detail}`);
    return ok;
  } finally {
    // Clean up only what this case created: its workspace and the project dirs
    // that are new and end with the workspace basename.
    for (const dir of candidateDirs(projectsRoot, before, workspace)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.EPISODIC_MEMORY_RUN_CLAUDE_E2E !== '1') {
    die('this check uses real Claude Code auth. Re-run with EPISODIC_MEMORY_RUN_CLAUDE_E2E=1 npm run test:summarizer-title-e2e');
  }
  if (!fs.existsSync(DIST_SUMMARIZER)) {
    die('dist/summarizer.js is missing. Run npm run build first.');
  }

  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { buildSummarizerQueryOptions, runSummarizerQuery, summaryTimeoutMs, formatConversationText } =
    await import('../dist/summarizer.js');
  const { SUMMARIZER_CONTEXT_MARKER } = await import('../dist/constants.js');
  const { parseConversation } = await import('../dist/parser.js');

  const projectsRoot = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const prompt = await buildPrompt(SUMMARIZER_CONTEXT_MARKER, parseConversation, formatConversationText);
  const deps = { query, buildSummarizerQueryOptions, runSummarizerQuery, summaryTimeoutMs };

  console.log(`projects root: ${projectsRoot}`);
  const controlOk = await runCase({ label: 'control: title guard removed', stripTitleGuard: true, projectsRoot, prompt, deps });
  const fixedOk = await runCase({ label: 'fixed: product options', stripTitleGuard: false, projectsRoot, prompt, deps });

  if (controlOk && fixedOk) {
    console.log('PASS summarizer-title-e2e');
    process.exit(0);
  }
  console.log('FAIL summarizer-title-e2e');
  process.exit(1);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
