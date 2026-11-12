/**
 * Operations overview (`/ops`): every moving part of the connector CI in one place.
 *
 * - Appmixer: the integration templates in the `appmixer-sanity-hub` category (the GitHub
 *   responders, PR labels, PR hygiene) with their instances, revision drift and errors.
 * - GitHub Actions: the latest runs of every workflow of the connectors repo.
 * - Watched flows: any flow the viewer added by its id (`ops_watched_flows` user setting), shown
 *   with the same errors, activity and run tree as an integration instance.
 * - OpenClaw: the agent gateway on hetzner-appmixer-agents, through the status JSON the host
 *   publishes (`OPENCLAW_STATUS_URL` + `OPENCLAW_STATUS_TOKEN`).
 *
 * Each source is collected independently: one failing source is reported in its section
 * and never fails the page.
 */

import { env } from '$env/dynamic/private';
import {
  getAppmixerConfig,
  getAppmixerSession,
  findCategoryByName,
  listCategoryTemplates
} from '$lib/api/appmixer.js';
import { getGitHubConfig } from '$lib/api/github.js';
import { getUserSetting, setUserSetting, SETTING_KEYS } from '$lib/db/settings.js';

export const HUB_CATEGORY = 'appmixer-sanity-hub';
const ERROR_WINDOW_DAYS = 7;
/** The shorter windows /ops counts errors in, besides ERROR_WINDOW_DAYS. */
const ERROR_WINDOWS = ['1h', '24h', '3d'];
/** Errors per day, as the log search computed them by default before engine 6.6 */
const DAILY_HISTOGRAM = {
  field: 'gridTimestamp',
  calendar_interval: '1d',
  time_zone: 'UTC',
  min_doc_count: 0
};
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

// The engine serves at most 4 log searches of one user at a time and answers the fifth with
// 429 "max connections reached: 4". /ops keeps to 3, so a run tree opened meanwhile still gets
// through, and waits a little and asks again when another client took the slots.
const LOG_SEARCHES = 3;
const LOG_RETRY_MS = [500, 1500, 3000];
let logSearches = 0;
/** @type {(() => void)[]} */
const logQueue = [];

/**
 * Runs a log search once fewer than LOG_SEARCHES are under way.
 * @template T
 * @param {() => Promise<T>} search
 * @returns {Promise<T>}
 */
async function inLogSlot(search) {
  if (logSearches >= LOG_SEARCHES)
    await new Promise((resolve) => logQueue.push(() => resolve(undefined)));
  logSearches += 1;
  try {
    return await search();
  } finally {
    logSearches -= 1;
    logQueue.shift()?.();
  }
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} path
 * @param {Record<string, string | string[]>} [params]
 * @param {object} [body]
 */
async function appmixerGet(baseUrl, token, path, params = {}, body = undefined) {
  if (path !== '/logs') return appmixerFetch(baseUrl, token, path, params, body);
  return inLogSlot(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await appmixerFetch(baseUrl, token, path, params, body);
      } catch (err) {
        if (!/HTTP 429$/.test(message(err)) || attempt >= LOG_RETRY_MS.length) throw err;
        await new Promise((resolve) => setTimeout(resolve, LOG_RETRY_MS[attempt]));
      }
    }
  });
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} path
 * @param {Record<string, string | string[]>} params
 * @param {object} [body]
 */
