/**
 * Marker text that identifies summarizer agent conversations.
 * When this text appears in a conversation, it will be excluded from indexing.
 * Used in summarizer prompts to prevent agent conversations from polluting search results.
 */
export declare const SUMMARIZER_CONTEXT_MARKER = "Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant";
/**
 * Cap on how many characters of a single message we index.
 *
 * The EXCLUSION_MARKERS defence in sync.ts is *cooperative* — it only skips
 * transcripts from agents that emit a known marker. Third-party plugins that
 * summarize conversations (a common pattern) spawn subagents whose prompt embeds
 * the entire conversation being summarized, emit no marker, and are therefore
 * indexed like any other chat. The result is a "user message" of several MB.
 *
 * Measured on a real install before this guard existed:
 *   median user_message      1,636 bytes
 *   largest user_message  3,109,374 bytes
 *   1,301 such rows       2.53 GB = 97.2% of a 3.04 GB database
 *
 * 256 KB is ~150x the median, so no human-authored message comes close, while
 * machine-generated prompt payload is cut off. Override with
 * EPISODIC_MEMORY_MAX_MESSAGE_BYTES (0 or negative disables the guard).
 */
export declare const MAX_INDEXED_MESSAGE_BYTES: number;
/** Suffix appended to a truncated message, recording what was dropped. */
export declare function truncationNoticeFor(originalLength: number): string;
/**
 * Cap a message for indexing, keeping the head so it stays searchable and the
 * source remains identifiable. Idempotent: re-truncating an already-truncated
 * string is a no-op, so re-indexing never stacks notices.
 */
export declare function truncateForIndex(message: string): string;
