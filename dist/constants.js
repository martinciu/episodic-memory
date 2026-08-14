/**
 * Marker text that identifies summarizer agent conversations.
 * When this text appears in a conversation, it will be excluded from indexing.
 * Used in summarizer prompts to prevent agent conversations from polluting search results.
 */
export const SUMMARIZER_CONTEXT_MARKER = 'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant';
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
export const MAX_INDEXED_MESSAGE_BYTES = (() => {
    const raw = process.env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES;
    if (raw === undefined)
        return 262_144;
    const trimmed = raw.trim();
    // Only accept a fully-numeric string. Number.parseInt happily parses a
    // leading numeric prefix ('256K' -> 256, '1e6' -> 1), which would silently
    // truncate every indexed message to a stub instead of failing safe.
    if (!/^-?\d+$/.test(trimmed))
        return 262_144;
    return Number.parseInt(trimmed, 10);
})();
/** Suffix appended to a truncated message, recording what was dropped. */
export function truncationNoticeFor(originalLength) {
    return `\n\n[truncated by episodic-memory: ${originalLength} chars exceeded the ${MAX_INDEXED_MESSAGE_BYTES}-char index cap]`;
}
/**
 * Cap a message for indexing, keeping the head so it stays searchable and the
 * source remains identifiable. Idempotent: re-truncating an already-truncated
 * string is a no-op, so re-indexing never stacks notices.
 */
export function truncateForIndex(message) {
    if (!message || MAX_INDEXED_MESSAGE_BYTES <= 0)
        return message;
    if (message.length <= MAX_INDEXED_MESSAGE_BYTES)
        return message;
    // Anchor the idempotency check to the tail instead of searching the whole
    // string: `includes()` used to exempt any message that merely *quoted* the
    // marker text anywhere in its body, which left oversized payloads
    // untruncated as long as they happened to mention the notice. The notice
    // truncateForIndex itself emits always starts exactly at the cap position.
    if (message.slice(MAX_INDEXED_MESSAGE_BYTES).startsWith('\n\n[truncated by episodic-memory:')) {
        return message;
    }
    return message.slice(0, MAX_INDEXED_MESSAGE_BYTES) + truncationNoticeFor(message.length);
}
