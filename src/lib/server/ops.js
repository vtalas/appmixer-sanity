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
// Run tree of an instance: runs per page, the entries read to find a page and to read its
// runs in full, and how much of one entry is sent
const RUNS_PAGE = 10;
const HEAD_ENTRIES = 40;
const RUN_ENTRIES = 1000;
const DETAIL_LIMIT = 20000;
/** Node of the entries that belong to no component: the flow was started or stopped. */
const FLOW_NODE = 'flow';

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
    total: buckets.reduce(
      (/** @type {number} */ sum, /** @type {{count: number}} */ b) => sum + b.count,
      0
    ),
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

/** Out port names per component type, kept for the life of the server process. */
const outPortCache = new Map();

/**
 * The out ports a component declares — the branches it could have taken, so a run can show
 * the ones it did not take (Condition's `false`) next to the ones it did.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} type
 * @returns {Promise<string[]>}
 */
function outPortNames(baseUrl, token, type) {
  const key = `${baseUrl}|${type}`;
  if (!outPortCache.has(key)) {
    outPortCache.set(
      key,
      appmixerGet(baseUrl, token, '/components', { selector: type })
        .then((list) =>
          (list.find((/** @type {any} */ c) => c.name === type)?.outPorts || []).map(
            (/** @type {any} */ port) => (typeof port === 'string' ? port : port.name)
          )
        )
        .catch(() => {
          outPortCache.delete(key);
          return [];
        })
    );
  }
  return outPortCache.get(key);
}

/**
 * One page of the runs of an integration instance, newest first, for the run tree on /ops.
 * A run is one firing of the trigger with everything it set off; each run is a tree of the
 * components it went through.
 * @param {string} userId - caller's email, or '' for the env configuration
 * @param {string} flowId
 * @param {{ errorsOnly?: boolean, before?: string }} [options] - `before` is the `next` of
 *   the page above: only runs that started earlier are returned
 * @returns {Promise<{ runs: any[], next: string | null }>}
 */
export async function listFlowRuns(userId, flowId, { errorsOnly = false, before = '' } = {}) {
  const { baseUrl, token } = await getAppmixerSession(userId);
  /** @param {string} query @param {number} size */
  const search = async (query, size) => {
    const data = await appmixerGet(baseUrl, token, '/logs', {
      flowId,
      query,
      sort: 'gridTimestamp:desc',
      size: String(size)
    });
    return /** @type {any[]} */ (data.hits || []);
  };
  /** @param {string[]} ids */
  const anyOf = (ids) => `(${ids.map((id) => `"${id}"`).join(' OR ')})`;

  // The flow itself tells which components are triggers, and gives error entries the label
  // and the sender they do not carry.
  const definition = await appmixerGet(baseUrl, token, `/flows/${flowId}`, { projection: 'flow' });
  /** @type {Record<string, any>} */
  const components = definition?.flow || {};
  const triggers = Object.keys(components).filter(
    (id) => !Object.keys(components[id].source || {}).length
  );

  // A page is found by its runs' first entries alone, so that only the runs it shows are
  // read in full. A run starts where a trigger sends its output, or at an entry that belongs
  // to no run: a failed poll, the flow being started. With errors only, at an error.
  const starts = errorsOnly
    ? 'severity:error'
    : [
        ...(triggers.length ? [`(portType:out AND componentId:${anyOf(triggers)})`] : []),
        '(NOT _exists_:correlationId)'
      ].join(' OR ');
  const heads = await search(
    before ? `(${starts}) AND gridTimestamp:{* TO "${before}"}` : starts,
    HEAD_ENTRIES
  );
  const found = groupRuns(heads).reverse();
  const page = found.slice(0, RUNS_PAGE);
  const more = found.length > RUNS_PAGE || heads.length === HEAD_ENTRIES;

  const ids = [...new Set(page.map((group) => group.hits[0].correlationId).filter(Boolean))];
  const correlated = ids.length ? await search(`correlationId:${anyOf(ids)}`, RUN_ENTRIES) : [];
  const hits = [
    ...correlated,
    ...page.flatMap((group) => group.hits).filter((hit) => !hit.correlationId)
  ];

  const types = [
    ...new Set(
      hits.map((hit) => hit.componentType || components[hit.componentId]?.type).filter(Boolean)
    )
  ];
  const ports = Object.fromEntries(
    await Promise.all(types.map(async (type) => [type, await outPortNames(baseUrl, token, type)]))
  );

  const runs = groupRuns(hits)
    .map((group) => buildRun(group, components, ports))
    .reverse();
  return {
    // Runs too long to be read whole lose their beginning: what is left of them starts at a
    // component that has an input, not at a trigger.
    runs:
      correlated.length === RUN_ENTRIES
        ? runs.filter((run) => !Object.keys(components[run.root.id]?.source || {}).length)
        : runs,
    // Where the next page starts: before the oldest run of this one
    next: more && page.length ? page[page.length - 1].hits[0].gridTimestamp : null
  };
}

