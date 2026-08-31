import {
  isAppmixerConfigured,
  getAppmixerInfo,
  getAppmixerConfig,
  getInstanceUrl
} from '$lib/api/appmixer.js';
import { getGitHubRepoInfo, getGitHubConfig } from '$lib/api/github.js';
import { getE2EFlows, getRunnerSnapshot } from '$lib/db/e2e.js';
import { getMaxConcurrent, getRunTimeoutMs } from '$lib/server/e2e/runner.js';
import { SANITY_GITHUB_TOKEN } from '$env/static/private';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;

  const [appmixerInfo, githubInfo, githubConfig, appmixerConfigured] = await Promise.all([
    getAppmixerInfo(userId),
    getGitHubRepoInfo(userId),
    getGitHubConfig(userId),
    isAppmixerConfigured(userId)
  ]);

  githubInfo.hasEnvToken = !!SANITY_GITHUB_TOKEN;
  githubInfo.hasCustomToken = !!githubConfig.token && githubConfig.token !== SANITY_GITHUB_TOKEN;

  let designerBaseUrl = null;
  if (appmixerConfigured) {
    const appmixerConfig = await getAppmixerConfig(userId);
    designerBaseUrl = appmixerConfig.baseUrl
      .replace('api-', '')
      // hard-coded exceptions
      .replace('api.clientio.', 'my.clientio.');
  }

  // Everything below comes from the DB cache — refreshed via POST /api/e2e-flows/scan.
  // Scoped to the user's configured Appmixer instance.
  const instanceUrl = await getInstanceUrl(userId);
  const [flows, runner] = await Promise.all([
    getE2EFlows(instanceUrl),
    getRunnerSnapshot(instanceUrl)
  ]);

  const lastScanAt = flows.reduce((max, f) => {
    return f.updatedAt && (!max || f.updatedAt > max) ? f.updatedAt : max;
  }, null);

  return {
    flows: flows.map((f) => ({
      ...f,
      url: f.flowId && designerBaseUrl ? `${designerBaseUrl}/designer/${f.flowId}` : null
    })),
    runner,
    runnerConfig: {
      maxConcurrent: getMaxConcurrent(),
      runTimeoutSeconds: Math.round(getRunTimeoutMs() / 1000)
    },
    lastScanAt,
    error: appmixerConfigured
      ? null
      : 'Appmixer is not configured. Please set APPMIXER_USERNAME, APPMIXER_PASSWORD, and APPMIXER_BASE_URL environment variables or configure them in settings.',
    designerBaseUrl,
    appmixerInfo,
    githubInfo
  };
}
