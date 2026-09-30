import { json } from '@sveltejs/kit';
import { authHubFetch, isAuthHubEnv, resolveAuthHubFromUrl } from '$lib/server/authhub/hub.js';
import { writeFile, mkdir, readFile, readdir, rm, access } from 'fs/promises';
import { join, resolve } from 'path';
import { inflateRawSync } from 'zlib';
import { setAuthHubConnectorInfo } from '$lib/db/authhub.js';

const CACHE_BASE = join(process.env.VERCEL ? '/tmp' : resolve('cache'), 'authhub');

// Icons are data URIs; a few manifests embed multi-megabyte PNGs, which the
// report renders as an initial instead
const MAX_STORED_ICON_LENGTH = 200_000;

console.log('[auth-hub/bundle] CACHE_BASE:', CACHE_BASE, 'VERCEL:', process.env.VERCEL || 'not set');

/**
 * Extract a ZIP buffer to a directory using pure Node.js (no external unzip).
 * Reads from the central directory to get accurate sizes (handles data descriptors).
 * @param {Buffer} buf
 * @param {string} destDir
 */
async function extractZip(buf, destDir) {
    // Find End of Central Directory record (search from end)
    let eocdOffset = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');

    const cdOffset = buf.readUInt32LE(eocdOffset + 16);
    const cdEntries = buf.readUInt16LE(eocdOffset + 10);

    let offset = cdOffset;
    for (let i = 0; i < cdEntries; i++) {
        if (buf.readUInt32LE(offset) !== 0x02014b50) break;

        const compressionMethod = buf.readUInt16LE(offset + 10);
        const compressedSize = buf.readUInt32LE(offset + 20);
        const fileNameLen = buf.readUInt16LE(offset + 28);
        const extraLen = buf.readUInt16LE(offset + 30);
        const commentLen = buf.readUInt16LE(offset + 32);
        const localHeaderOffset = buf.readUInt32LE(offset + 42);
        const fileName = buf.toString('utf-8', offset + 46, offset + 46 + fileNameLen);

        // Read local header to find where data actually starts
        const localFileNameLen = buf.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;

        const filePath = join(destDir, fileName);

        if (fileName.endsWith('/')) {
            await mkdir(filePath, { recursive: true });
        } else {
            await mkdir(join(filePath, '..'), { recursive: true });
            const rawData = buf.subarray(dataStart, dataStart + compressedSize);
            let fileData;
            if (compressionMethod === 8) {
                fileData = inflateRawSync(rawData);
            } else {
                fileData = rawData;
            }
            await writeFile(filePath, fileData);
        }

        offset += 46 + fileNameLen + extraLen + commentLen;
    }
}

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
 * Every service.json / module.json under a directory, parsed.
 * @param {string} dir
 * @returns {Promise<Array<{file: string, name?: string, label?: string, icon?: string}>>}
 */
async function readManifests(dir) {
    const manifests = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            manifests.push(...await readManifests(fullPath));
        } else if (entry.name === 'service.json' || entry.name === 'module.json') {
            try {
                const { name, label, icon } = JSON.parse(await readFile(fullPath, 'utf-8'));
                manifests.push({ file: entry.name, name, label, icon });
            } catch { /* skip malformed */ }
        }
    }
    return manifests;
}

/**
 * Version, label and icon of an extracted bundle.
 * @param {string} serviceDir
 * @param {string} serviceId
 * @returns {Promise<{version?: string|null, label?: string, icon?: string}>}
 */
async function readBundleInfo(serviceDir, serviceId) {
    /** @type {{version?: string|null, label?: string, icon?: string}} */
    const info = {};

    const bundlePath = await findFileRecursive(serviceDir, 'bundle.json');
    if (bundlePath) {
        try {
            const bundleJson = JSON.parse(await readFile(bundlePath, 'utf-8'));
            info.version = bundleJson.version || null;
        } catch { /* skip malformed */ }
    }

    // The manifest named like the connector describes it. A module bundle also
    // carries its parent's service.json ("Google" for every Google module), so
    // any service.json is only the fallback.
    const manifests = await readManifests(serviceDir);
    const own = manifests.find((m) => m.name === serviceId.replaceAll(':', '.'));
    const fallback = manifests.find((m) => m.file === 'service.json');
    const label = own?.label || fallback?.label;
    const icon = own?.icon || fallback?.icon;
    if (icon) info.icon = icon;
    if (label) info.label = label;

    return info;
}