/**
 * Splits log entries into runs, oldest first. Entries of one run share a correlationId. A
 * failed poll of a trigger has none — nothing was triggered yet — and is logged twice within
 * a few ms (by the component and by the scheduler), so uncorrelated entries of one component
 * that close together are one run.
 * @param {any[]} hits
 */
function groupRuns(hits) {
  const time = (/** @type {any} */ hit) => new Date(hit.gridTimestamp).getTime();
  /** @type {Array<{ id: string, hits: any[] }>} */
  const groups = [];
  const correlated = new Map();
  /** @type {{ componentId: string, at: number, group: { hits: any[] } } | null} */
  let loose = null;
  // Entries of the same millisecond keep one order, so a run has the same id on every request
  const inOrder = [...hits].sort(
    (a, b) => time(a) - time(b) || String(a._id).localeCompare(String(b._id))
  );
  for (const hit of inOrder) {
    if (hit.correlationId) {
      let group = correlated.get(hit.correlationId);
      if (!group) {
        group = { id: hit.correlationId, hits: [] };
        correlated.set(hit.correlationId, group);
        groups.push(group);
      }
      group.hits.push(hit);
    } else if (loose && loose.componentId === hit.componentId && time(hit) - loose.at < 1000) {
      loose.group.hits.push(hit);
    } else {
      const group = { id: hit._id, hits: [hit] };
      groups.push(group);
      loose = { componentId: hit.componentId, at: time(hit), group };
    }
  }
  return groups;
}

/**
 * One run as a tree: the trigger at the root, under each component the components its output
 * went to.
 * @param {{ id: string, hits: any[] }} group - entries of the run, oldest first
 * @param {Record<string, any>} components - the flow definition, by component id
 * @param {Record<string, string[]>} ports - declared out ports, by component type
 */
