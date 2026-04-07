import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { writeFile, mkdir, readFile, readdir, rm, access } from 'fs/promises';
import { join, resolve } from 'path';
import { inflateRawSync } from 'zlib';

const CACHE_BASE = join(process.env.VERCEL ? '/tmp' : resolve('cache'), 'authhub');

console.log('[auth-hub/bundle] CACHE_BASE:', CACHE_BASE, 'VERCEL:', process.env.VERCEL || 'not set');

/**
 * Extract a ZIP buffer to a directory using pure Node.js (no external unzip).
 * @param {Buffer} buf
 * @param {string} destDir
 */
async function extractZip(buf, destDir) {
    let offset = 0;
    while (offset < buf.length - 4) {
        const sig = buf.readUInt32LE(offset);
        if (sig !== 0x04034b50) break; // not a local file header

        const compressionMethod = buf.readUInt16LE(offset + 8);
        const compressedSize = buf.readUInt32LE(offset + 18);
        const uncompressedSize = buf.readUInt32LE(offset + 22);
        const fileNameLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);
        const fileName = buf.toString('utf-8', offset + 30, offset + 30 + fileNameLen);
        const dataStart = offset + 30 + fileNameLen + extraLen;

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

        offset = dataStart + compressedSize;
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
    console.log('[auth-hub/bundle] POST serviceId:', serviceId, 'cacheDir:', cacheDir);

    try {
        const namespace = serviceId.replaceAll(':', '.');
        const apiUrl = `${baseUrl}/components/${namespace}`;
        console.log('[auth-hub/bundle] Fetching:', apiUrl);
        const res = await fetch(apiUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

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

        return json({ version, serviceId, cacheDir });
    } catch (err) {
        console.error('[auth-hub/bundle] Error:', err.message, err.stack);
        return json({ error: `Failed to get bundle: ${err.message}` }, { status: 500 });
    }
}
