import { describe, expect, it } from 'vitest';
import { isSubagentTranscript } from '../src/summary-sentinel.js';

describe('isSubagentTranscript (#31)', () => {
  const yes = [
    'a8868824-cd73-4ec9-92e5-a3fb4e827c61/subagents/agent-a81c86e504e1e7c14.jsonl',
    'a8868824-cd73-4ec9-92e5-a3fb4e827c61/subagents/workflows/wf_3b2e44d7-e36/agent-abc123.jsonl',
    'agent-afa95f98d145b3d2e.jsonl',                                        // legacy top-level
    'a8868824-cd73-4ec9-92e5-a3fb4e827c61\\subagents\\agent-abc123.jsonl',   // Windows separators
    'a8868824-cd73-4ec9-92e5-a3fb4e827c61/subagents/workflows/wf_3b2e44d7-e36/journal.jsonl', // segment rule alone
  ];

  const no = [
    'a8868824-cd73-4ec9-92e5-a3fb4e827c61.jsonl',
    '2026/09/12/rollout-2026-09-12T22-20-15-01a09747-1ecf-75f0-8707-fb9224971747.jsonl', // Codex
    'agent-transcripts/0b8e1f9e-1111-4222-8333-944455556666/0b8e1f9e-1111-4222-8333-944455556666.jsonl', // Cursor
    'opencode-ses_abc123.jsonl',   // opencode
    'omp-sess_abc.jsonl',          // OMP
    'my-subagents/x.jsonl',        // segment must equal 'subagents' exactly
    'test.jsonl',
    'notes-export.jsonl',
  ];

  it.each(yes)('treats %s as a subagent transcript', (p) => {
    expect(isSubagentTranscript(p)).toBe(true);
  });

  it.each(no)('does not treat %s as a subagent transcript', (p) => {
    expect(isSubagentTranscript(p)).toBe(false);
  });
});
