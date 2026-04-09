import { getGitHubRepoInfo, getGitHubConfig } from '$lib/api/github.js';
import { getAppmixerInfo } from '$lib/api/appmixer.js';
import { SANITY_GITHUB_TOKEN } from '$env/static/private';

/** @type {import('./$types').PageServerLoad} */
export async function load({ locals }) {
    const session = await locals.auth();
    const userId = session?.user?.email;

    const [repoInfo, githubConfig, appmixerInfo] = await Promise.all([
        getGitHubRepoInfo(userId),
        getGitHubConfig(userId),
        getAppmixerInfo(userId)
    ]);

    const githubInfo = {
        ...repoInfo,
        hasEnvToken: !!SANITY_GITHUB_TOKEN,
        hasCustomToken: !!githubConfig.token && githubConfig.token !== SANITY_GITHUB_TOKEN
    };

    return {
        githubInfo,
        appmixerInfo
    };
}
