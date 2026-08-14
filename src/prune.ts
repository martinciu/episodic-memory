import Database from 'better-sqlite3';

/**
 * Remove every indexed row belonging to a set of projects.
 *
 * `exclude.txt` / CONVERSATION_SEARCH_EXCLUDE_PROJECTS are consulted only while
 * walking source directories at index time (getExcludedProjects() in indexer.ts / sync.ts).
 * Adding a project to the exclude list therefore stops new rows appearing but leaves
 * everything already indexed in place and searchable. In practice users only reach for
 * the exclude list *after* something has flooded the index, which is exactly the point
 * at which it can no longer help — so there needs to be a way to remove what is already
 * there.
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
  // The loop below deletes vec0 rows one id at a time rather than via a subquery DELETE.
  // On the sqlite-vec version installed here a subquery DELETE does work, but the loop is
  // kept for port fidelity / compatibility with older sqlite-vec versions that don't
  // support it. This requires the sqlite-vec extension to be loaded on the connection —
  // initDatabase() does that. A client without it doesn't silently skip the vec table: it
  // raises "no such module: vec0" the moment it touches vec_exchanges. The real orphaning
  // mechanism is hand-written cleanup SQL that never references the vec table at all.
  const delVec = db.prepare('DELETE FROM vec_exchanges WHERE id = ?');
  const delExchanges = db.prepare(
    `DELETE FROM exchanges WHERE project IN (${placeholders})`
  );

  // tool_calls first: it carries an FK to exchanges (see #81).
  // The id snapshot is retaken inside the transaction so it and the deletes observe one
  // consistent state — a row committed by a concurrent writer (e.g. background sync)
  // between the pre-transaction estimate above and this callback must not be able to
  // leave a vector orphaned by working off a stale id list.
  // Run in immediate mode: the callback reads before it writes, and a deferred (read-first)
  // transaction that loses a race to a concurrent writer fails with un-retryable
  // SQLITE_BUSY_SNAPSHOT instead of waiting on busy_timeout.
  const run = db.transaction(() => {
    const txIds = (idsStmt.all(...projects) as { id: string }[]).map((r) => r.id);
    const toolsResult = delTools.run(...projects);
    let vectorsDeleted = 0;
    for (const id of txIds) vectorsDeleted += delVec.run(id).changes;
    const exchangesResult = delExchanges.run(...projects);

    result.toolCallsDeleted = toolsResult.changes;
    result.vectorsDeleted = vectorsDeleted;
    result.exchangesDeleted = exchangesResult.changes;
  });
  run.immediate();

  return result;
}
