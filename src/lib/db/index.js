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
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_run_id) REFERENCES test_runs(id) ON DELETE CASCADE
    )
  `);

  // Migration: Add notes column if it doesn't exist
  try {
    await client.execute(`ALTER TABLE connectors ADD COLUMN notes TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

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
      github_issues TEXT,
      tested_at DATETIME,
      FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
    )
  `);

  // Migration: Add github_issues column if it doesn't exist and migrate data
  try {
    await client.execute(`ALTER TABLE components ADD COLUMN github_issues TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Migrate existing github_issue data to github_issues (as JSON array)
  await client.execute(`
    UPDATE components
    SET github_issues = json_array(github_issue)
    WHERE github_issue IS NOT NULL AND github_issue != '' AND (github_issues IS NULL OR github_issues = '')
  `);

  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_connectors_test_run ON connectors(test_run_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_components_connector ON components(connector_id)`
  );
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_test_runs_created ON test_runs(created_at DESC)`
  );

  // Settings table for app configuration (legacy global settings)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // User settings table for per-user configuration
  await client.execute(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, key)
    )
  `);

  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id)`
  );

  // Auth Hub verification status
  await client.execute(`
    CREATE TABLE IF NOT EXISTS authhub_status (
      service_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'not_verified',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // GitHub oauth2 connector cache
  await client.execute(`
    CREATE TABLE IF NOT EXISTS github_oauth_connectors (
      service_id TEXT PRIMARY KEY,
      path TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migrations
  try {
    await client.execute(`ALTER TABLE github_oauth_connectors ADD COLUMN github_version TEXT`);
  } catch {}
  try {
    await client.execute(
      `ALTER TABLE github_oauth_connectors ADD COLUMN is_oauth2 INTEGER NOT NULL DEFAULT 0`
    );
  } catch {}
  try {
    await client.execute(`ALTER TABLE authhub_status ADD COLUMN notes TEXT`);
  } catch {}

  // E2E test flows cache (GitHub dev branch merged with instance state),
  // scoped per Appmixer instance — different users may target different instances.
  const E2E_FLOWS_SCHEMA = `
    CREATE TABLE IF NOT EXISTS e2e_flows (
      instance_url TEXT NOT NULL,
      flow_name TEXT NOT NULL,
      connector TEXT,
      github_path TEXT,
      github_sha TEXT,
      github_hash TEXT,
      github_url TEXT,
      flow_id TEXT,
      stage TEXT,
      server_mtime TEXT,
      sync_status TEXT,
      last_result TEXT,
      last_result_at TEXT,
      last_result_detail TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (instance_url, flow_name)
    )
  `;
  await client.execute(E2E_FLOWS_SCHEMA);
  // Migration: the original table was single-instance (flow_name PK). It is just a
  // cache — drop and recreate with the composite key; the next Scan repopulates it.
  const flowCols = await client.execute(`PRAGMA table_info(e2e_flows)`);
  if (!flowCols.rows.some((c) => c.name === 'instance_url')) {
    await client.execute(`DROP TABLE e2e_flows`);
    await client.execute(E2E_FLOWS_SCHEMA);
  }
  // Migration: per-connector "account available on the instance" flag (0/1, NULL = unknown)
  try {
    await client.execute(`ALTER TABLE e2e_flows ADD COLUMN account_available INTEGER`);
  } catch {}

  // E2E run queue + history
  await client.execute(`
    CREATE TABLE IF NOT EXISTS e2e_runs (
      id TEXT PRIMARY KEY,
      flow_name TEXT NOT NULL,
      flow_id TEXT,
      state TEXT CHECK(state IN ('queued', 'running', 'passed', 'failed', 'timeout', 'error', 'cancelled')) DEFAULT 'queued',
      queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      finished_at DATETIME,
      baseline_result_at TEXT,
      error TEXT,
      detail TEXT,
      triggered_by TEXT
    )
  `);

  // Account service names present on an instance (snapshot taken during the
  // e2e scan) — lets PR views compute account availability for connectors
  // that have no cached flows (e.g. brand-new connectors added by a PR).
  await client.execute(`
    CREATE TABLE IF NOT EXISTS e2e_accounts (
      instance_url TEXT NOT NULL,
      service TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (instance_url, service)
    )
  `);

  // Open PRs of the connectors repo (cache refreshed by the PR scan),
  // scoped per repo — the instance join happens at read time.
  await client.execute(`
    CREATE TABLE IF NOT EXISTS e2e_prs (
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT,
      author TEXT,
      url TEXT,
      base_branch TEXT,
      head_branch TEXT,
      head_sha TEXT,
      draft INTEGER DEFAULT 0,
      pr_created_at TEXT,
      pr_updated_at TEXT,
      connectors TEXT,
      test_flows TEXT,
      files_count INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (repo, number)
    )
  `);

  // Migrations: merge-checklist data collected by the PR scan
  // (linked issues, E2E report found on the issue, CI state, mergeability)
  for (const column of [
    'head_committed_at TEXT',
    'mergeable INTEGER',
    'ci_status TEXT',
    'linked_issues TEXT',
    'e2e_report TEXT'
  ]) {
    try {
      await client.execute(`ALTER TABLE e2e_prs ADD COLUMN ${column}`);
    } catch {}
  }

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_e2e_runs_state ON e2e_runs(state)`);
  await client.execute(
    `CREATE INDEX IF NOT EXISTS idx_e2e_runs_flow ON e2e_runs(flow_name, queued_at DESC)`
  );
  // Migration: scope runs per instance (old rows keep NULL and drop out of scoped queries)
  try {
    await client.execute(`ALTER TABLE e2e_runs ADD COLUMN instance_url TEXT`);
  } catch {}
}
