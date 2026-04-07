import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { writeFile, mkdir, readFile, readdir, rm, access } from 'fs/promises';
import { join, resolve } from 'path';
import { execSync } from 'child_process';

const CACHE_BASE = resolve('cache/authhub');

/**
 * Find a file by name recursively in a directory.
 */
async function findFileRecursive(dir, fileName) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
            return fullPath;
        }
        if (entry.isDirectory()) {
            const found = await findFileRecursive(fullPath, fileName);
            if (found) return found;
        }
    }
    return null;
}

/**
 * GET — read cached versions for all connectors in a given environment.
 */
export async function GET({ url }) {
    const environment = url.searchParams.get('env') || 'prod';
    const envDir = join(CACHE_BASE, environment);

    try {
        await access(envDir);
    } catch {
        return json({});
    }

    const result = {};
    try {
        const entries = await readdir(envDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const serviceDir = join(envDir, entry.name);
            const serviceId = entry.name.replace(/_/g, ':');
            const info = {};

            const bundlePath = await findFileRecursive(serviceDir, 'bundle.json');
            if (bundlePath) {
                try {
                    const bundleJson = JSON.parse(await readFile(bundlePath, 'utf-8'));
                    info.version = bundleJson.version || null;
                } catch { /* skip malformed */ }
            }

            const servicePath = await findFileRecursive(serviceDir, 'service.json');
            if (servicePath) {
                try {
                    const serviceJson = JSON.parse(await readFile(servicePath, 'utf-8'));
                    if (serviceJson.icon) info.icon = serviceJson.icon;
                    if (serviceJson.label) info.label = serviceJson.label;
                } catch { /* skip */ }
            }

            if (Object.keys(info).length > 0) {
                result[serviceId] = info;
            }
        }
    } catch { /* empty */ }

    return json(result);
}

/**
 * POST — download bundle ZIP, extract, return version.
 */
export async function POST({ request }) {
    const { serviceId } = await request.json();

    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }

    const baseUrl = env.AUTH_HUB_URL_PROD;
    const token = env.AUTH_HUB_API_TOKEN_PROD;
    const environment = 'prod';

    if (!baseUrl || !token) {
        return json({ error: 'AUTH_HUB_URL_PROD and AUTH_HUB_API_TOKEN_PROD must be configured' }, { status: 500 });
    }

    const cacheDir = join(CACHE_BASE, environment, serviceId.replace(/:/g, '_'));

    try {
        const namespace = serviceId.replaceAll(':', '.');
        const res = await fetch(`${baseUrl}/components/${namespace}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!res.ok) {
            const text = await res.text();
            return json({ error: `Auth Hub API error: ${res.status} ${text}` }, { status: res.status });
        }

        await rm(cacheDir, { recursive: true, force: true });
        await mkdir(cacheDir, { recursive: true });

        const zipPath = join(cacheDir, '__bundle.zip');
        const buffer = Buffer.from(await res.arrayBuffer());
        await writeFile(zipPath, buffer);
        execSync(`unzip -o "${zipPath}" -d "${cacheDir}"`);
        await rm(zipPath);

        const bundlePath = await findFileRecursive(cacheDir, 'bundle.json');
        if (!bundlePath) {
            return json({ error: 'bundle.json not found in the downloaded bundle' }, { status: 404 });
        }

        const bundleJson = JSON.parse(await readFile(bundlePath, 'utf-8'));
        const version = bundleJson.version || null;

        return json({ version, serviceId, cacheDir });
    } catch (err) {
        return json({ error: `Failed to get bundle: ${err.message}` }, { status: 500 });
    }
}
