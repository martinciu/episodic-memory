// Real conversational turns are ~1.6 KB median. A single message in the
// hundreds-of-KB-to-MB range is not a turn — it is a foreign summarizer agent's
// prompt with a whole conversation transcript pasted in, which otherwise indexes
// as one giant exchange that dominates the DB and pollutes vector search (#139).
// 256 KB is ~160x the median: far above any genuine turn (including a large code
// paste) yet well under those payloads. Cooperative marker opt-out
// (SUMMARIZER_CONTEXT_MARKER) still applies for our own summarizer; this is the
// non-cooperative backstop.
//
// Fork policy: oversize messages are TRUNCATED, not skipped. Upstream skips the
// whole exchange, which also drops the assistant's reply. On a real fork install
// the oversize population turned out to be Claude Code skill injections (the
// skill body arrives as a user turn) and genuine pastes (e.g. a 1 MB bank
// statement with a question) — each paired with a reply that is real work.
// Truncation bounds row size just as well and keeps the reply searchable.
export const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
/**
 * Resolve the per-message byte cap from EPISODIC_MEMORY_MAX_MESSAGE_BYTES.
 * Returns 0 when the cap is disabled (`0` or a negative value). Only a fully
 * numeric value is accepted: Number.parseInt happily reads a numeric prefix
 * ('256K' -> 256, '1e6' -> 1), which would cut every message to a stub, so
 * anything else falls back to the default.
 */
export function getMaxMessageBytes(env = process.env) {
    const raw = env.EPISODIC_MEMORY_MAX_MESSAGE_BYTES;
    if (raw === undefined)
        return DEFAULT_MAX_MESSAGE_BYTES;
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed))
        return DEFAULT_MAX_MESSAGE_BYTES;
    const parsed = Number.parseInt(trimmed, 10);
    return parsed > 0 ? parsed : 0;
}
export function isOversizeExchange(exchange, maxBytes) {
    return (maxBytes > 0 &&
        (Buffer.byteLength(exchange.userMessage ?? '', 'utf8') > maxBytes ||
            Buffer.byteLength(exchange.assistantMessage ?? '', 'utf8') > maxBytes));
}
const NOTICE_PREFIX = '\n\n[truncated by episodic-memory:';
const NOTICE_TAIL = /^ \d+ bytes exceeded the \d+-byte index cap\]$/;
/** Suffix appended to a truncated message, recording what was dropped. */
export function truncationNoticeFor(originalBytes, maxBytes) {
    return `${NOTICE_PREFIX} ${originalBytes} bytes exceeded the ${maxBytes}-byte index cap]`;
}
/**
 * Cap a message at `maxBytes` UTF-8 bytes for indexing, keeping the head so it
 * stays searchable and its source identifiable, and appending a notice that
 * records the original size. A no-op when the message fits or the cap is
 * disabled (0).
 *
 * Idempotent: our own output (head within the cap + notice) is returned as-is,
 * so the insertExchange backstop never stacks notices on a message the call
 * site already capped. The check is anchored to that exact shape — a message
 * that merely quotes the notice, or ends with one after an oversize head,
 * is still cut.
 */
export function truncateForIndex(message, maxBytes = getMaxMessageBytes()) {
    if (!message || maxBytes <= 0)
        return message;
    const buf = Buffer.from(message, 'utf8');
    if (buf.length <= maxBytes)
        return message;
    const noticeAt = message.lastIndexOf(NOTICE_PREFIX);
    if (noticeAt !== -1 &&
        NOTICE_TAIL.test(message.slice(noticeAt + NOTICE_PREFIX.length)) &&
        Buffer.byteLength(message.slice(0, noticeAt), 'utf8') <= maxBytes) {
        return message;
    }
    // Cut on a code point boundary: back off over UTF-8 continuation bytes (10xxxxxx).
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0xc0) === 0x80)
        end--;
    return buf.subarray(0, end).toString('utf8') + truncationNoticeFor(buf.length, maxBytes);
}
/**
 * Apply truncateForIndex to both messages of an exchange. Returns the input
 * object itself when nothing changed, otherwise a shallow copy.
 */
export function capExchangeForIndex(exchange, maxBytes) {
    const userMessage = truncateForIndex(exchange.userMessage, maxBytes);
    const assistantMessage = truncateForIndex(exchange.assistantMessage, maxBytes);
    if (userMessage === exchange.userMessage && assistantMessage === exchange.assistantMessage) {
        return exchange;
    }
    return { ...exchange, userMessage, assistantMessage };
}
