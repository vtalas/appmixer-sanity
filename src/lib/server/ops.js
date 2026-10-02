/**
 * Operations overview (`/ops`): every moving part of the connector CI in one place.
 *
 * - Appmixer: the integration templates in the `appmixer-sanity-hub` category (the GitHub
 *   responders, PR labels, PR hygiene) with their instances, revision drift and errors.
 * - GitHub Actions: the latest runs of every workflow of the connectors repo.
 * - OpenClaw: the agent gateway on hetzner-appmixer-agents, through the status JSON the host
 *   publishes (`OPENCLAW_STATUS_URL` + `OPENCLAW_STATUS_TOKEN`).
 *
 * Each source is collected independently: one failing source is reported in its section
 * and never fails the page.
 */

import { env } from '$env/dynamic/private';
import {
  getAppmixerSession,
  findCategoryByName,
  listCategoryTemplates
} from '$lib/api/appmixer.js';
import { getGitHubConfig } from '$lib/api/github.js';

export const HUB_CATEGORY = 'appmixer-sanity-hub';
const ERROR_WINDOW_DAYS = 7;
const INACTIVE_DAYS = 30;

/** @param {unknown} err */
const message = (err) => (err instanceof Error ? err.message : String(err));

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} path
 * @param {Record<string, string | string[]>} [params]
 */
