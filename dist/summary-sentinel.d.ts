/**
 * Sentinel file format for `<archive>/<project>/<session>-summary.txt`:
 *
 * - File missing → conversation has not been processed; queue for summarization.
 * - File empty → permanent skip (zero-exchange / metadata-only file; #91).
 * - File starts with `__ERRORED__\n` → previous summarization failed.
 *   Skip-then-retry: if mtime is older than the retry threshold, the file is
 *   re-queued; otherwise it's treated as "recently failed, leave alone".
 * - Anything else → real summary content.
 *
 * The error-marker path is what fixes #96: previously a failed summarization
 * wrote no sentinel at all, so the file re-queued every sync run forever and
 * could pin the head of the queue.
 */
export declare const ERROR_MARKER = "__ERRORED__";
export declare function formatErrorSentinel(error: unknown): string;
export declare function isErroredSentinel(content: string): boolean;
/**
 * True when the sentinel at `summaryPath` represents a real summary —
 * a non-empty file that is not an error marker. Empty zero-exchange
 * sentinels and error sentinels both return false. Use this for callers
 * that care about "is this conversation summarized and useful" (stats,
 * verify, search).
 */
export declare function hasRealSummary(summaryPath: string): boolean;
/**
 * True when `projectRelativePath` (a transcript path relative to its project
 * dir, e.g. `<uuid>/subagents/agent-<hex>.jsonl`) is a Claude subagent or
 * workflow transcript (#31). Matches when the basename is `agent-<hex>.jsonl`
 * (also the legacy top-level shape), or when a directory segment equals
 * `subagents`. Pure string logic: no fs access, and it never sees anything
 * above the project dir, so an archive root that happens to contain
 * `subagents` can't match. Accepts both `/` and `\` separators.
 *
 * Policy: these transcripts are archived and indexed, and searchable via
 * `include_sidechains`, but never summarized. Summaries are display-only, and
 * subagent runs made up most of the summary backlog. This is a fork-only
 * divergence from upstream.
 */
export declare function isSubagentTranscript(projectRelativePath: string): boolean;
/**
 * True when the conversation at `summaryPath` should be (re-)summarized:
 * no sentinel yet, or a stale error marker.
 */
export declare function shouldQueueForSummary(summaryPath: string): boolean;
