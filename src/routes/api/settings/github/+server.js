import { json } from '@sveltejs/kit';
import { getSettings, setSettings, setSetting, SETTING_KEYS } from '$lib/db/settings.js';
import { GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_REPO_BRANCH, GITHUB_TOKEN } from '$env/static/private';

// Default values from environment
const DEFAULTS = {
    [SETTING_KEYS.GITHUB_REPO_OWNER]: GITHUB_REPO_OWNER || 'clientIO',
    [SETTING_KEYS.GITHUB_REPO_NAME]: GITHUB_REPO_NAME || 'appmixer-connectors',
    [SETTING_KEYS.GITHUB_REPO_BRANCH]: GITHUB_REPO_BRANCH || 'dev'
};

/** @type {import('./$types').RequestHandler} */
export async function GET() {
    const settings = await getSettings([
        SETTING_KEYS.GITHUB_REPO_OWNER,
        SETTING_KEYS.GITHUB_REPO_NAME,
        SETTING_KEYS.GITHUB_REPO_BRANCH,
        SETTING_KEYS.GITHUB_TOKEN
    ]);

    // Check if a custom token is set (don't return the actual token value)
    const hasEnvToken = !!GITHUB_TOKEN;
    const hasCustomToken = !!settings[SETTING_KEYS.GITHUB_TOKEN];

    return json({
        owner: settings[SETTING_KEYS.GITHUB_REPO_OWNER] || DEFAULTS[SETTING_KEYS.GITHUB_REPO_OWNER],
        repo: settings[SETTING_KEYS.GITHUB_REPO_NAME] || DEFAULTS[SETTING_KEYS.GITHUB_REPO_NAME],
        branch: settings[SETTING_KEYS.GITHUB_REPO_BRANCH] || DEFAULTS[SETTING_KEYS.GITHUB_REPO_BRANCH],
        hasEnvToken,
        hasCustomToken,
        defaults: {
            owner: DEFAULTS[SETTING_KEYS.GITHUB_REPO_OWNER],
            repo: DEFAULTS[SETTING_KEYS.GITHUB_REPO_NAME],
            branch: DEFAULTS[SETTING_KEYS.GITHUB_REPO_BRANCH]
        }
    });
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
    const { owner, repo, branch, token, clearToken } = await request.json();

    if (!owner || !repo || !branch) {
        return json({ error: 'Owner, repo, and branch are required' }, { status: 400 });
    }

    await setSettings({
        [SETTING_KEYS.GITHUB_REPO_OWNER]: owner.trim(),
        [SETTING_KEYS.GITHUB_REPO_NAME]: repo.trim(),
        [SETTING_KEYS.GITHUB_REPO_BRANCH]: branch.trim()
    });

    // Handle token separately - only update if provided or if clearing
    if (clearToken) {
        // Clear the custom token by setting empty value
        await setSetting(SETTING_KEYS.GITHUB_TOKEN, '');
    } else if (token && token.trim()) {
        await setSetting(SETTING_KEYS.GITHUB_TOKEN, token.trim());
    }

    return json({ success: true });
}
