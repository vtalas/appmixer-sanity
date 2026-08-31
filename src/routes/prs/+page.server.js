import { getAppmixerConfig, isAppmixerConfigured } from '$lib/api/appmixer.js';
import { getGitHubRepoInfo } from '$lib/api/github.js';
import { buildPROverview } from '$lib/server/e2e/prs.js';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
  const session = await locals.auth();
  const userId = session?.user?.email;

  const [githubInfo, appmixerConfigured, overview] = await Promise.all([
    getGitHubRepoInfo(userId),
    isAppmixerConfigured(userId),
    buildPROverview(userId)
  ]);

  let designerBaseUrl = null;
  if (appmixerConfigured) {
    const appmixerConfig = await getAppmixerConfig(userId);
    designerBaseUrl = appmixerConfig.baseUrl
      .replace('api-', '')
      // hard-coded exceptions
      .replace('api.clientio.', 'my.clientio.');
  }

  return {
    repo: overview.repo,
    prs: overview.prs,
    lastScanAt: overview.lastScanAt,
    designerBaseUrl,
    githubInfo
  };
}