async function appmixerGet(baseUrl, token, path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  }
  const response = await fetch(`${baseUrl}${path}?${search}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Error count per day for the last ERROR_WINDOW_DAYS and the newest error of one flow.
 * The log search returns a daily histogram (`buckets`) next to the hits.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} flowId
 */
async function flowErrors(baseUrl, token, flowId) {
  const data = await appmixerGet(baseUrl, token, '/logs', {
    flowId,
    query: `severity:error AND gridTimestamp:>now-${ERROR_WINDOW_DAYS}d`,
    sort: 'gridTimestamp:desc',
    size: '1'
  });
  const buckets = (data.buckets || []).map((/** @type {any} */ b) => ({
    day: String(b.key_as_string || '').slice(0, 10),
    count: b.doc_count || 0
  }));
  const last = (data.hits || [])[0];
  return {
    total: buckets.reduce((/** @type {number} */ sum, /** @type {{count: number}} */ b) => sum + b.count, 0),
    buckets,
    last: last
      ? {
          at: last.gridTimestamp,
          // Flow-level errors (start, stop) carry no component.
          component:
            String(last.componentType || '')
              .split('.')
              .pop() || 'flow',
          message: firstLine(last.err) || String(last.msg || '')
        }
      : null
  };
}

/**
 * Newest log entry of a flow — when it last did anything.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} flowId
 */
async function lastActivity(baseUrl, token, flowId) {
  const data = await appmixerGet(baseUrl, token, '/logs', {
    flowId,
    sort: 'gridTimestamp:desc',
    size: '1'
  });
  return (data.hits || [])[0]?.gridTimestamp || null;
}

/** First line of an error stack stored as a JSON string. */
function firstLine(/** @type {unknown} */ err) {
  if (!err) return '';
  try {
    const parsed = typeof err === 'string' ? JSON.parse(err) : err;
    return String(parsed.message || parsed.stack || '').split('\n')[0];
  } catch {
    return String(err).split('\n')[0];
  }
}

/** @param {string} userId - caller's email, or '' for the env configuration */
export async function collectAppmixer(userId) {
  const { baseUrl, uiUrl, token } = await getAppmixerSession(userId);
  const category = await findCategoryByName(userId, HUB_CATEGORY);
  if (!category) {
    return { instanceUrl: baseUrl, uiUrl, category: null, templates: [] };
  }
  const templates = await listCategoryTemplates(userId, category.id);
  const instances = templates.length
    ? await appmixerGet(baseUrl, token, '/flows', {
        filter: ['type:integration-instance', ...templates.map((t) => `templateId:${t.flowId}`)],
        projection: 'flowId,name,stage,revision,templateId,started,stopped,mtime,userId',
        limit: '500'
      })
    : [];

  const enriched = await Promise.all(
    (Array.isArray(instances) ? instances : []).map(async (/** @type {any} */ instance) => {
      const [errors, active] = await Promise.all([
        flowErrors(baseUrl, token, instance.flowId).catch((err) => ({ error: message(err) })),
        lastActivity(baseUrl, token, instance.flowId).catch(() => null)
      ]);
      return { ...instance, errors, lastActivity: active };
    })
  );

  return {
    instanceUrl: baseUrl,
    uiUrl,
    category,
    templates: templates.map((template) => {
      const own = enriched.filter((i) => i.templateId === template.flowId);
      return {
        ...template,
        instances: own.map((i) => ({
          flowId: i.flowId,
          stage: i.stage,
          revision: i.revision ?? null,
          // An instance keeps the revision it was created from; update-instances does not
          // apply new components, so a lagging instance must be recreated.
          outdated:
            template.revision != null && i.revision != null && i.revision < template.revision,
          started: i.started || null,
          lastActivity: i.lastActivity,
          errors: i.errors
        }))
      };
    })
  };
}

/** @param {string} userId - caller's email, or '' for the env configuration */
export async function collectWorkflows(userId) {
  const { owner, repo, token } = await getGitHubConfig(userId);
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'appmixer-sanity-check',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  /** @param {string} path */
  const get = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
      headers
    });
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  };

  const { workflows = [] } = await get('/actions/workflows?per_page=100');
  const since = Date.now() - ERROR_WINDOW_DAYS * 24 * 3600 * 1000;
  const rows = await Promise.all(
    workflows
      .filter((/** @type {any} */ w) => w.state === 'active')
      .map(async (/** @type {any} */ w) => {
        const { workflow_runs: runs = [] } = await get(
          `/actions/workflows/${w.id}/runs?per_page=20`
        );
        const recent = runs.filter(
          (/** @type {any} */ r) => new Date(r.created_at).getTime() >= since
        );
        const last = runs[0];
        return {
          id: w.id,
          name: w.name,
          path: w.path,
          url: w.html_url,
          // GitHub keeps listing workflows whose file is gone or that nothing triggers any
          // more; one that has not run for INACTIVE_DAYS is not part of the live setup.
          inactive:
            !last ||
            Date.now() - new Date(last.created_at).getTime() > INACTIVE_DAYS * 24 * 3600 * 1000,
          last: last
            ? {
                status: last.status,
                conclusion: last.conclusion,
                event: last.event,
                branch: last.head_branch,
                at: last.created_at,
                url: last.html_url
              }
            : null,
          recent: {
            total: recent.length,
            failed: recent.filter((/** @type {any} */ r) => r.conclusion === 'failure').length,
            waiting: recent.filter(
              (/** @type {any} */ r) =>
                ['action_required', 'waiting'].includes(r.status) ||
                r.conclusion === 'action_required'
            ).length
          }
        };
      })
  );
  return { repo: `${owner}/${repo}`, workflows: rows.sort((a, b) => a.name.localeCompare(b.name)) };
}

export async function collectOpenClaw() {
  const url = env.OPENCLAW_STATUS_URL;
  const token = env.OPENCLAW_STATUS_TOKEN;
  if (!url || !token) {
    return { configured: false };
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`OpenClaw status: HTTP ${response.status}`);
  return { configured: true, ...(await response.json()) };
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<{ data: T | null, error: string | null }>}
 */
async function settle(fn) {
  try {
    return { data: await fn(), error: null };
  } catch (err) {
    return { data: null, error: message(err) };
  }
}

/** @param {string} userId - caller's email, or '' for the env configuration */
export async function buildOpsOverview(userId) {
  const [appmixer, workflows, openclaw] = await Promise.all([
    settle(() => collectAppmixer(userId)),
    settle(() => collectWorkflows(userId)),
    settle(() => collectOpenClaw())
  ]);
  return { generatedAt: new Date().toISOString(), appmixer, workflows, openclaw };
}
