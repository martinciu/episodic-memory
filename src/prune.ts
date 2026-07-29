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

export function pruneProjects(
  db: Database.Database,
  projects: string[],
  options: PruneOptions = {}
): PruneResult {
  const dryRun = options.dryRun === true;
  const result: PruneResult = {
    projects,
    exchangesDeleted: 0,
    toolCallsDeleted: 0,
    vectorsDeleted: 0,
    bytesFreed: 0,
    dryRun,
  };

  // An empty list must be a no-op. Building an `IN ()` clause from it would either be a
  // syntax error or, worse, match everything — deleting the entire index on a caller's
  // typo. Bail before any SQL is constructed.
  if (projects.length === 0) return result;

  const placeholders = projects.map(() => '?').join(',');
  const idsStmt = db.prepare(`SELECT id FROM exchanges WHERE project IN (${placeholders})`);
  const ids = (idsStmt.all(...projects) as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return result;

  const sizeRow = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(user_message) + LENGTH(assistant_message)), 0) AS bytes
       FROM exchanges WHERE project IN (${placeholders})`
    )
    .get(...projects) as { bytes: number };
  result.bytesFreed = sizeRow.bytes;

  const toolRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tool_calls
       WHERE exchange_id IN (SELECT id FROM exchanges WHERE project IN (${placeholders}))`
    )
    .get(...projects) as { n: number };
  result.toolCallsDeleted = toolRow.n;
  result.exchangesDeleted = ids.length;
  result.vectorsDeleted = ids.length;

  if (dryRun) return result;

  const delTools = db.prepare(
    `DELETE FROM tool_calls
     WHERE exchange_id IN (SELECT id FROM exchanges WHERE project IN (${placeholders}))`
  );
  // vec0 virtual tables support neither JOIN nor subquery in DELETE, so vectors go one
  // id at a time. This requires the sqlite-vec extension to be loaded on the connection —
  // initDatabase() does that. A client without it (e.g. Python's stock sqlite3) silently
  // skips the vec table and leaves orphaned vectors behind.
  const delVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
  const delExchanges = db.prepare(
    `DELETE FROM exchanges WHERE project IN (${placeholders})`
  );

  // tool_calls first: it carries an FK to exchanges (see #81).
  const run = db.transaction(() => {
    delTools.run(...projects);
    for (const id of ids) delVec.run(id);
    delExchanges.run(...projects);
  });
  run();

  return result;
}
