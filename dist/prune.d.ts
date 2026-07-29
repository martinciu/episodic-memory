import Database from 'better-sqlite3';
/**
 * Remove every indexed row belonging to a set of projects.
 *
 * `exclude.txt` / CONVERSATION_SEARCH_EXCLUDE_PROJECTS are consulted only while
 * walking source directories at index time (indexer.ts:62-63). Adding a project to
 * the exclude list therefore stops new rows appearing but leaves everything already
 * indexed in place and searchable. In practice users only reach for the exclude list
 * *after* something has flooded the index, which is exactly the point at which it can
 * no longer help — so there needs to be a way to remove what is already there.
 */
export interface PruneResult {
    projects: string[];
    exchangesDeleted: number;
    toolCallsDeleted: number;
    vectorsDeleted: number;
    /** Size of the user+assistant text removed. Not the on-disk saving — that needs VACUUM. */
    bytesFreed: number;
    dryRun: boolean;
}
export interface PruneOptions {
    /** Count what would be removed without touching the database. */
    dryRun?: boolean;
}
export declare function pruneProjects(db: Database.Database, projects: string[], options?: PruneOptions): PruneResult;
