import { createClient } from '@libsql/client';
import { env } from '$env/dynamic/private';

let db;

export function getDb() {
  if (!db) {
    db = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN
    });
  }
  return db;
}

// Initialize schema
export async function initializeDatabase() {
  const client = getDb();

  await client.execute(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT CHECK(status IN ('in_progress', 'completed')) DEFAULT 'in_progress'
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      test_run_id TEXT NOT NULL,
      connector_name TEXT NOT NULL,
      version TEXT NOT NULL,
      label TEXT,
      description TEXT,
      icon TEXT,
      status TEXT CHECK(status IN ('pending', 'ok', 'fail', 'blocked')) DEFAULT 'pending',
      blocked_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS components (
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      component_name TEXT NOT NULL,
      label TEXT,
      description TEXT,
      icon TEXT,
      version TEXT,
      is_private BOOLEAN DEFAULT FALSE,
      status TEXT CHECK(status IN ('pending', 'ok', 'fail')) DEFAULT 'pending',
      github_issue TEXT,
      tested_at DATETIME,
      FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
    )
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_connectors_test_run ON connectors(test_run_id)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_components_connector ON components(connector_id)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_test_runs_created ON test_runs(created_at DESC)`);
}
