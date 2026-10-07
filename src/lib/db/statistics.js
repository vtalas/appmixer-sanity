import { getDb } from './index.js';

/**
 * Connector / component / E2E flow counts of git trees (plus the connector
 * directories, to tell which connectors came and went), by tree sha.
 * Content-addressed, so an entry never goes stale.
 * @param {string[]} treeShas
 * @returns {Promise<Map<string, {connectors: number, components: number, e2eFlows: number, roots?: string[]}>>}
 */
export async function getTreeCounts(treeShas) {
  const counts = new Map();
  if (treeShas.length === 0) return counts;
  const result = await getDb().execute({
    sql: `SELECT tree_sha, counts FROM statistics_tree_counts WHERE tree_sha IN (${treeShas.map(() => '?').join(', ')})`,
    args: treeShas
  });
  for (const row of result.rows) {
    try {
      counts.set(String(row.tree_sha), JSON.parse(String(row.counts)));
    } catch {
      // unreadable row — recomputed and overwritten
    }
  }
  return counts;
}

/**
 * @param {string} treeSha
 * @param {{connectors: number, components: number, e2eFlows: number, roots: string[]}} counts
 */
export async function saveTreeCounts(treeSha, counts) {
  await getDb().execute({
    sql: `INSERT OR REPLACE INTO statistics_tree_counts (tree_sha, counts) VALUES (?, ?)`,
    args: [treeSha, JSON.stringify(counts)]
  });
}
