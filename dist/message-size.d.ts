export declare const DEFAULT_MAX_MESSAGE_BYTES: number;
/**
 * Resolve the per-message byte cap from EPISODIC_MEMORY_MAX_MESSAGE_BYTES.
 * Returns 0 when the cap is disabled (`0` or a negative value). Only a fully
 * numeric value is accepted: Number.parseInt happily reads a numeric prefix
 * ('256K' -> 256, '1e6' -> 1), which would cut every message to a stub, so
 * anything else falls back to the default.
 */
export declare function getMaxMessageBytes(env?: NodeJS.ProcessEnv): number;
export declare function isOversizeExchange(exchange: {
    userMessage?: string;
    assistantMessage?: string;
}, maxBytes: number): boolean;
/** Suffix appended to a truncated message, recording what was dropped. */
export declare function truncationNoticeFor(originalBytes: number, maxBytes: number): string;
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
export declare function truncateForIndex(message: string, maxBytes?: number): string;
/**
 * Apply truncateForIndex to both messages of an exchange. Returns the input
 * object itself when nothing changed, otherwise a shallow copy.
 */
export declare function capExchangeForIndex<T extends {
    userMessage: string;
    assistantMessage: string;
}>(exchange: T, maxBytes: number): T;