function buildRun(group, components, ports) {
  /** @type {Map<string, any>} */
  const nodes = new Map();
  for (const hit of group.hits) {
    const id = hit.componentId || FLOW_NODE;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        type: hit.componentType || components[id]?.type || null,
        label: components[id]?.label || null,
        parent: null,
        viaPort: null,
        fired: /** @type {Record<string, number>} */ ({}),
        errors: 0,
        error: '',
        lastOutput: 0,
        lastError: 0,
        output: null,
        received: new Set(),
        entries: []
      });
    }
    const node = nodes.get(id);
    const at = new Date(hit.gridTimestamp).getTime();
    const error = errorLine(hit.err);
    node.type ||= hit.componentType || null;
    node.label ||= hit.tgtComponentLabel || hit.srcComponentLabel || null;
    if (hit.portType === 'in' && !node.parent && hit.senderId && hit.senderId !== id) {
      node.parent = hit.senderId;
      node.viaPort = hit.senderPort || null;
    }
    // A component that fails logs no input: its error entry brings the messages it was
    // processing, and with them who sent them.
    for (const [port, messages] of Object.entries(inputMessages(hit))) {
      for (const message of messages) {
        const { messageId, sender } = message?.properties || {};
        if (!node.parent && sender?.componentId && sender.componentId !== id) {
          node.parent = sender.componentId;
          node.viaPort = sender.outputPort || null;
        }
        // Every attempt repeats the message it failed on
        if (!messageId || node.received.has(messageId)) continue;
        node.received.add(messageId);
        // What it received goes before what went wrong with it
        const firstError = node.entries.findIndex(
          (/** @type {any} */ entry) => entry.severity === 'error'
        );
        node.entries.splice(firstError < 0 ? node.entries.length : firstError, 0, {
          id: `${hit._id}:${messageId}`,
          at: hit.gridTimestamp,
          severity: 'info',
          direction: 'in',
          port,
          summary: summarize(message.content),
          detail: redact(pretty(message.content)).slice(0, DETAIL_LIMIT)
        });
      }
    }
    if (hit.portType === 'out' && hit.port) {
      node.fired[hit.port] = (node.fired[hit.port] || 0) + 1;
      node.lastOutput = at;
      node.output ??= hit.msg;
    }
    if (hit.severity === 'error') {
      node.errors += 1;
      const text = redact(error || String(hit.msg || ''));
      // The same failure is logged again without the remote API's reason; keep the fuller one
      if (!node.error.startsWith(text)) node.error = text;
      node.lastError = at;
    }
    // A retry that goes through logs the input its failed attempts have already shown
    if (hit.portType === 'in' && hit.messageId) {
      if (node.received.has(hit.messageId)) continue;
      node.received.add(hit.messageId);
    }
    node.entries.push({
      id: hit._id,
      at: hit.gridTimestamp,
      severity: hit.severity || 'info',
      // in = message delivered to the component, out = message it sent from a port
      direction: hit.portType || null,
      port: hit.port || null,
      summary: error ? redact(error) : summarize(hit.msg),
      // The full payload or error stack, shown when the entry is expanded
      detail: redact(pretty(hit.err) || pretty(hit.msg)).slice(0, DETAIL_LIMIT)
    });
  }

  for (const node of nodes.values()) {
    node.label ||=
      String(node.type || '')
        .split('.')
        .pop() || 'Flow';
    // An error followed by an output is a failed attempt that a retry made good
    node.failed = node.errors > 0 && node.lastOutput <= node.lastError;
    if (node.parent && nodes.has(node.parent)) continue;
    node.parent = null;
    // A component that failed logged no input, which is where the sender is named; the
    // flow's own wiring tells what it hangs on.
    for (const sources of Object.values(components[node.id]?.source || {})) {
      const from = Object.keys(sources).find((id) => id !== node.id && nodes.has(id));
      if (from) {
        const wired = /** @type {string[]} */ (sources[from] || []);
        node.parent = from;
        node.viaPort = wired.find((port) => nodes.get(from).fired[port]) ?? wired[0] ?? null;
        break;
      }
    }
  }

  const all = [...nodes.values()];
  const root = all.find((node) => !node.parent) || all[0];
  const placed = new Set([root.id]);

  /** @param {any} node @returns {any} */
  const view = (node) => {
    const below = all.filter(
      (child) =>
        !placed.has(child.id) &&
        // Whatever else has no parent in this run hangs on the root, so nothing gets lost
        (child.parent === node.id || (node === root && !child.parent))
    );
    below.forEach((child) => placed.add(child.id));
    const children = below.map((child) => ({
      port: child.parent === node.id ? child.viaPort : null,
      node: view(child)
    }));
    const names = [
      ...new Set([
        ...(ports[node.type] || []),
        ...Object.keys(node.fired),
        ...children.map((child) => child.port).filter(Boolean)
      ])
    ];
    // A component with one out port has no branches to show: its children hang on it directly
    const branches = names.length > 1;
    return {
      id: node.id,
      label: node.label,
      type: node.type,
      status: node.failed ? 'error' : node.id === FLOW_NODE ? 'info' : 'ok',
      retries: node.failed ? 0 : node.errors,
      error: node.failed ? node.error : '',
      failing: node.failed || children.some((child) => child.node.failing),
      entries: node.entries,
      ports: branches
        ? names.map((name) => ({
            name,
            fired: node.fired[name] || 0,
            children: children.filter((child) => child.port === name).map((child) => child.node)
          }))
        : null,
      children: children.filter((child) => !branches || !child.port).map((child) => child.node)
    };
  };
  const tree = view(root);
  // Components caught in a cycle are reachable from no root; hang them on it as well
  for (const node of all) {
    if (!placed.has(node.id)) {
      placed.add(node.id);
      tree.children.push(view(node));
    }
  }

  const failed = all.find((node) => node.failed);
  const first = group.hits[0];
  const last = group.hits[group.hits.length - 1];
  return {
    id: group.id,
    at: first.gridTimestamp,
    durationMs: new Date(last.gridTimestamp).getTime() - new Date(first.gridTimestamp).getTime(),
    status: failed ? 'error' : all.some((node) => node.errors) ? 'retried' : tree.status,
    steps: all.length,
    // What went wrong and where, or what the trigger delivered
    summary: failed
      ? failed === root
        ? failed.error
        : `${failed.label}: ${failed.error}`
      : headline(root.output) || summarize(root.output ?? group.hits[0].msg),
    root: tree
  };
}

