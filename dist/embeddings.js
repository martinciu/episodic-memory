import { pipeline, env } from '@huggingface/transformers';
// Disable progress callbacks to prevent stdout pollution in MCP context
// In MCP, stdout is reserved for JSON-RPC communication.
env.allowLocalModels = true;
env.useBrowserCache = false;
/**
 * Embedding model configuration.
 *
 * Using BAAI's bge-m3 (via Xenova's ONNX export) instead of the English-only
 * bge-small-en-v1.5. This archive is a mixed Polish/English corpus, and an
 * EN-only encoder embeds Polish only as a fuzzy lexical match: paraphrase
 * queries with no token overlap return noise (measured 2026-08-13 — an
 * on-topic Polish paraphrase query scored 0/5 relevant results despite 85
 * matching exchanges in the index), and cross-lingual PL↔EN retrieval fails
 * entirely. bge-m3 is multilingual (~100 languages) with an aligned
 * cross-lingual space.
 *
 * Differences from bge-small-en handled here and in the schema:
 *   - 1024-dim dense vectors (EMBEDDING_DIM in embedding-migration.ts;
 *     vec_exchanges is rebuilt by migrateVecDimension in db.ts)
 *   - CLS pooling (the trained dense-retrieval output for bge-m3)
 *   - no query prefix — bge-m3 is trained prefix-free for both queries
 *     and passages
 */
const MODEL_ID = 'Xenova/bge-m3';
const MODEL_DTYPE = 'q8';
/**
 * Resolve an intra-op thread cap for the embedding session, or null to leave
 * onnxruntime at its default (one worker per core).
 *
 * Embedding is done one exchange at a time (batch=1) throughout indexing, sync,
 * and the re-embed migration. At that size onnxruntime-node's default intra-op
 * thread pool fans each tiny int8 matmul across every core, which on Apple
 * Silicon pegs ~5 cores for almost no throughput gain and makes a bulk re-embed
 * hog the whole machine. Capping intra-op threads keeps embedding off the
 * user's cores; measured on an M-series Mac, a cap of 2 is as fast or faster
 * than the uncapped default while using ~1.7 cores instead of ~5 (and pulls
 * further ahead when the machine is otherwise busy, since it stops the pool
 * from oversubscribing).
 *
 * This stays on the same CPU / q8 execution provider, so embeddings are
 * bit-identical to the uncapped output — no re-index is triggered. (CoreML and
 * WebGPU were evaluated and rejected: on this quantized model they either run
 * far slower and never leave the CPU, or require an fp32 model whose vectors
 * differ from the stored q8 ones and would force a full re-index.)
 *
 * Override with EPISODIC_MEMORY_EMBED_THREADS: a positive integer sets the cap;
 * 0 (or any non-positive/invalid value) restores onnxruntime's default.
 */
export function resolveIntraOpThreads() {
    const override = process.env.EPISODIC_MEMORY_EMBED_THREADS;
    if (override !== undefined) {
        const n = Number.parseInt(override, 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (process.platform === 'darwin' && process.arch === 'arm64') {
        return 2;
    }
    return null;
}
const DEFAULT_EMBED_MAX_CHARS = 4000;
/**
 * Resolve the character budget for a single embedding input. Override with
 * EPISODIC_MEMORY_EMBED_MAX_CHARS (positive integer); invalid or non-positive
 * values fall back to the default.
 */
export function resolveEmbedMaxChars() {
    const override = process.env.EPISODIC_MEMORY_EMBED_MAX_CHARS;
    if (override !== undefined) {
        const n = Number.parseInt(override, 10);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    return DEFAULT_EMBED_MAX_CHARS;
}
let embeddingPipeline = null;
export async function initEmbeddings() {
    if (!embeddingPipeline) {
        console.error('Loading embedding model (first run may take time)...');
        const options = {
            dtype: MODEL_DTYPE,
            progress_callback: () => { },
        };
        const intraOpThreads = resolveIntraOpThreads();
        if (intraOpThreads !== null) {
            options.session_options = {
                intraOpNumThreads: intraOpThreads,
                interOpNumThreads: 1,
            };
        }
        embeddingPipeline = await pipeline('feature-extraction', MODEL_ID, options);
        console.error('Embedding model loaded');
    }
}
export async function generateEmbedding(text) {
    if (!embeddingPipeline) {
        await initEmbeddings();
    }
    // Truncate to bound embedding cost. bge-m3 accepts up to 8192 tokens, so
    // bge-small's 512-token/2000-char ceiling no longer applies. 4000 chars
    // (~1000-1500 tokens for Polish, which tokenizes denser than English)
    // doubles the captured context while keeping CPU embed time reasonable for
    // bulk re-indexing. Override with EPISODIC_MEMORY_EMBED_MAX_CHARS.
    const truncated = text.substring(0, resolveEmbedMaxChars());
    const output = await embeddingPipeline(truncated, {
        // CLS pooling: bge-m3's dense-retrieval vector is the normalized CLS
        // token, not a mean over token states.
        pooling: 'cls',
        normalize: true,
    });
    return Array.from(output.data);
}
/**
 * Generate an embedding for a search QUERY. bge-m3 is trained prefix-free:
 * queries and passages share one embedding path, so this is a plain alias —
 * kept as a named entry point so call sites (and any future model with an
 * asymmetric query prefix) don't need to change.
 */
export async function generateQueryEmbedding(query) {
    return generateEmbedding(query);
}
export async function generateExchangeEmbedding(userMessage, assistantMessage, toolNames) {
    // Combine user question, assistant answer, and tools used for better searchability
    let combined = `User: ${userMessage}\n\nAssistant: ${assistantMessage}`;
    if (toolNames && toolNames.length > 0) {
        combined += `\n\nTools: ${toolNames.join(', ')}`;
    }
    return generateEmbedding(combined);
}
