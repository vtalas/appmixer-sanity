/**
 * Publish a flow JSON as an Appmixer integration: an `integration-draft` (editable in the
 * Designer) plus the `integration-template` published from it — what `/automation-hub`
 * lists and what users activate through the Wizard. See "Migrating a flow to an
 * integration" in CLAUDE.md.
 *
 * Idempotent by flow name. A later run updates the draft and re-publishes onto the same
 * template the way the Designer's Publish does: component IDs remapped through the
 * template's `componentIdMap`, `revision` bumped. Nothing is written when nothing changed.
 * Existing instances stay on their revision until
 * `appmixer integration update-instances <templateId>`.
 *
 * Usage:
 *   node --env-file=.env scripts/publish-integration.js <flow.json> [--category <name>] [--dry-run]
 *
 * Credentials: APPMIXER_BASE_URL, APPMIXER_USERNAME, APPMIXER_PASSWORD — variables set in
 * the shell win over the .env file.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const USAGE =
  'usage: node --env-file=.env scripts/publish-integration.js <flow.json> [--category <name>] [--dry-run]';
const DEFAULT_CATEGORY = 'appmixer-sanity-hub';
// Read access for every user of the instance: that is what puts the template in their hub.
const SHARED_WITH = [{ scope: 'user', permissions: ['read'] }];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string[]} argv
 * @returns {{file: string, category: string, dryRun: boolean}}
 */
function parseArgs(argv) {
  const args = { file: '', category: DEFAULT_CATEGORY, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--category') args.category = argv[(i += 1)] || '';
    else if (!args.file) args.file = arg;
    else throw new Error(`unexpected argument "${arg}"\n${USAGE}`);
  }
  if (!args.file || !args.category) throw new Error(USAGE);
  return args;
}

const baseUrl = (process.env.APPMIXER_BASE_URL || '').replace(/\/+$/, '');
/** @type {string | null} */
let token = null;