/**
 * Masks credentials in log text. Appmixer logs messages verbatim, so an HTTP component's
 * input carries its Authorization header (the OpenClaw hook token, for one). Keys may sit
 * in escaped JSON strings nested in the payload, hence the optional backslashes.
 * @param {string} text
 */
function redact(text) {
  return text
    .replace(/(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(
      /(\\*"[\w-]*(?:authorization|token|secret|password|passwd|api[-_]?key|cookie)[\w-]*\\*"\s*:\s*\\*")[^"\\]+/gi,
      '$1***'
    )
    .replace(/([?&](?:access_token|token|api_?key|key|secret|signature)=)[^&\s"\\]+/gi, '$1***');
}

/** One-line preview of a log message, which is usually a JSON string. */
function summarize(/** @type {unknown} */ msg) {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg ?? '');
  // Redact before cutting, so a credential split by the cut is still masked
  return redact(text.replace(/\s+/g, ' ')).slice(0, 200);
}

/**
 * What a trigger delivered, in a few words: the number and title (or name) of the item, as
 * issues, pull requests and the like have them — on the item itself or on its `subject`.
 * Empty when the payload has neither.
 */
function headline(/** @type {unknown} */ msg) {
  try {
    const item = typeof msg === 'string' ? JSON.parse(msg) : msg;
    const title = [item?.title, item?.subject?.title, item?.name].find(
      (value) => typeof value === 'string' && value
    );
    if (!title) return '';
    return redact(`${typeof item.number === 'number' ? `#${item.number} ` : ''}${title}`).slice(
      0,
      200
    );
  } catch {
    return '';
  }
}

/** Pretty-prints a JSON-string log field; other values are returned as they are. */
function pretty(/** @type {unknown} */ value) {
  if (!value) return '';
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : String(parsed);
  } catch {
    return String(value);
  }
}

/**
 * The messages a component was processing when it failed, by input port, as its error entry
 * carries them.
 * @param {any} hit
 * @returns {Record<string, any[]>}
 */
function inputMessages(hit) {
  try {
    const messages =
      typeof hit.inputMessages === 'string' ? JSON.parse(hit.inputMessages) : hit.inputMessages;
    return Object.fromEntries(
      Object.entries(messages || {}).filter(([, list]) => Array.isArray(list))
    );
  } catch {
    return {};
  }
}

/**
 * An error in one line: its message and, for a failed request, what the remote API answered
 * ("Request failed with status code 403 — Resource not accessible by integration").
 */
function errorLine(/** @type {unknown} */ err) {
  const line = firstLine(err);
  try {
    const data = (typeof err === 'string' ? JSON.parse(err) : err)?.response?.data;
    const reason = [data, data?.message, data?.error, data?.error?.message].find(
      (value) => typeof value === 'string' && value.trim()
    );
    return reason ? `${line} — ${reason.replace(/\s+/g, ' ').trim()}`.slice(0, 400) : line;
  } catch {
    return line;
  }
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