/**
 * GET — read cached versions for all connectors in a given environment (`?env=`).
 */
export async function GET({ url }) {
    const environment = url.searchParams.get('env') || 'prod';
    if (!isAuthHubEnv(environment)) {
        return json({ error: `Unknown Auth Hub environment "${environment}"` }, { status: 400 });
    }
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
            const info = await readBundleInfo(serviceDir, serviceId);

            if (Object.keys(info).length > 0) {
                result[serviceId] = info;
            }
        }
    } catch { /* empty */ }

    return json(result);
}

/**
 * POST — download bundle ZIP from the `?env=` Auth Hub, extract, return version.
 */
export async function POST({ request, url }) {
    const { serviceId } = await request.json();

    if (!serviceId) {
        return json({ error: 'serviceId is required' }, { status: 400 });
    }
    // The id becomes a cache directory name
    if (!/^[\w:-]+$/.test(serviceId)) {
        return json({ error: 'Invalid serviceId' }, { status: 400 });
    }

    const { hub, error, status } = resolveAuthHubFromUrl(url);
    if (!hub) {
        return json({ error }, { status });
    }
    const environment = hub.id;

    const cacheDir = join(CACHE_BASE, environment, serviceId.replace(/:/g, '_'));
    console.log('[auth-hub/bundle] POST serviceId:', serviceId, 'cacheDir:', cacheDir);

    try {
        const namespace = serviceId.replaceAll(':', '.');
        console.log('[auth-hub/bundle] Fetching:', `${hub.baseUrl}/components/${namespace}`);
        const res = await authHubFetch(hub, `/components/${namespace}`);

        console.log('[auth-hub/bundle] Auth Hub response:', res.status, res.statusText, 'content-type:', res.headers.get('content-type'));

        if (!res.ok) {
            const text = await res.text();
            console.log('[auth-hub/bundle] Auth Hub error body:', text.substring(0, 500));
            return json({ error: `Auth Hub API error: ${res.status} ${text}` }, { status: res.status });
        }

        console.log('[auth-hub/bundle] Clearing cache dir:', cacheDir);
        await rm(cacheDir, { recursive: true, force: true });
        await mkdir(cacheDir, { recursive: true });

        const buffer = Buffer.from(await res.arrayBuffer());
        console.log('[auth-hub/bundle] ZIP size:', buffer.length, 'bytes');

        console.log('[auth-hub/bundle] Extracting ZIP...');
        await extractZip(buffer, cacheDir);

        const bundlePath = await findFileRecursive(cacheDir, 'bundle.json');
        console.log('[auth-hub/bundle] bundle.json path:', bundlePath);
        if (!bundlePath) {
            return json({ error: 'bundle.json not found in the downloaded bundle' }, { status: 404 });
        }

        const bundleJson = JSON.parse(await readFile(bundlePath, 'utf-8'));
        const version = bundleJson.version || null;
        console.log('[auth-hub/bundle] Success, version:', version);

        // Keep label, icon and version in the DB — the public report can't rely
        // on this instance's file cache
        try {
            const info = await readBundleInfo(cacheDir, serviceId);
            await setAuthHubConnectorInfo(environment, serviceId, {
                ...info,
                icon: info.icon && info.icon.length <= MAX_STORED_ICON_LENGTH ? info.icon : null
            });
        } catch (err) {
            console.error('[auth-hub/bundle] Failed to store bundle info:', err.message);
        }

        return json({ version, serviceId, cacheDir });
    } catch (err) {
        console.error('[auth-hub/bundle] Error:', err.message, err.stack);
        return json({ error: `Failed to get bundle: ${err.message}` }, { status: 500 });
    }
}
