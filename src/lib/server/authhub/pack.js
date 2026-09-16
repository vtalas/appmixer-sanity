/**
 * Packs a connector straight from GitHub into the ZIP `appmixer pack` would
 * build from a checkout, so it can be uploaded to Auth Hub without a local
 * clone. Everything is read from one commit: the preview pins the commit sha
 * and the upload packs exactly that commit.
 *
 * `appmixer pack` rules (appmixer-cli appmixer-pack.js):
 * - a directory with service.json → every file under it, prefixed
 *   `<vendor>/<service>/` (from the service.json name);
 * - a directory with module.json → the module's files prefixed
 *   `<vendor>/<service>/<module>/`, plus the service-level files of the parent
 *   directory except the module directories (first-level dirs holding a
 *   module.json) — the shared auth.js, commons, icons;
 * - never node_modules/, artifacts/, package-lock.json, test-flow*.json or
 *   hidden files and directories.
 * Only a directory with a bundle.json is packed — that's what makes it a
 * connector (a namespace like src/appmixer/google has a service.json only; its
 * modules are uploaded one by one, each carrying the shared files).
 */

import { getGitHubConfig } from '$lib/api/github.js';
import { getReleaseConfig, githubRequest, mapLimit } from '$lib/server/release/compare.js';
import { createZip } from '$lib/server/zip.js';

const BLOB_FETCH_CONCURRENCY = 8;
const BLOB_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const SERVICE_ID = /^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+){1,2}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

// Blob contents by sha — content-addressed, so entries never go stale. Saves
// downloading the same files again when an upload follows its preview.
/** @type {Map<string, Buffer>} */
const blobCache = new Map();
let blobCacheBytes = 0;

