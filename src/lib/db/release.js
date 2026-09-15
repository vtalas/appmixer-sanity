import { getDb } from './index.js';

const CHUNK = 200;

/**
 * bundle.json contents by git blob sha. Blobs are content-addressed, so an
 * entry never goes stale and the table is never invalidated.
 * @param {string[]} shas
 * @returns {Promise<Map<string, string>>}
 */
export async function getBundleBlobs(shas) {
  const chunks = [];
  for (let i = 0; i < shas.length; i += CHUNK) chunks.push(shas.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) =>
      getDb().execute({
        sql: `SELECT sha, content FROM release_bundle_blobs WHERE sha IN (${chunk.map(() => '?').join(', ')})`,
        args: chunk
      })
    )
  );

  const contents = new Map();
  for (const result of results) {
    for (const row of result.rows) {
      contents.set(String(row.sha), String(row.content));
    }
  }
  return contents;
}

/**
 * @param {Array<[string, string]>} entries - [blob sha, content]
 */
export async function saveBundleBlobs(entries) {
  if (entries.length === 0) return;
  await getDb().batch(
    entries.map(([sha, content]) => ({
      sql: `INSERT OR IGNORE INTO release_bundle_blobs (sha, content) VALUES (?, ?)`,
      args: [sha, content]
    })),
    'write'
  );
}
