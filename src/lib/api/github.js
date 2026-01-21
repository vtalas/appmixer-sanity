/**
 * GitHub API client for fetching test-flow files from appmixer-connectors repository
 */

import { GITHUB_TOKEN } from '$env/static/private';

const GITHUB_API_BASE = 'https://api.github.com';
const REPO_OWNER = 'clientIO';
const REPO_NAME = 'appmixer-connectors';
const DEFAULT_BRANCH = 'dev';

/**
 * Get headers for GitHub API requests
 * @returns {Object} Headers object with authentication if token is available
 */
function getGitHubHeaders() {
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'appmixer-sanity-check'
    };

    if (GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    }

    return headers;
}

// Cache for GitHub API responses (tree structure)
let cachedTree = null;
let treeCacheExpiry = null;
const TREE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch the repository tree recursively
 * @returns {Promise<Array<{path: string, sha: string, url: string}>>}
 */
async function getRepoTree() {
    if (cachedTree && treeCacheExpiry && Date.now() < treeCacheExpiry) {
        return cachedTree;
    }

    const url = `${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${DEFAULT_BRANCH}?recursive=1`;
    const response = await fetch(url, {
        headers: getGitHubHeaders()
    });

    console.log('==============')
    console.log(GITHUB_TOKEN)
    if (!response.ok) {
        console.log(await response.json());


        throw new Error(`Failed to fetch GitHub tree: ${response.status}`);
    }


    const data = await response.json();
    console.log(data)
    cachedTree = data.tree;
    treeCacheExpiry = Date.now() + TREE_CACHE_TTL;

    return cachedTree;
}

/**
 * Find all test-flow files in the repository
 * @returns {Promise<Array<{path: string, sha: string, connector: string, name: string}>>}
 */
export async function findTestFlowFiles() {
    const tree = await getRepoTree();

    // Filter for test-flow*.json files in src/appmixer directory
    const testFlowFiles = tree.filter(item =>
        item.type === 'blob' &&
        item.path.startsWith('src/appmixer/') &&
        item.path.includes('test-flow') &&
        item.path.endsWith('.json')
    );

    return testFlowFiles.map(file => {
        // Extract connector name from path: src/appmixer/<connector>/...
        const pathParts = file.path.split('/');
        const connector = pathParts[2] || 'unknown';

        return {
            path: file.path,
            sha: file.sha,
            connector,
            url: `https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${DEFAULT_BRANCH}/${file.path}`
        };
    });
}

/**
 * Fetch the content of a file from GitHub
 * @param {string} path - File path in repository
 * @returns {Promise<string>}
 */
export async function fetchFileContent(path) {
    const response = await fetch(
        `${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${DEFAULT_BRANCH}`,
        {
            headers: getGitHubHeaders()
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch file ${path}: ${response.status}`);
    }

    const data = await response.json();


    console.log(data)
    // Content is base64 encoded
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return content;
}

/**
 * Fetch test-flow file and parse its JSON
 * @param {string} path - File path in repository
 * @returns {Promise<{name: string, flow: Object}>}
 */
export async function fetchTestFlowJson(path) {
    const content = await fetchFileContent(path);
    return JSON.parse(content);
}

/**
 * Build a map of flow name -> GitHub file info
 * @returns {Promise<Map<string, {path: string, sha: string, connector: string, url: string, content?: Object}>>}
 */
export async function buildFlowNameToGitHubMap() {
    const testFlowFiles = await findTestFlowFiles();
    const flowMap = new Map();

    // Fetch content for each file to get the flow name
    // We'll batch these to avoid rate limiting
    const BATCH_SIZE = 10;

    for (let i = 0; i < testFlowFiles.length; i += BATCH_SIZE) {
        const batch = testFlowFiles.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(async (file) => {
                try {
                    const content = await fetchTestFlowJson(file.path);
                    return { file, content };
                } catch (e) {
                    console.error(`Failed to fetch ${file.path}:`, e.message);
                    return null;
                }
            })
        );

        for (const result of results) {
            if (result && result.content.name) {
                flowMap.set(result.content.name, {
                    ...result.file,
                    content: result.content
                });
            }
        }
    }

    return flowMap;
}
