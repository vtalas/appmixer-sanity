import { json, error } from '@sveltejs/kit';
import { fetchFlowById, fetchStoreRecords, getE2EResultStoreIds } from '$lib/api/appmixer.js';

function normalizeResultArray(value) {
    if (Array.isArray(value)) {
        return value;
    }

    if (typeof value !== 'string') {
        return [];
    }

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function findRecordByFlowName(records, flowName) {
    if (!Array.isArray(records) || records.length === 0) {
        return null;
    }

    // Try exact match first
    const exact = records.find(record => record?.key === flowName);
    if (exact) {
        return exact;
    }

    // Try case-insensitive match
    const lowerName = flowName.toLowerCase().trim();
    const caseInsensitive = records.find(record => 
        record?.key?.toLowerCase().trim() === lowerName
    );
    if (caseInsensitive) {
        return caseInsensitive;
    }

    // Try partial match (contains, in either direction)
    const partial = records.find(record => {
        const recordKey = record?.key?.toLowerCase().trim();
        if (!recordKey) return false;
        return recordKey.includes(lowerName) || lowerName.includes(recordKey);
    });
    if (partial) {
        return partial;
    }

    // No match found
    return null;
}

function toResultDetail(item) {
    const success = Array.isArray(item?.success) ? item.success : [];
    const errors = Array.isArray(item?.error) ? item.error : [];

    return {
        componentId: item?.componentId || '',
        componentName: item?.componentName || 'Unknown component',
        success,
        errors,
        status: errors.length > 0 ? 'failed' : 'passed',
        asserts: errors.length
    };
}

function mergeResultDetails(primary, secondary) {
    const ordered = [];
    const byKey = new Map();

    const upsert = (detail) => {
        const key = detail.componentId || detail.componentName;
        if (!key) {
            return;
        }

        if (!byKey.has(key)) {
            ordered.push(key);
            byKey.set(key, detail);
            return;
        }

        const current = byKey.get(key);
        byKey.set(key, {
            ...current,
            ...detail,
            success: detail.success.length > 0 ? detail.success : current.success,
            errors: detail.errors.length > 0 ? detail.errors : current.errors,
            status: detail.errors.length > 0 ? 'failed' : current.status,
            asserts: detail.errors.length > 0 ? detail.errors.length : current.asserts
        });
    };

    primary.map(toResultDetail).forEach(upsert);
    secondary.map(toResultDetail).forEach(upsert);

    return ordered.map(key => byKey.get(key));
}

/**
 * POST /api/e2e-flows/results
 * Returns latest E2E run details for a flow from Appmixer data stores
 */
export async function POST({ request, locals }) {
    const session = await locals.auth();
    if (!session?.user?.email) {
        throw error(401, 'Unauthorized');
    }

    const userId = session.user.email;

    try {
        const { flowId, flowName } = await request.json();

        if (!flowId || !flowName) {
            throw error(400, 'flowId and flowName are required');
        }

        const fullFlow = await fetchFlowById(userId, flowId);
        const { failedStoreId, successStoreId } = getE2EResultStoreIds(fullFlow);

        if (!failedStoreId && !successStoreId) {
            throw error(404, 'No E2E result stores configured for this flow');
        }

        const [failedRecords, successRecords] = await Promise.all([
            failedStoreId ? fetchStoreRecords(userId, failedStoreId) : Promise.resolve([]),
            successStoreId ? fetchStoreRecords(userId, successStoreId) : Promise.resolve([])
        ]);

        const failedRecord = findRecordByFlowName(failedRecords, flowName);
        const successRecord = findRecordByFlowName(successRecords, flowName);

        if (!failedRecord && !successRecord) {
            throw error(404, 'No E2E test results found in configured stores');
        }

        const failedResults = normalizeResultArray(failedRecord?.value);
        const successResults = normalizeResultArray(successRecord?.value);
        const details = mergeResultDetails(failedResults, successResults);

        const failedAsserts = details.filter(detail => detail.status === 'failed').length;

        return json({
            name: flowName,
            status: failedAsserts > 0 ? 'failed' : 'passed',
            failedAsserts,
            totalAsserts: details.length,
            details,
            stores: {
                failedStoreId,
                successStoreId,
                failedRecordKey: failedRecord?.key || null,
                successRecordKey: successRecord?.key || null
            }
        });
    } catch (e) {
        if (e?.status) {
            throw e;
        }

        console.error('Failed to load E2E results:', e);
        throw error(500, e.message || 'Failed to load E2E results');
    }
}
