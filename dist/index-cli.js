#!/usr/bin/env node
import { verifyIndex, repairIndex } from './verify.js';
import { indexSession, indexUnprocessed, indexConversations } from './indexer.js';
import { initDatabase } from './db.js';
import { getDbPath, getArchiveDir, statIfExists, getExcludedProjects } from './paths.js';
import { pruneProjects } from './prune.js';
import fs from 'fs';
import path from 'path';
const command = process.argv[2];
// Parse --concurrency flag from remaining args
function getConcurrency() {
    const concurrencyIndex = process.argv.findIndex(arg => arg === '--concurrency' || arg === '-c');
    if (concurrencyIndex !== -1 && process.argv[concurrencyIndex + 1]) {
        const value = parseInt(process.argv[concurrencyIndex + 1], 10);
        if (value >= 1 && value <= 16)
            return value;
    }
    return 1; // default
}
// Parse --no-summaries flag
function getNoSummaries() {
    return process.argv.includes('--no-summaries');
}
const concurrency = getConcurrency();
const noSummaries = getNoSummaries();
async function main() {
    try {
        switch (command) {
            case 'index-session':
                const sessionId = process.argv[3];
                if (!sessionId) {
                    console.error('Usage: index-cli index-session <session-id>');
                    process.exit(1);
                }
                await indexSession(sessionId, concurrency, noSummaries);
                break;
            case 'index-cleanup':
                await indexUnprocessed(concurrency, noSummaries);
                break;
            case 'verify':
                console.log('Verifying conversation index...');
                const issues = await verifyIndex();
                console.log('\n=== Verification Results ===');
                console.log(`Missing summaries: ${issues.missing.length}`);
                console.log(`Orphaned entries: ${issues.orphaned.length}`);
                console.log(`Outdated files: ${issues.outdated.length}`);
                console.log(`Corrupted files: ${issues.corrupted.length}`);
                if (issues.missing.length > 0) {
                    console.log('\nMissing summaries:');
                    issues.missing.forEach(m => console.log(`  ${m.path}`));
                }
                if (issues.missing.length + issues.orphaned.length + issues.outdated.length + issues.corrupted.length > 0) {
                    console.log('\nRun with --repair to fix these issues.');
                    process.exit(1);
                }
                else {
                    console.log('\n✅ Index is healthy!');
                }
                break;
            case 'repair':
                console.log('Verifying conversation index...');
                const repairIssues = await verifyIndex();
                if (repairIssues.missing.length + repairIssues.orphaned.length + repairIssues.outdated.length > 0) {
                    await repairIndex(repairIssues);
                }
                else {
                    console.log('✅ No issues to repair!');
                }
                break;
            case 'rebuild':
                console.log('Rebuilding entire index...');
                // Delete database
                const dbPath = getDbPath();
                if (fs.existsSync(dbPath)) {
                    fs.unlinkSync(dbPath);
                    console.log('Deleted existing database');
                }
                // Delete all summary files
                const archiveDir = getArchiveDir();
                if (fs.existsSync(archiveDir)) {
                    const projects = fs.readdirSync(archiveDir);
                    for (const project of projects) {
                        const projectPath = path.join(archiveDir, project);
                        if (!statIfExists(projectPath)?.isDirectory())
                            continue;
                        const summaries = fs.readdirSync(projectPath).filter(f => f.endsWith('-summary.txt'));
                        for (const summary of summaries) {
                            fs.unlinkSync(path.join(projectPath, summary));
                        }
                    }
                    console.log('Deleted all summary files');
                }
                // Re-index everything
                console.log('Re-indexing all conversations...');
                await indexConversations(undefined, undefined, concurrency, noSummaries);
                break;
            case 'prune': {
                // exclude.txt only stops *future* indexing (getExcludedProjects() in indexer.ts).
                // Without this, removing an already-indexed project meant hand-written SQL.
                // See upstream obra#141.
                const dryRun = process.argv.includes('--dry-run');
                const projectIdx = process.argv.findIndex(a => a === '--project');
                const isProjectTarget = projectIdx !== -1 && !!process.argv[projectIdx + 1];
                let targets;
                if (process.argv.includes('--excluded')) {
                    targets = getExcludedProjects();
                    if (targets.length === 0) {
                        console.log('No excluded projects configured — nothing to prune.');
                        console.log('Set CONVERSATION_SEARCH_EXCLUDE_PROJECTS or add entries to exclude.txt.');
                        break;
                    }
                }
                else if (projectIdx !== -1 && process.argv[projectIdx + 1]) {
                    targets = [process.argv[projectIdx + 1]];
                }
                else {
                    console.error('Usage: index-cli prune (--excluded | --project <name>) [--dry-run]');
                    process.exit(1);
                }
                console.log(`Pruning ${targets.length} project(s): ${targets.join(', ')}`);
                const pdb = initDatabase();
                const res = pruneProjects(pdb, targets, { dryRun });
                pdb.close();
                console.log(`  exchanges  : ${res.exchangesDeleted}`);
                console.log(`  tool_calls : ${res.toolCallsDeleted}`);
                console.log(`  vectors    : ${res.vectorsDeleted}`);
                console.log(`  text freed : ${(res.bytesFreed / 1024 ** 2).toFixed(1)} MB`);
                if (dryRun) {
                    console.log('\nDry run — nothing was deleted. Re-run without --dry-run to apply.');
                }
                else if (res.exchangesDeleted > 0) {
                    // Deleting rows alone reclaims no disk space; SQLite keeps the freed pages.
                    console.log('\nRows removed. Run `index vacuum` to return the freed pages to disk.');
                    if (isProjectTarget) {
                        // The archives are untouched, so the indexer's high-water mark for this
                        // project's archive files drops back to 0 on the next run and re-inserts
                        // everything, unless the project is also excluded from future indexing.
                        console.log('This prune is permanent only if you also add the project to `exclude.txt` ' +
                            'or `CONVERSATION_SEARCH_EXCLUDE_PROJECTS` — otherwise the next `index` run ' +
                            'will re-index it from the archives.');
                    }
                }
                break;
            }
            case 'vacuum': {
                // SQLite never returns freed pages to the filesystem on its own, and nothing
                // else in this codebase runs VACUUM. Deleting rows therefore reclaims no disk
                // space, which reads to users as "deleting didn't work". See upstream obra#140.
                const dbPath = getDbPath();
                // Open first: initDatabase() creates the file and runs migrations, so measuring
                // before that reports 0 on a fresh DB and a negative "reclaimed" figure.
                const db = initDatabase();
                const before = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
                const freePages = db.prepare('PRAGMA freelist_count').get()
                    .freelist_count;
                const pageSize = db.prepare('PRAGMA page_size').get().page_size;
                console.log(`Database: ${dbPath}`);
                console.log(`  size before : ${(before / 1024 ** 2).toFixed(1)} MB`);
                console.log(`  free pages  : ${freePages} (~${((freePages * pageSize) / 1024 ** 2).toFixed(1)} MB reclaimable)`);
                console.log('Running VACUUM (needs temporary free space ~= database size)...');
                const started = Date.now();
                db.exec('VACUUM');
                db.close();
                const after = fs.statSync(dbPath).size;
                const freed = before - after;
                const elapsed = ((Date.now() - started) / 1000).toFixed(1);
                console.log(`  size after  : ${(after / 1024 ** 2).toFixed(1)} MB`);
                if (freed > 0) {
                    console.log(`  reclaimed   : ${(freed / 1024 ** 2).toFixed(1)} MB` +
                        (before > 0 ? ` (${((freed / before) * 100).toFixed(1)}%)` : '') +
                        ` in ${elapsed}s`);
                }
                else if (freed === 0) {
                    console.log(`  nothing to reclaim (${elapsed}s)`);
                }
                else {
                    // VACUUM also checkpoints the WAL into the main file, so a database with
                    // little or no free space can legitimately end up slightly larger. Reporting
                    // that as a negative "reclaimed" figure reads like a failure; it isn't.
                    console.log(`  nothing to reclaim — file grew ${(Math.abs(freed) / 1024 ** 2).toFixed(1)} MB ` +
                        `as VACUUM checkpointed the WAL into it (${elapsed}s)`);
                }
                break;
            }
            case 'index-all':
            default:
                await indexConversations(undefined, undefined, concurrency, noSummaries);
                break;
        }
    }
    catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}
main();