async function appmixerFetch(baseUrl, token, path, params, body) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(key, v);
  }
  const response = await fetch(`${baseUrl}${path}?${search}`, {
    // A body makes it a POST: the log search takes its aggregations only that way
    ...(body
      ? {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      : { headers: { Authorization: `Bearer ${token}` } })
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

/**
 * Error count per day for the last ERROR_WINDOW_DAYS, the counts within the shorter windows
 * /ops lets you pick (`byWindow`) and the newest error of one flow, all from one search: the
 * daily histogram and a date range per shorter window are aggregations next to the hit.
 * Engine 6.6 adds no histogram to a GET any more: it is asked for in the body of a POST, and
 * comes back under `aggregations`.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} flowId
 */
async function flowErrors(baseUrl, token, flowId) {
  const data = await appmixerGet(
    baseUrl,
    token,
    '/logs',
    {
      flowId,
      query: `severity:error AND gridTimestamp:>now-${ERROR_WINDOW_DAYS}d`,
      sort: 'gridTimestamp:desc',
      size: '1'
    },
    {
      aggs: {
        by_interval: { date_histogram: DAILY_HISTOGRAM },
        windows: {
          date_range: {
            field: 'gridTimestamp',
            ranges: ERROR_WINDOWS.map((window) => ({ key: window, from: `now-${window}` }))
          }
        }
      }
    }
  );
  /** @param {any} data @returns {any[]} */
  const histogram = (data) => data.buckets || data.aggregations?.by_interval?.buckets || [];
  /** @param {any} data */
  const count = (data) =>
    histogram(data).reduce(
      (/** @type {number} */ sum, /** @type {any} */ b) => sum + (b.doc_count || 0),
      0
    );
  /** @type {any[]} */
  const ranges = data.aggregations?.windows?.buckets || [];
  const buckets = histogram(data).map((/** @type {any} */ b) => ({
    day: String(b.key_as_string || '').slice(0, 10),
    count: b.doc_count || 0
  }));
  const last = (data.hits || [])[0];
  const total = count(data);
  return {
    total,
    byWindow: {
      ...Object.fromEntries(
        ERROR_WINDOWS.map((window) => [
          window,
          ranges.find((/** @type {any} */ r) => r.key === window)?.doc_count || 0
        ])
      ),
      [`${ERROR_WINDOW_DAYS}d`]: total
    },
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
          message: messageId,
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
      // The message the component was handling: its input, the outputs it sent in answer and
      // the errors it ran into all carry the id of the input message
      message: hit.messageId || null,
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
      messages: messageGroups(node.entries),
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
 * A component's entries by the message they belong to, in the order the messages came in: the
 * input, then what the component sent and logged while handling it. A component inside Each
 * gets many messages at once and answers them out of order; this is what tells which output
 * came of which input. Entries with no message id stand on their own.
 * @param {any[]} entries - one component's entries, oldest first
 */
function messageGroups(entries) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.message || `entry:${entry.id}`;
    if (!groups.has(key)) groups.set(key, { id: key, input: null, entries: [] });
    const group = groups.get(key);
    if (entry.direction === 'in' && !group.input) group.input = entry;
    else group.entries.push(entry);
  }
  return [...groups.values()].map((group) => {
    const outputs = group.entries.filter((/** @type {any} */ e) => e.direction === 'out');
    const errors = group.entries.filter((/** @type {any} */ e) => e.severity === 'error');
    const time = (/** @type {any} */ e) => (e ? new Date(e.at).getTime() : 0);
    // An error followed by an output is a failed attempt that a retry made good
    const failed = errors.length > 0 && time(outputs.at(-1)) <= time(errors.at(-1));
    return {
      id: group.id,
      at: (group.input || group.entries[0]).at,
      status: failed ? 'error' : errors.length ? 'retried' : outputs.length ? 'ok' : 'none',
      input: group.input,
      outputs: outputs.length,
      // Failed attempts, the last one too when nothing made it good
      retries: errors.length,
      error: failed ? errors.at(-1).summary : '',
      entries: group.entries
    };
  });
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

/**
 * Pretty-prints a JSON-string log field; other values are returned as they are. Only about
 * DETAIL_LIMIT of it is shown, so printing stops once that much is out (with some to spare,
 * so redacting before the cut still sees a whole credential) and a string holding JSON is
 * parsed only when printing reaches it: a megabyte payload costs no more than a small one.
 * @param {unknown} value
 */
function pretty(value) {
  if (!value) return '';
  const budget = { left: DETAIL_LIMIT + DETAIL_SPARE };
  return typeof value === 'string' ? printString(value, '', budget) : print(value, '', budget);
}

// Printed past DETAIL_LIMIT before the cut
const DETAIL_SPARE = 1000;
// Places in one text tried as the start of a JSON object, so that prose full of brackets
// costs a bounded number of scans
const EMBEDDED_JSON_TRIES = 20;

/**
 * Indented JSON, except that a string spanning several lines (a Markdown comment, a prompt)
 * is printed as a block of its lines, `|` first, with any JSON inside it indented too.
 * @param {unknown} value
 * @param {string} indent
 * @param {{ left: number }} budget - characters still to print; `…` marks where it ran out
 * @returns {string}
 */
function print(value, indent, budget) {
  if (budget.left <= 0) return '…';
  if (typeof value === 'string') return printString(value, indent, budget);
  const inner = `${indent}  `;
  if (value && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((v) => /** @type {[string | null, unknown]} */ ([null, v]))
      : Object.entries(value);
    if (!entries.length) return Array.isArray(value) ? '[]' : '{}';
    const lines = [];
    for (const [key, v] of entries) {
      if (budget.left <= 0) {
        lines.push(`${inner}…`);
        break;
      }
      const name = key === null ? '' : `${JSON.stringify(key)}: `;
      budget.left -= inner.length + name.length;
      lines.push(inner + name + print(v, inner, budget));
    }
    const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
    return `${open}\n${lines.join(',\n')}\n${indent}${close}`;
  }
  const text = JSON.stringify(value) ?? 'null';
  budget.left -= text.length;
  return text;
}

/**
 * A string as JSON when it holds JSON (a request `body`, a webhook payload), otherwise as a
 * quoted string or, over several lines, a block.
 * @param {string} value
 * @param {string} indent
 * @param {{ left: number }} budget
 * @returns {string}
 */
function printString(value, indent, budget) {
  if (/^\s*[[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return print(parsed, indent, budget);
    } catch {
      // Not JSON as a whole; it may still hold some
    }
  }
  const text = expand(value.slice(0, Math.max(0, budget.left)), budget);
  if (!text.includes('\n')) {
    const quoted = JSON.stringify(text) + (value.length > text.length ? '…' : '');
    budget.left -= quoted.length;
    return indent ? quoted : text;
  }
  budget.left -= text.length;
  return indent ? `|\n${text.replace(/^/gm, `${indent}  `)}` : text;
}

/**
 * Text with the JSON objects and arrays written inside it (`<!-- pipeline: {...} -->`)
 * indented in place. Each try scans from one `{` or `[` to the bracket that closes it.
 * @param {string} text
 * @param {{ left: number }} budget
 * @returns {string}
 */
function expand(text, budget) {
  let out = '';
  let from = 0;
  let tries = 0;
  for (let at = text.search(/[[{]/); at >= 0 && tries < EMBEDDED_JSON_TRIES; tries++) {
    const end = closingBracket(text, at);
    if (end > 0) {
      try {
        const value = JSON.parse(text.slice(at, end + 1));
        if (value && typeof value === 'object' && Object.keys(value).length) {
          out += text.slice(from, at) + print(value, '', budget);
          from = end + 1;
        }
      } catch {
        // Brackets in prose, not JSON
      }
    }
    const rest = Math.max(at + 1, from);
    const next = text.slice(rest).search(/[[{]/);
    at = next < 0 ? -1 : rest + next;
  }
  return out + text.slice(from);
}

/**
 * Where the bracket opened at `start` closes, skipping brackets inside JSON strings; -1 when
 * it does not.
 * @param {string} text
 * @param {number} start
 */
function closingBracket(text, start) {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
/**
 * An error message as text. A GraphQL call fails with a list of errors as its message, each
 * with a message of its own.
 * @param {unknown} message
 * @returns {string}
 */
function text(message) {
  if (Array.isArray(message)) return message.map(text).join('; ');
  if (message && typeof message === 'object') {
    const { message: inner } = /** @type {any} */ (message);
    return inner ? text(inner) : JSON.stringify(message);
  }
  return String(message);
}

function firstLine(/** @type {unknown} */ err) {
  if (!err) return '';
  try {
    const parsed = typeof err === 'string' ? JSON.parse(err) : err;
    return text(parsed.message || parsed.stack || '').split('\n')[0];
  } catch {
    return String(err).split('\n')[0];
  }
}

/**
 * The HTTP components of a flow and the URLs they post to — what an integration calls outside
 * Appmixer (an OpenClaw hook, for one). Only the fixed part of a URL is kept: no query string.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} flowId
 * @returns {Promise<Array<{ componentId: string, label: string, url: string }>>}
 */
async function outgoingWebhooks(baseUrl, token, flowId) {
  const definition = await appmixerGet(baseUrl, token, `/flows/${flowId}`, { projection: 'flow' });
  /** @type {Array<{ componentId: string, label: string, url: string }>} */
  const found = [];
  for (const [componentId, component] of Object.entries(definition?.flow || {})) {
    const c = /** @type {any} */ (component);
    if (!/^appmixer\.utils\.http\./.test(c.type || '')) continue;
    for (const source of Object.values(c.config?.transform?.in || {})) {
      for (const port of Object.values(/** @type {any} */ (source) || {})) {
        const url = String(/** @type {any} */ (port)?.lambda?.url || '').split('?')[0];
        if (url) found.push({ componentId, label: c.label || c.type.split('.').pop(), url });
      }
    }
  }
  return found;
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
      const [errors, active, webhooks] = await Promise.all([
        flowErrors(baseUrl, token, instance.flowId).catch((err) => ({ error: message(err) })),
        lastActivity(baseUrl, token, instance.flowId).catch(() => null),
        outgoingWebhooks(baseUrl, token, instance.flowId).catch(() => [])
      ]);
      return { ...instance, errors, lastActivity: active, webhooks };
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
          errors: i.errors,
          webhooks: i.webhooks,
          /** OpenClaw hooks this instance posts to, filled in by linkHooksToCallers */
          hooks: /** @type {string[]} */ ([])
        }))
      };
    })
  };
}

// Watched flows: the viewer's own list of flows to follow on /ops, kept per Appmixer instance
// (a flow id means nothing on another one).
const FLOW_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_WATCHED = 30;

/**
 * @typedef {{ flowId: string, label: string, baseUrl: string, addedAt: string }} WatchedFlow
 */

/**
 * @param {string} userId
 * @returns {Promise<WatchedFlow[]>}
 */
async function readWatched(userId) {
  if (!userId) return [];
  try {
    const list = JSON.parse((await getUserSetting(userId, SETTING_KEYS.OPS_WATCHED_FLOWS)) || '[]');
    return Array.isArray(list) ? list.filter((w) => w && FLOW_ID.test(w.flowId)) : [];
  } catch {
    return [];
  }
}

/**
 * The flows the viewer watches on the configured instance, each with its state, errors and
 * last activity. A flow the account cannot read (someone else's, deleted) stays in the list
 * with `unreachable`, so it can be removed.
 * @param {string} userId - caller's email
 */
export async function collectWatchedFlows(userId) {
  const { baseUrl, token } = await getAppmixerSession(userId);
  const all = await readWatched(userId);
  const here = all.filter((w) => w.baseUrl === baseUrl);
  const flows = await Promise.all(
    here.map(async (watched) => {
      const flow = await appmixerGet(baseUrl, token, `/flows/${watched.flowId}`, {
        projection: 'flowId,name,stage,type,templateId'
      }).catch((err) => ({ error: message(err) }));
      // A flow the account cannot read has no logs it could read either: no searches spent on it
      const [errors, active] = flow?.error
        ? [null, null]
        : await Promise.all([
            flowErrors(baseUrl, token, watched.flowId).catch((err) => ({ error: message(err) })),
            lastActivity(baseUrl, token, watched.flowId).catch(() => null)
          ]);
      return {
        flowId: watched.flowId,
        label: watched.label || '',
        name: flow?.name || '',
        stage: flow?.stage || null,
        type: flow?.type || null,
        unreachable: flow?.error ? unreachable(flow.error) : null,
        errors,
        lastActivity: active
      };
    })
  );
  return { instanceUrl: baseUrl, flows, elsewhere: all.length - here.length };
}

/** @param {string} error - "/flows/<id>: HTTP 404" */
function unreachable(error) {
  const status = /HTTP (\d+)/.exec(error)?.[1];
  if (status === '404') return 'not found on this instance (deleted?)';
  if (status === '401' || status === '403')
    return "not readable with the configured Appmixer account (someone else's flow?)";
  return error;
}

/**
 * Adds a flow to the viewer's watched flows on the configured instance. `input` is the flow
 * id or anything holding it, e.g. the designer URL. The flow must be readable with the
 * configured account, otherwise its logs would not be either.
 * @param {string} userId
 * @param {string} input
 * @param {string} [label]
 * @returns {Promise<WatchedFlow>}
 */
export async function addWatchedFlow(userId, input, label = '') {
  const flowId = FLOW_ID.exec(String(input || ''))?.[0]?.toLowerCase();
  if (!flowId) throw new WatchError(400, 'No flow id (UUID) found in the input');
  const { baseUrl, token } = await getAppmixerSession(userId);
  const flow = await appmixerGet(baseUrl, token, `/flows/${flowId}`, {
    projection: 'flowId,name'
  }).catch((err) => {
    throw new WatchError(400, `Flow ${flowId} is ${unreachable(message(err))}`);
  });
  const all = await readWatched(userId);
  const others = all.filter((w) => !(w.flowId === flowId && w.baseUrl === baseUrl));
  if (others.filter((w) => w.baseUrl === baseUrl).length >= MAX_WATCHED) {
    throw new WatchError(400, `At most ${MAX_WATCHED} watched flows per instance`);
  }
  /** @type {WatchedFlow} */
  const watched = {
    flowId,
    label: String(label || '')
      .trim()
      .slice(0, 100),
    baseUrl,
    addedAt: new Date().toISOString()
  };
  await setUserSetting(
    userId,
    SETTING_KEYS.OPS_WATCHED_FLOWS,
    JSON.stringify([...others, watched])
  );
  return { ...watched, label: watched.label || flow?.name || '' };
}

/**
 * @param {string} userId
 * @param {string} flowId
 */
export async function removeWatchedFlow(userId, flowId) {
  // Only the instance URL, no sign-in: a flow can be removed while the instance is down
  const baseUrl = (await getAppmixerConfig(userId)).baseUrl.replace(/\/+$/, '');
  const all = await readWatched(userId);
  const left = all.filter((w) => !(w.flowId === flowId && w.baseUrl === baseUrl));
  await setUserSetting(userId, SETTING_KEYS.OPS_WATCHED_FLOWS, JSON.stringify(left));
  return { removed: all.length - left.length };
}

/** A refusal of a watched-flow change, with the HTTP status the API answers it with. */
export class WatchError extends Error {
  /** @param {number} status @param {string} msg */
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

/** The release repo, where the marketplace workflows run (same default as the release page). */
const RELEASE_REPO = env.RELEASE_TARGET_REPO || 'Appmixer-ai/appmixer-components';

/**
 * The workflows of every repository the connector CI runs in: the configured one (the
 * responders, Node.js CI) and the release repo (marketplace builds). Each repository is
 * collected on its own, so one that the token cannot read is reported in its own group.
 * @param {string} userId - caller's email, or '' for the env configuration
 */
export async function collectWorkflows(userId) {
  const { owner, repo, token } = await getGitHubConfig(userId);
  const repos = [...new Set([`${owner}/${repo}`, RELEASE_REPO])];
  return {
    repos: await Promise.all(
      repos.map(async (fullName) => {
        const { data, error } = await settle(() => workflowsOfRepo(fullName, token));
        return { repo: fullName, workflows: data?.workflows || [], error };
      })
    )
  };
}

/**
 * @param {string} fullName - owner/repo
 * @param {string} token
 */
async function workflowsOfRepo(fullName, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'appmixer-sanity-check',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
  /** @param {string} path */
  const get = async (path) => {
    const response = await fetch(`https://api.github.com/repos/${fullName}${path}`, { headers });
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
  return { workflows: rows.sort((a, b) => a.name.localeCompare(b.name)) };
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
 * Every agent step of one pipeline run in full: the host's build-status.js writes them to
 * runs/<dir>.json next to the status, served behind the same token.
 * @param {string} dir - the run directory, e.g. 3013-20261104-074925
 * @returns {Promise<{ dir: string, model: string | null, steps: any[] } | null>} null when the
 *   host has no detail file for the run (older runs, or a host without it)
 */
export async function pipelineRunSteps(dir) {
  const url = env.OPENCLAW_STATUS_URL;
  const token = env.OPENCLAW_STATUS_TOKEN;
  if (!url || !token) return null;
  const response = await fetch(url.replace(/[^/]+\.json$/, `runs/${dir}.json`), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OpenClaw run steps: HTTP ${response.status}`);
  return response.json();
}

// The two Appmixer integrations around a pipeline stage: the dispatcher reacts to a card move
// and calls the OpenClaw hook, the stage result integration takes what the host reports back.
const PIPELINE_DISPATCHER = 'CI - project status -> pipeline';
const PIPELINE_RESULT = 'CI - pipeline stage result';

/** @param {any} value */
const parseMsg = (value) => {
  if (typeof value !== 'string') return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

/**
 * The running instance of an integration, by its name.
 * @param {string} baseUrl @param {string} token @param {string} name
 */
async function instanceNamed(baseUrl, token, name) {
  const flows = await appmixerGet(baseUrl, token, '/flows', {
    filter: `name:${name}`,
    projection: 'flowId,name,stage,type'
  });
  const instances = (flows || []).filter(
    (/** @type {any} */ f) => f.type === 'integration-instance' && f.name === name
  );
  return instances.find((/** @type {any} */ f) => f.stage === 'running') || instances[0] || null;
}

/**
 * The runs of a flow that touched a project card within a time window, oldest first: each one
 * is its log entries and what the pipeline cares about in them.
 * @param {string} baseUrl @param {string} token @param {string} flowId
 * @param {string} itemNodeId @param {string} from @param {string} to - ISO times
 */
async function cardRuns(baseUrl, token, flowId, itemNodeId, from, to) {
  const heads = await appmixerGet(baseUrl, token, '/logs', {
    flowId,
    query: `"${itemNodeId}" AND gridTimestamp:["${from}" TO "${to}"]`,
    sort: 'gridTimestamp:asc',
    size: '200'
  });
  const ids = [
    ...new Set((heads.hits || []).map((/** @type {any} */ h) => h.correlationId).filter(Boolean))
  ];
  if (!ids.length) return [];
  const [entries, definition] = await Promise.all([
    appmixerGet(baseUrl, token, '/logs', {
      flowId,
      query: `correlationId:(${ids.map((id) => `"${id}"`).join(' OR ')})`,
      sort: 'gridTimestamp:asc',
      size: '1000'
    }),
    appmixerGet(baseUrl, token, `/flows/${flowId}`, { projection: 'flow' })
  ]);
  /** @type {Record<string, any>} */
  const components = definition?.flow || {};
  return ids.map((id) => {
    const hits = (entries.hits || []).filter((/** @type {any} */ h) => h.correlationId === id);
    /** @type {{ label: string, port: string, text: string, error: boolean, at: string }[]} */
    const steps = [];
    let move = null;
    let stageResult = null;
    for (const h of hits) {
      const type = String(h.componentType || '').split('.').pop();
      const label = components[h.componentId]?.label || type || 'flow';
      const msg = parseMsg(h.msg);
      if (h.severity === 'error') {
        steps.push({ label, port: 'error', text: firstLine(h.err) || String(h.msg || ''), error: true, at: h.gridTimestamp });
        continue;
      }
      if (h.portType !== 'out') continue;
      if (type === 'OnProjectItemChanged') {
        // Only a change of the Status field moves the card (not e.g. "Linked pull requests")
        const change = msg.changes?.field_value || {};
        if (change.field_name === 'Status' && change.to) {
          move = { from: change.from || '', to: change.to, by: msg.sender?.login || '' };
        }
      }
      const result = parseMsg(msg.result);
      if (type === 'CodeBlock' && result.stage && result.result) stageResult = result;
      const inEntry = hits.find(
        (/** @type {any} */ e) => e.componentId === h.componentId && e.portType === 'in'
      );
      const input = parseMsg(inEntry?.msg);
      const status =
        type === 'UpdateProjectItemField' || type === 'CallHook'
          ? null
          : (msg.status ?? msg.statusCode);
      // The OpenClaw connector's Call Hook: Out when the gateway admitted the call, Progress and
      // Done when the host reported back to its callback URL
      const reported = parseMsg(msg.result);
      const text =
        type === 'UpdateProjectItemField'
          ? `set to ${input.value || '?'}`
          : type === 'CallHook'
            ? h.port === 'out'
              ? `POST /hooks/${msg.hook || input.hook || '?'} → admitted`
              : `${h.port}: ${reported.stage || '?'}/${reported.result || '?'}`
            : status != null
              ? `${input.method || (type === 'Post' ? 'POST' : '')} ${input.url || ''} → ${status}`
              : '';
      steps.push({
        label,
        port: h.port || '',
        text,
        error: status != null && Number(status) >= 400,
        at: h.gridTimestamp
      });
    }
    return {
      correlationId: id,
      at: hits[0]?.gridTimestamp || null,
      move,
      stageResult,
      steps,
      failed: steps.some((s) => s.error),
      // The log entries themselves, for the run tree /ops draws as for an integration's runs
      hits,
      components
    };
  });
}

/**
 * Everything that happened around one stage run, in order: the card move on GitHub, the
 * dispatcher's run in Appmixer and its call of the OpenClaw hook, the run on the host, every
 * result the host sent back and what the result integration did with it (comment, card move),
 * and the move that came of it.
 * @param {string} userId - caller's email
 * @param {string} dir - the run directory, e.g. 3001-20261103-083518
 */
export async function pipelineRunTrace(userId, dir) {
  const status = await collectOpenClaw();
  const run = (status.pipelineRuns || []).find((/** @type {any} */ r) => r.dir === dir);
  if (!run) throw new Error(`Run ${dir} is not in the host status`);
  /** @type {{ at: string, source: string, title: string, detail?: string, status: string, steps?: any[], flowId?: string, hits?: any[], components?: Record<string, any>, run?: any }[]} */
  const events = [];
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  const start = Date.parse(run.at);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();

  // The host side, from the status the host builds
  for (const call of run.hookCalls || []) {
    events.push({
      at: call.at,
      source: 'openclaw',
      title: `Gateway took POST /hooks/${call.hook}`,
      detail: `HTTP ${call.status}`,
      status: call.status < 300 ? 'ok' : 'error'
    });
  }
  events.push({ at: run.at, source: 'host', title: `${run.name} run ${run.dir} started`, status: 'ok' });
  if (run.agent?.startedAt) {
    events.push({
      at: run.agent.startedAt,
      source: 'host',
      title: `Agent turn (${run.agent.model})`,
      detail: `${run.agent.steps?.length || 0} steps, ${run.agent.durationSec ?? '?'} s${
        run.agent.costUsd ? `, $${run.agent.costUsd.toFixed(2)}` : ''
      }`,
      status: 'ok'
    });
  }
  for (const line of run.callback || []) {
    // "<time> attempt <n> <Stage>/<result> → <status>"
    const m = String(line).match(/^(\S+) attempt (\d+) (\S+) → (.+)$/);
    if (!m) continue;
    events.push({
      at: m[1],
      source: 'host',
      title: `Result sent to Appmixer: ${m[3]}`,
      detail: `attempt ${m[2]} → ${m[4]}`,
      status: /^2\d\d\b/.test(m[4]) ? 'ok' : 'error'
    });
  }
  if (run.result === 'running') {
    events.push({ at: iso(Date.now()), source: 'host', title: 'Still running', status: 'running' });
  }

  // The Appmixer side, from the log of the two integrations
  if (run.itemNodeId) {
    const { baseUrl, token, uiUrl } = await getAppmixerSession(userId);
    const [dispatcher, result] = await Promise.all([
      instanceNamed(baseUrl, token, PIPELINE_DISPATCHER),
      instanceNamed(baseUrl, token, PIPELINE_RESULT)
    ]);
    const designer = (/** @type {string} */ flowId) => `${uiUrl}/designer/${flowId}`;
    // What a run did with a stage result: the comment it wrote and where the card went
    const resultEvent = (
      /** @type {any} */ r,
      /** @type {string} */ title,
      /** @type {string} */ flowId
    ) => {
      const card = r.steps.find((/** @type {any} */ s) => s.text.startsWith('set to '));
      return {
        at: r.at,
        source: 'appmixer',
        title: `${title}${r.stageResult ? `: ${r.stageResult.stage}/${r.stageResult.result}` : ''}`,
        detail: [
          ...r.steps
            .filter((/** @type {any} */ s) => /^(POST|PATCH) .*\/comments/.test(s.text))
            .map((/** @type {any} */ s) => `comment ${s.text.split(' ')[0]} → ${s.text.split(' → ').pop()}`),
          ...r.steps.filter((/** @type {any} */ s) => /\/hooks\//.test(s.text)).map((/** @type {any} */ s) => s.text),
          card ? `card ${card.text}` : 'card stays',
          ...r.steps
            .filter((/** @type {any} */ s) => s.error && !s.text.startsWith('set to '))
            .map((/** @type {any} */ s) => s.text)
        ].join(' · '),
        status: r.failed ? 'error' : 'ok',
        steps: r.steps,
        hits: r.hits,
        components: r.components,
        flowId: designer(flowId)
      };
    };
    if (dispatcher) {
      const logged = await cardRuns(
        baseUrl,
        token,
        dispatcher.flowId,
        run.itemNodeId,
        iso(start - 15 * 60000),
        iso(end + 15 * 60000)
      );
      // A Call Hook result arrives under the correlation id of the move that started the stage,
      // so one logged run holds the start, every report and its handling. Split it at each report
      // (Call Hook Progress / Done, or the in-flow Pre-release result): the part before is the
      // start, every part after is the handling of one result.
      const isReport = (/** @type {any} */ s) =>
        /^(progress|done): /.test(s.text) || s.label === 'Pre-release result';
      const parts = logged.flatMap((r) => {
        /** @type {any[]} */
        const out = [{ ...r, steps: [], hits: [], report: '' }];
        for (const step of r.steps) {
          if (isReport(step))
            out.push({ ...r, at: step.at, move: null, steps: [], hits: [], report: step.text });
          out[out.length - 1].steps.push(step);
        }
        // The log entries go with the part that was under way when they were written
        for (const hit of r.hits) {
          const part = out.findLast((p, i) => i === 0 || Date.parse(p.at) <= Date.parse(hit.gridTimestamp));
          (part || out[0]).hits.push(hit);
        }
        return out
          .filter((part) => part.steps.length)
          .map((part) => ({ ...part, failed: part.steps.some((/** @type {any} */ x) => x.error) }));
      });
      const starts = parts.filter((part) => !part.report);
      // The move that started this stage: the last one before the run that called its hook
      const hookPath = `/hooks/${run.hookId}`;
      const starter = starts
        .filter((r) => Date.parse(r.at || '') <= start)
        .filter((r) => r.steps.some((/** @type {any} */ s) => s.text.includes(hookPath)))
        .pop();
      // The move the result led to: the first one after the run finished
      const next = run.finishedAt
        ? starts.find((r) => r.move && Date.parse(r.at || '') >= end - 5000)
        : null;
      for (const [r, role] of /** @type {const} */ ([
        [starter, 'started this stage'],
        [next, 'came of the result']
      ])) {
        if (!r) continue;
        if (r.move) {
          events.push({
            at: r.at,
            source: 'github',
            title: `Card moved ${r.move.from || '—'} → ${r.move.to}`,
            detail: `${r.move.by ? `by ${r.move.by} · ` : ''}the move that ${role}`,
            status: 'ok'
          });
        }
        events.push({
          at: r.at,
          source: 'appmixer',
          title: PIPELINE_DISPATCHER,
          // What it did: the comment it wrote and the hook it called
          detail: r.steps
            .filter((/** @type {any} */ s) => /^(POST|PATCH) .*\/comments|\/hooks\//.test(s.text) || s.error)
            .map((/** @type {any} */ s) => s.text.replace(/^(\w+) https?:\/\/[^/]+/, '$1 '))
            .join(' · '),
          status: r.failed ? 'error' : 'ok',
          steps: r.steps,
          hits: r.hits,
          components: r.components,
          flowId: designer(dispatcher.flowId)
        });
      }
      if (!starter) {
        events.push({
          at: run.at,
          source: 'appmixer',
          title: `No ${PIPELINE_DISPATCHER} run found that called ${hookPath}`,
          detail: 'the stage was started by hand, or the log no longer has it',
          status: 'info'
        });
      }
      // Since the pipeline runs on Call Hook (components#3007) the host reports to the
      // dispatcher's Call Hook, and the dispatcher handles each report in the same flow
      for (const part of parts.filter(
        (part) =>
          part.report.includes(`: ${run.name}/`) && Date.parse(part.at || '') >= start - 60000
      )) {
        events.push(
          resultEvent(
            { ...part, stageResult: null },
            `${PIPELINE_DISPATCHER} (${part.report.replace(/^(\w+):/, 'Call Hook $1:')})`,
            dispatcher.flowId
          )
        );
      }
    }
    // Before that, a separate integration took the results; its instance may still exist
    if (result) {
      const runs = await cardRuns(
        baseUrl,
        token,
        result.flowId,
        run.itemNodeId,
        iso(start - 60000),
        iso(end + 15 * 60000)
      );
      // Only the results of this stage: the next stage reports to the same card soon after
      for (const r of runs.filter((r) => !r.stageResult || r.stageResult.stage === run.name)) {
        events.push(resultEvent(r, PIPELINE_RESULT, result.flowId));
      }
    }
  }
  // Each Appmixer run as the tree the integration panels draw: every component with what it
  // received and sent
  const withRun = events.filter((e) => e.hits?.length);
  if (withRun.length) {
    const { baseUrl, token } = await getAppmixerSession(userId);
    const types = [
      ...new Set(
        withRun.flatMap((e) =>
          /** @type {any[]} */ (e.hits).map(
            (h) => h.componentType || e.components?.[h.componentId]?.type
          )
        )
      )
    ].filter(Boolean);
    const ports = Object.fromEntries(
      await Promise.all(types.map(async (type) => [type, await outPortNames(baseUrl, token, type)]))
    );
    for (const e of withRun) {
      e.run = buildRun({ id: `${e.at}`, hits: e.hits || [] }, e.components || {}, ports);
    }
  }
  for (const e of events) {
    delete e.hits;
    delete e.components;
  }
  // callback.log stamps a result when Appmixer answered, after the result integration started
  // on it: sort a sent result before the run it caused
  const sortAt = (/** @type {{ at: string, title: string }} */ e) =>
    Date.parse(e.at) - (e.title.startsWith('Result sent to Appmixer') ? 3000 : 0);
  events.sort((a, b) => sortAt(a) - sortAt(b));
  return { dir, itemNodeId: run.itemNodeId || null, events };
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
  const [appmixer, watched, workflows, openclaw] = await Promise.all([
    settle(() => collectAppmixer(userId)),
    settle(() => collectWatchedFlows(userId)),
    settle(() => collectWorkflows(userId)),
    settle(() => collectOpenClaw())
  ]);
  linkHooksToCallers(openclaw.data, appmixer.data);
  // The board cards the pipeline runs worked on, for the runs grouped by card
  const cards = await settle(() => collectBoardCards(userId, openclaw.data));
  return { generatedAt: new Date().toISOString(), appmixer, watched, workflows, openclaw, cards };
}

/**
 * Where each card the pipeline ran on stands on the project board now, and what it is: its status,
 * and the issue (or pull request) it holds. One GraphQL query for all of them.
 * @param {string} userId - caller's email
 * @param {any} openclaw - the host status
 * @returns {Promise<Record<string, { status: string | null, number: number | null, title: string, url: string, state: string | null, repo: string | null }>>}
 */
async function collectBoardCards(userId, openclaw) {
  const ids = [
    ...new Set(
      (openclaw?.pipelineRuns || [])
        .map((/** @type {any} */ r) => r.itemNodeId)
        .filter((/** @type {any} */ id) => /^PVTI_[\w-]+$/.test(id || ''))
    )
  ].slice(0, 100);
  if (!ids.length) return {};
  const { token } = await getGitHubConfig(userId);
  if (!token) throw new Error('No GitHub token to read the project board');
  const query = `query { nodes(ids: ${JSON.stringify(ids)}) { ... on ProjectV2Item { id
    status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    content { ... on Issue { number title url state repository { name } }
              ... on PullRequest { number title url state repository { name } } } } } }`;
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'appmixer-sanity-check'
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`GitHub board cards: HTTP ${response.status}`);
  const body = await response.json();
  /** @type {Record<string, any>} */
  const cards = {};
  for (const node of body?.data?.nodes || []) {
    if (!node?.id) continue;
    cards[node.id] = {
      status: node.status?.name || null,
      number: node.content?.number ?? null,
      title: node.content?.title || '',
      url: node.content?.url || '',
      state: node.content?.state || null,
      repo: node.content?.repository?.name || null
    };
  }
  return cards;
}

/**
 * Names, on each OpenClaw hook, the integration instances whose HTTP component posts to its URL,
 * and on each instance the hooks it calls. Matched on the path (`/hooks/<name>`), so a host
 * renamed or fronted by another domain still pairs.
 * @param {any} openclaw
 * @param {any} appmixer
 */
function linkHooksToCallers(openclaw, appmixer) {
  if (!openclaw?.hooks?.length || !appmixer?.templates) return;
  const instances = appmixer.templates.flatMap((/** @type {any} */ template) =>
    (template.instances || []).map((/** @type {any} */ instance) => ({ template, instance }))
  );
  for (const hook of openclaw.hooks) {
    const hookPath = new URL(hook.url, 'https://x').pathname;
    /** The path of a webhook URL, as a pattern when a variable ({{{…}}}) fills part of it */
    const pathMatches = (/** @type {string} */ url) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      if (!path.includes('{{{')) return { match: path === hookPath, dynamic: false };
      const pattern = path.split(/\{\{\{[^}]*\}\}\}/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+');
      return { match: new RegExp('^' + pattern + '$').test(hookPath), dynamic: true };
    };
    // A URL with a variable in its path could reach any hook; it counts only for hooks that no
    // fixed URL calls (the pipeline dispatcher picks its stage hook per status, the mention
    // integration posts to its own hook by a fixed URL).
    /** @type {any[]} */
    const exact = [];
    /** @type {any[]} */
    const dynamic = [];
    for (const { template, instance } of instances) {
      for (const webhook of instance.webhooks || []) {
        const m = pathMatches(webhook.url);
        if (m.match) (m.dynamic ? dynamic : exact).push({ template, instance, webhook });
      }
    }
    const callers = exact.length ? exact : dynamic;
    hook.callers = callers.map(({ template, instance, webhook }) => {
      instance.hooks.push(hook.id);
      return {
        flowId: instance.flowId,
        name: template.name,
        stage: instance.stage,
        component: exact.length ? webhook.label : `${webhook.label}, hook chosen per message`
      };
    });
  }
}