export class PackError extends Error {
  /**
   * @param {string} message
   * @param {number} [status]
   */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * @typedef {{id: string, label: string, fullName: string, branch: string}} PackSource
 * @typedef {{path: string, sha: string, size: number, executable: boolean}} RepoFile
 */

/**
 * Repositories a bundle can be packed from: the development repo (the one
 * /authub compares versions with — Settings or env) and the release branch the
 * PRD marketplace is built from.
 * @param {string} userId
 * @returns {Promise<{token: string, sources: PackSource[]}>}
 */
export async function getPackSources(userId) {
  const github = await getGitHubConfig(userId);
  const { target } = getReleaseConfig();
  return {
    token: github.token,
    sources: [
      {
        id: 'dev',
        label: 'Development',
        fullName: `${github.owner}/${github.repo}`,
        branch: github.branch
      },
      { id: 'release', label: 'Release', fullName: target.fullName, branch: target.branch }
    ]
  };
}

/**
 * Serializable description of a source for the page
 * @param {PackSource} source
 */
export function describeSource(source) {
  return {
    id: source.id,
    label: source.label,
    repo: source.fullName,
    branch: source.branch,
    url: `https://github.com/${source.fullName}/tree/${source.branch}`
  };
}

/**
 * The commit to pack: the given sha (a preview's) or the branch head.
 * @param {string} token
 * @param {PackSource} source
 * @param {string} [commitSha]
 */
async function resolveCommit(token, source, commitSha) {
  const base = `/repos/${source.fullName}`;
  if (commitSha) {
    if (!COMMIT_SHA.test(commitSha)) throw new PackError('Invalid commit sha');
    const commit = await githubRequest(token, 'GET', `${base}/git/commits/${commitSha}`);
    return { sha: commit.sha, committedAt: commit.committer?.date || null };
  }
  const branch = await githubRequest(
    token,
    'GET',
    `${base}/branches/${encodeURIComponent(source.branch)}`
  );
  return { sha: branch.commit.sha, committedAt: branch.commit.commit.committer?.date || null };
}

/**
 * Files under a directory at a commit, relative to it. null when the directory
 * doesn't exist there.
 * @param {string} token
 * @param {PackSource} source
 * @param {string} commitSha
 * @param {string} dir
 * @returns {Promise<RepoFile[]|null>}
 */
async function listDir(token, source, commitSha, dir) {
  let tree;
  try {
    tree = await githubRequest(
      token,
      'GET',
      `/repos/${source.fullName}/git/trees/${commitSha}:${encodeURI(dir)}?recursive=1`
    );
  } catch (e) {
    const status = /** @type {any} */ (e).status;
    // 404: no such path; 422: the path is a file, not a directory
    if (status === 404 || status === 422) return null;
    throw e;
  }
  if (tree.truncated) {
    throw new PackError(`${dir} has too many files to list in one GitHub request`, 422);
  }
  return tree.tree
    .filter((/** @type {any} */ item) => item.type === 'blob' && item.mode !== '120000')
    .map((/** @type {any} */ item) => ({
      path: item.path,
      sha: item.sha,
      size: item.size,
      executable: item.mode === '100755'
    }));
}

/**
 * `appmixer pack` ignore rules, for a path relative to the packed directory
 * @param {string} path
 */
export function isPackable(path) {
  const parts = path.split('/');
  const file = parts[parts.length - 1];
  return !(
    parts.some((part) => part.startsWith('.')) ||
    parts.includes('node_modules') ||
    parts.includes('artifacts') ||
    file === 'package-lock.json' ||
    (file.startsWith('test-flow') && file.endsWith('.json'))
  );
}

/**
 * @param {string} token
 * @param {PackSource} source
 * @param {string} sha
 */
async function readBlob(token, source, sha) {
  const cached = blobCache.get(sha);
  if (cached) return cached;
  const blob = await githubRequest(token, 'GET', `/repos/${source.fullName}/git/blobs/${sha}`);
  const data = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf-8');
  blobCache.set(sha, data);
  blobCacheBytes += data.length;
  for (const [key, value] of blobCache) {
    if (blobCacheBytes <= BLOB_CACHE_MAX_BYTES) break;
    blobCache.delete(key);
    blobCacheBytes -= value.length;
  }
  return data;
}

/**
 * @param {string} token
 * @param {PackSource} source
 * @param {RepoFile|undefined} file
 * @param {string} label - path for error messages
 */
async function readManifest(token, source, file, label) {
  if (!file) return null;
  const text = (await readBlob(token, source, file.sha)).toString('utf-8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new PackError(`${label} is not valid JSON: ${/** @type {Error} */ (e).message}`, 422);
  }
}

/**
 * Work out what `appmixer pack <dir>` would put into the archive.
 * @param {{token: string, source: PackSource, serviceId: string, commitSha?: string}} options
 */
export async function planPack({ token, source, serviceId, commitSha }) {
  if (!SERVICE_ID.test(serviceId || '')) {
    throw new PackError(
      `"${serviceId}" is not a service id like appmixer:box or appmixer:google:drive`
    );
  }
  const commit = await resolveCommit(token, source, commitSha);
  const at = `${source.fullName}@${source.branch}`;
  const dir = `src/${serviceId.split(':').join('/')}`;

  const dirFiles = await listDir(token, source, commit.sha, dir);
  if (!dirFiles) {
    throw new PackError(`${dir} does not exist in ${at}`, 404);
  }
  const top = new Map(dirFiles.filter((f) => !f.path.includes('/')).map((f) => [f.path, f]));

  if (!top.has('bundle.json')) {
    const modules = dirFiles
      .filter((f) => f.path.split('/').length === 2 && f.path.endsWith('/bundle.json'))
      .map((f) => `${serviceId}:${f.path.split('/')[0]}`);
    throw new PackError(
      `${dir} has no bundle.json in ${at}` +
        (modules.length
          ? ` — it is a namespace; upload its modules instead (${modules.join(', ')})`
          : ''),
      422
    );
  }

  const bundle = await readManifest(token, source, top.get('bundle.json'), `${dir}/bundle.json`);
  const service = await readManifest(token, source, top.get('service.json'), `${dir}/service.json`);
  const module = service
    ? null
    : await readManifest(token, source, top.get('module.json'), `${dir}/module.json`);

  /** @type {Array<RepoFile & {name: string}>} */
  let entries;
  /** @type {'service'|'module'} */
  let kind;
  let name;

  if (service) {
    kind = 'service';
    name = service.name;
    const parts = String(name || '').split('.');
    if (parts.length !== 2 || parts.some((p) => !p)) {
      throw new PackError(`${dir}/service.json: "name" must look like vendor.service`, 422);
    }
    entries = dirFiles
      .filter((f) => isPackable(f.path))
      .map((f) => ({ ...f, name: `${parts.join('/')}/${f.path}` }));
  } else if (module) {
    kind = 'module';
    name = module.name;
    const parts = String(name || '').split('.');
    if (parts.length !== 3 || parts.some((p) => !p)) {
      throw new PackError(`${dir}/module.json: "name" must look like vendor.service.module`, 422);
    }
    const serviceDir = dir.slice(0, dir.lastIndexOf('/'));
    const serviceFiles = (await listDir(token, source, commit.sha, serviceDir)) || [];
    const moduleDirs = new Set(
      serviceFiles
        .filter((f) => f.path.split('/').length === 2 && f.path.endsWith('/module.json'))
        .map((f) => f.path.split('/')[0])
    );
    const [vendorName, serviceName, moduleName] = parts;
    entries = [
      ...serviceFiles
        .filter((f) => !moduleDirs.has(f.path.split('/')[0]) && isPackable(f.path))
        .map((f) => ({ ...f, name: `${vendorName}/${serviceName}/${f.path}` })),
      ...dirFiles
        .filter((f) => isPackable(f.path))
        .map((f) => ({ ...f, name: `${vendorName}/${serviceName}/${moduleName}/${f.path}` }))
    ];
  } else {
    throw new PackError(`${dir} has neither service.json nor module.json in ${at}`, 422);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    source,
    commit,
    entries,
    info: {
      serviceId,
      source: describeSource(source),
      commitSha: commit.sha,
      committedAt: commit.committedAt,
      commitUrl: `https://github.com/${source.fullName}/commit/${commit.sha}`,
      path: dir,
      pathUrl: `https://github.com/${source.fullName}/tree/${commit.sha}/${dir}`,
      kind,
      name,
      version: typeof bundle?.version === 'string' ? bundle.version : null,
      files: entries.map((e) => ({ name: e.name, size: e.size })),
      totalSize: entries.reduce((sum, e) => sum + e.size, 0)
    }
  };
}

/**
 * Download the planned files and build the ZIP.
 * @param {string} token
 * @param {Awaited<ReturnType<typeof planPack>>} plan
 */
export async function buildPack(token, plan) {
  const contents = await mapLimit(plan.entries, BLOB_FETCH_CONCURRENCY, (entry) =>
    readBlob(token, plan.source, entry.sha)
  );
  const date = plan.commit.committedAt ? new Date(plan.commit.committedAt) : new Date();
  return createZip(
    plan.entries.map((entry, i) => ({
      name: entry.name,
      data: contents[i],
      executable: entry.executable
    })),
    { date }
  );
}

/**
 * Zip file name `appmixer pack` would use
 * @param {{name: string}} info
 */
export function packFileName(info) {
  return `${info.name}.zip`;
}