async function login() {
  const { APPMIXER_USERNAME: username, APPMIXER_PASSWORD: password } = process.env;
  if (!baseUrl || !username || !password) {
    throw new Error(
      'Set APPMIXER_BASE_URL, APPMIXER_USERNAME and APPMIXER_PASSWORD (shell or .env).'
    );
  }
  const res = await fetch(`${baseUrl}/user/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) throw new Error(`Appmixer auth failed: ${res.status}`);
  token = (await res.json()).token;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<any>}
 */
async function api(method, path, body) {
  if (!token) await login();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/**
 * @param {string[]} filters
 * @param {string} projection
 * @returns {Promise<any[]>}
 */
async function listFlows(filters, projection) {
  const params = new URLSearchParams({ projection, limit: '500' });
  for (const filter of filters) params.append('filter', filter);
  return api('GET', `/flows?${params}`);
}

/**
 * JSON with sorted keys, so server-side key order doesn't read as a change.
 * @param {any} value
 * @returns {string}
 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Every component a wizard field fills must exist in the flow — a field pointing at a
 * missing component is silently dropped, and the Wizard then has nothing to ask.
 * @param {Record<string, any>} flow
 * @param {any} wizard
 * @returns {string[]}
 */
function wizardProblems(flow, wizard) {
  const problems = [];
  for (const field of wizard?.fields || []) {
    const ids =
      field.type === 'account'
        ? field.attrs?.components || []
        : (field.source || '').split('.').filter((/** @type {string} */ part) => UUID.test(part));
    for (const id of ids) {
      if (!flow[id])
        problems.push(
          `wizard field "${field.label}" points at component ${id}, which the flow lacks`
        );
    }
  }
  return problems;
}

/**
 * Re-publishing onto an existing template does what the Designer's Publish does: each
 * draft component keeps the ID the template already has for it (new components get a
 * fresh one), in the flow and in the wizard's paths alike, so the wizard and the
 * instances keep pointing at the same components. Copying the draft's wizard onto the
 * template as is would point every field at the draft's IDs.
 * @param {string} draftId
 * @param {Record<string, any>} draftFlow
 * @param {any} draftWizard
 * @param {any} template
 */
function remapOntoTemplate(draftId, draftFlow, draftWizard, template) {
  const previous = template.componentIdMap || {};
  /** @type {Record<string, string>} */
  const componentIdMap = {};
  let flow = JSON.stringify(draftFlow).replaceAll(draftId, template.flowId);
  let wizard = JSON.stringify(draftWizard || {});
  for (const draftCid of Object.keys(draftFlow)) {
    const templateCid = previous[draftCid] || randomUUID();
    componentIdMap[draftCid] = templateCid;
    flow = flow.replaceAll(draftCid, templateCid);
    wizard = wizard.replaceAll(draftCid, templateCid);
  }
  return { flow: JSON.parse(flow), wizard: JSON.parse(wizard), componentIdMap };
}

/**
 * @param {string} name
 * @param {boolean} dryRun
 * @returns {Promise<string>}
 */
async function findOrCreateCategory(name, dryRun) {
  const found = (await api('GET', '/categories')).find((/** @type {any} */ c) => c.name === name);
  if (found) return found.id;
  if (dryRun) return `<new category "${name}">`;
  await api('POST', '/categories', { name });
  const created = (await api('GET', '/categories')).find((/** @type {any} */ c) => c.name === name);
  if (!created) throw new Error(`category "${name}" was not created`);
  return created.id;
}

/** @param {string} templateId */
async function printTemplate(templateId) {
  const t = await api('GET', `/flows/${templateId}`);
  const fields = (t.wizard?.fields || []).map(
    (/** @type {any} */ f) =>
      `${f.type} "${f.label}" -> ${f.source || (f.attrs?.components || []).join(', ')}`
  );
  console.log(
    JSON.stringify(
      {
        templateId,
        originFlowId: t.originFlowId,
        revision: t.revision,
        categories: t.categories,
        sharedWith: t.sharedWith,
        description: t.description,
        wizard: fields,
        problems: wizardProblems(t.flow || {}, t.wizard)
      },
      null,
      2
    )
  );
  console.log(
    'Next: activate it on /automation-hub (Use -> Start automation). ' +
      `Existing instances move to this revision with: appmixer integration update-instances ${templateId}`
  );
}

async function main() {
  const { file, category, dryRun } = parseArgs(process.argv.slice(2));
  const say = (/** @type {string} */ msg) => console.log(dryRun ? `[dry-run] ${msg}` : msg);

  const src = JSON.parse(readFileSync(file, 'utf8'));
  if (!src.name || !src.flow) throw new Error(`${file}: needs at least "name" and "flow"`);
  const problems = wizardProblems(src.flow, src.wizard);
  if (problems.length) throw new Error(problems.join('\n'));
  if (!src.wizard?.fields?.length)
    say('warning: no wizard fields — users will have nothing to set when activating');
  if (!src.description) say('warning: no description — the hub card will show only the name');

  say(`instance: ${baseUrl}`);
  const categoryId = await findOrCreateCategory(category, dryRun);
  const draftBody = {
    name: src.name,
    description: src.description || '',
    type: 'integration-draft',
    flow: src.flow,
    notes: src.notes || {},
    wizard: src.wizard || {},
    categories: [categoryId]
  };

  // 1. The draft: the editable source every publish starts from.
  const drafts = (await listFlows(['type:integration-draft'], 'flowId,name')).filter(
    (f) => f.name === src.name
  );
  if (drafts.length > 1) {
    throw new Error(
      `${drafts.length} drafts are named "${src.name}" — delete the extra ones first`
    );
  }
  let draftId = drafts[0]?.flowId || null;
  if (draftId) {
    if (!dryRun) await api('PUT', `/flows/${draftId}`, draftBody);
    say(`draft ${dryRun ? 'would be updated' : 'updated'}: ${draftId}`);
  } else if (dryRun) {
    say('draft: would be created');
  } else {
    const created = await api('POST', '/flows', draftBody);
    draftId = created.flowId || created.id;
    say(`draft created: ${draftId}`);
  }

  // 2. The template: what the hub lists.
  const templates = draftId
    ? await listFlows([`originFlowId:${draftId}`, 'type:integration-template'], 'flowId')
    : [];
  if (templates.length > 1) {
    throw new Error(
      `draft ${draftId} has ${templates.length} templates — delete the extra ones first`
    );
  }

  if (!templates.length) {
    if (dryRun) {
      say(`template: would be published from the draft into category ${categoryId}`);
      return;
    }
    // The clone route validates `additional` strictly: type and sharedWith only —
    // categories there is a 400, so they are set on the result.
    const res = await api('POST', `/flows/${draftId}/clone`, {
      projection: '-sharedWith',
      setOriginFlowId: true,
      additional: { type: 'integration-template', sharedWith: SHARED_WITH }
    });
    const templateId = res.cloneId || res.flowId;
    await api('PUT', `/flows/${templateId}`, {
      categories: [categoryId],
      description: draftBody.description
    });
    say(`template published: ${templateId}`);
    await printTemplate(templateId);
    return;
  }

  const template = await api('GET', `/flows/${templates[0].flowId}`);
  const next = remapOntoTemplate(draftId, src.flow, src.wizard, template);
  const componentIds = new Set([...Object.keys(template.flow || {}), ...Object.keys(next.flow)]);
  const changedComponents = [...componentIds].filter(
    (id) => stable(template.flow?.[id]) !== stable(next.flow[id])
  );
  const changes = [
    changedComponents.length && `components ${changedComponents.join(', ')}`,
    stable(template.wizard) !== stable(next.wizard) && 'wizard',
    (template.name || '') !== src.name && 'name',
    (template.description || '') !== draftBody.description && 'description',
    stable(template.notes || {}) !== stable(draftBody.notes) && 'notes',
    stable(template.categories || []) !== stable([categoryId]) && 'categories'
  ].filter(Boolean);

  const currentRevision = template.revision ?? 'unset';
  if (!changes.length) {
    say(`template ${template.flowId} is up to date (revision ${currentRevision})`);
  } else {
    const revision = (template.revision || 1) + 1;
    say(
      `template ${template.flowId}: ${changes.join('; ')} changed — revision ${currentRevision} -> ${revision}`
    );
    if (!dryRun) {
      await api('PUT', `/flows/${template.flowId}`, {
        name: src.name,
        description: draftBody.description,
        flow: next.flow,
        wizard: next.wizard,
        notes: draftBody.notes,
        componentIdMap: next.componentIdMap,
        categories: [categoryId],
        sharedWith: SHARED_WITH,
        revision
      });
    }
  }
  if (!dryRun) await printTemplate(template.flowId);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
