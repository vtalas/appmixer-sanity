import { getDb } from './index.js';

// PR cache is scoped per repo ("owner/repo") — unlike the e2e_flows cache it is
// instance-independent; joining PRs with instance flow state happens at read time.

/**
 * Get all cached open PRs of one repo, newest activity first
 * @param {string} repo - "owner/repo"
 * @returns {Promise<Array<any>>}
 */
export async function getPRs(repo) {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM e2e_prs WHERE repo = ? ORDER BY pr_updated_at DESC`,
    args: [repo]
  });
  return result.rows.map(rowToPR);
}

/** @param {any} row */
function rowToPR(row) {
  return {
    repo: row.repo,
    number: Number(row.number),
    title: row.title,
    author: row.author,
    url: row.url,
    baseBranch: row.base_branch,
    headBranch: row.head_branch,
    headSha: row.head_sha,
    draft: Boolean(row.draft),
    createdAt: row.pr_created_at,
    updatedAt: row.pr_updated_at,
    connectors: safeParse(row.connectors) || [],
    testFlows: safeParse(row.test_flows) || [],
    filesCount: row.files_count == null ? null : Number(row.files_count),
    scannedAt: row.updated_at
  };
}

/** @param {any} value */
function safeParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Replace the PR cache of one repo with a fresh scan result
 * @param {string} repo - "owner/repo"
 * @param {Array<any>} prs - Objects in the same shape as rowToPR output
 */
export async function replacePRs(repo, prs) {
  const db = getDb();
  /** @type {Array<{sql: string, args: Array<any>}>} */
  const statements = [{ sql: `DELETE FROM e2e_prs WHERE repo = ?`, args: [repo] }];

  for (const pr of prs) {
    statements.push({
      sql: `INSERT OR REPLACE INTO e2e_prs
        (repo, number, title, author, url, base_branch, head_branch, head_sha, draft,
         pr_created_at, pr_updated_at, connectors, test_flows, files_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      args: [
        repo,
        pr.number,
        pr.title ?? null,
        pr.author ?? null,
        pr.url ?? null,
        pr.baseBranch ?? null,
        pr.headBranch ?? null,
        pr.headSha ?? null,
        pr.draft ? 1 : 0,
        pr.createdAt ?? null,
        pr.updatedAt ?? null,
        JSON.stringify(pr.connectors || []),
        JSON.stringify(pr.testFlows || []),
        pr.filesCount ?? null
      ]
    });
  }

  await db.batch(statements, 'write');
}
