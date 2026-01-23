import { json } from '@sveltejs/kit';
import { getSettings, setSettings, SETTING_KEYS } from '$lib/db/settings.js';
import { APPMIXER_BASE_URL, APPMIXER_USERNAME, APPMIXER_PASSWORD } from '$env/static/private';

/** @type {import('./$types').RequestHandler} */
export async function GET() {
    const settings = await getSettings([
        SETTING_KEYS.APPMIXER_BASE_URL,
        SETTING_KEYS.APPMIXER_USERNAME,
        SETTING_KEYS.APPMIXER_PASSWORD
    ]);

    // Check if custom credentials are set (don't expose actual password)
    const hasEnvCredentials = !!(APPMIXER_BASE_URL && APPMIXER_USERNAME && APPMIXER_PASSWORD);
    const hasCustomCredentials = !!(settings[SETTING_KEYS.APPMIXER_BASE_URL] && settings[SETTING_KEYS.APPMIXER_USERNAME] && settings[SETTING_KEYS.APPMIXER_PASSWORD]);

    return json({
        baseUrl: settings[SETTING_KEYS.APPMIXER_BASE_URL] || APPMIXER_BASE_URL || '',
        username: settings[SETTING_KEYS.APPMIXER_USERNAME] || APPMIXER_USERNAME || '',
        hasEnvCredentials,
        hasCustomCredentials,
        defaults: {
            baseUrl: APPMIXER_BASE_URL || '',
            username: APPMIXER_USERNAME || ''
        }
    });
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ request }) {
    const { baseUrl, username, password, clearCredentials } = await request.json();

    if (clearCredentials) {
        // Clear custom credentials by setting empty values
        await setSettings({
            [SETTING_KEYS.APPMIXER_BASE_URL]: '',
            [SETTING_KEYS.APPMIXER_USERNAME]: '',
            [SETTING_KEYS.APPMIXER_PASSWORD]: ''
        });
        return json({ success: true });
    }

    if (!baseUrl || !username) {
        return json({ error: 'Base URL and username are required' }, { status: 400 });
    }

    const settingsToSave = {
        [SETTING_KEYS.APPMIXER_BASE_URL]: baseUrl.trim(),
        [SETTING_KEYS.APPMIXER_USERNAME]: username.trim()
    };

    // Only update password if provided
    if (password && password.trim()) {
        settingsToSave[SETTING_KEYS.APPMIXER_PASSWORD] = password.trim();
    }

    await setSettings(settingsToSave);

    return json({ success: true });
}
