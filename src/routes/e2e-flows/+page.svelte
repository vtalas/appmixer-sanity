<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { ExternalLink, Github, Trash2, FileDiff, FileText, Play, Square, RefreshCw, ListX, PlayCircle, Clipboard, Check } from 'lucide-svelte';

  let { data } = $props();

  // Initialize filters from URL params
  const params = $page.url.searchParams;
  let searchQuery = $state(params.get('q') || '');
  let connectorFilter = $state(params.get('connector') || '');
  let syncFilter = $state(params.get('sync') || '');
  let resultFilter = $state(params.get('result') || '');

  // Sync filter state to URL
  let initialized = false;
  $effect(() => {
    const q = searchQuery;
    const connector = connectorFilter;
    const sync = syncFilter;
    const result = resultFilter;

    if (!initialized) {
      initialized = true;
      return;
    }

    const url = new URL($page.url);
    const sp = url.searchParams;
    q ? sp.set('q', q) : sp.delete('q');
    connector ? sp.set('connector', connector) : sp.delete('connector');
    sync ? sp.set('sync', sync) : sp.delete('sync');
    result ? sp.set('result', result) : sp.delete('result');

    goto(url.pathname + (sp.toString() ? '?' + sp.toString() : ''), {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  });

  const flows = $derived(data.flows || []);

  // Runner state derived from the snapshot
  const runner = $derived(data.runner || { counts: {}, running: [], queued: [], recent: [] });
  const runningNames = $derived(new Set(runner.running.map((r) => r.flowName)));
  const queuedNames = $derived(new Set(runner.queued.map((r) => r.flowName)));
  const runnerActive = $derived(runner.running.length + runner.queued.length > 0);

  // Stats
  const stats = $derived({
    total: flows.length,
    deployed: flows.filter((f) => f.flowId).length,
    notDeployed: flows.filter((f) => f.syncStatus === 'not_deployed').length,
    match: flows.filter((f) => f.syncStatus === 'match').length,
    modified: flows.filter((f) => f.syncStatus === 'modified').length,
    serverOnly: flows.filter((f) => f.syncStatus === 'server_only').length,
    passed: flows.filter((f) => f.lastResult === 'passed').length,
    failed: flows.filter((f) => f.lastResult === 'failed').length,
    neverRan: flows.filter((f) => !f.lastResult).length
  });

  // Filtering
  const connectors = $derived(
    [...new Set(flows.map((f) => f.connector).filter(Boolean))].sort()
  );

  const filteredFlows = $derived(
    flows.filter((flow) => {
      const matchesSearch =
        !searchQuery ||
        flow.flowName?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        flow.connector?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesConnector = !connectorFilter || flow.connector === connectorFilter;
      const matchesSync = !syncFilter || flow.syncStatus === syncFilter;

      const matchesResult =
        !resultFilter ||
        (resultFilter === 'passed' && flow.lastResult === 'passed') ||
        (resultFilter === 'failed' && flow.lastResult === 'failed') ||
        (resultFilter === 'none' && !flow.lastResult) ||
        (resultFilter === 'active' && (runningNames.has(flow.flowName) || queuedNames.has(flow.flowName)));

      return matchesSearch && matchesConnector && matchesSync && matchesResult;
    })
  );

  // Group filtered flows by connector
  const groupedFlows = $derived.by(() => {
    const groups = new Map();
    for (const flow of filteredFlows) {
      const key = flow.connector || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(flow);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([connector, items]) => ({
        connector,
        flows: items.sort((a, b) => a.flowName.localeCompare(b.flowName)),
        deployed: items.filter((f) => f.flowId).length,
        passed: items.filter((f) => f.lastResult === 'passed').length,
        failed: items.filter((f) => f.lastResult === 'failed').length,
        // Account availability is per connector — every flow row carries the same value
        accountAvailable: items.find((f) => f.accountAvailable != null)?.accountAvailable ?? null
      }));
  });

  // --- Runner pump: while the page is open and the queue is active, tick every 15s ---
  let ticking = $state(false);

  async function tickRunner() {
    if (ticking) return;
    ticking = true;
    try {
      const response = await fetch('/api/e2e-flows/runner/tick', { method: 'POST' });
      if (response.ok) {
        await invalidateAll();
      }
    } catch (e) {
      console.error('Runner tick failed:', e);
    } finally {
      ticking = false;
    }
  }

  $effect(() => {
    if (!runnerActive) return;
    const interval = setInterval(tickRunner, 15_000);
    return () => clearInterval(interval);
  });

  // --- Scan (refresh from GitHub + instance, NDJSON progress stream) ---
  let isScanning = $state(false);
  let scanError = $state('');
  let scanSummary = $state(null);
  /** @type {{phase: string, done?: number, total?: number}|null} */
  let scanProgress = $state(null);

  const scanPhaseLabels = {
    sources: 'Listing GitHub repo & instance flows…',
    github: 'Fetching test-flow files from GitHub',
    compare: 'Comparing flows with the instance',
    results: 'Reading run results…',
    save: 'Saving…'
  };

  const scanProgressPercent = $derived.by(() => {
    const p = scanProgress;
    if (!p) return 0;
    // Weight phases: sources 5%, github 5-60%, compare 60-90%, results 90-95%, save 95-100%
    const frac = p.total ? (p.done || 0) / p.total : 0;
    switch (p.phase) {
      case 'sources': return 3;
      case 'github': return 5 + frac * 55;
      case 'compare': return 60 + frac * 30;
      case 'results': return 92;
      case 'save': return 97;
      default: return 0;
    }
  });

  async function runScan() {
    isScanning = true;
    scanError = '';
    scanSummary = null;
    scanProgress = { phase: 'sources' };

    try {
      const response = await fetch('/api/e2e-flows/scan', { method: 'POST' });
      if (!response.ok || !response.body) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Scan failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;

          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === 'progress') {
            scanProgress = event;
          } else if (event.type === 'done') {
            scanSummary = event.summary;
            finished = true;
          } else if (event.type === 'error') {
            throw new Error(event.message);
          }
        }
      }

      if (!finished) {
        throw new Error('Scan stream ended unexpectedly');
      }

      await invalidateAll();
    } catch (e) {
      scanError = e.message || 'Scan failed';
    } finally {
      isScanning = false;
      scanProgress = null;
    }
  }

  // --- Enqueue runs ---
  let enqueueError = $state('');
  let enqueueBusy = $state(false);

  async function enqueue(body) {
    enqueueBusy = true;
    enqueueError = '';
    try {
      const response = await fetch('/api/e2e-flows/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to enqueue: ${response.status}`);
      }
      await invalidateAll();
    } catch (e) {
      enqueueError = e.message || 'Failed to enqueue runs';
    } finally {
      enqueueBusy = false;
    }
  }

  function runFlow(flow) {
    enqueue({ flowNames: [flow.flowName] });
  }

  function runConnector(connector) {
    enqueue({ connector });
  }

  function runAll() {
    if (!confirm(`Queue all ${stats.deployed} deployed flows? They will run max ${data.runnerConfig.maxConcurrent} at a time.`)) {
      return;
    }
    enqueue({ all: true });
  }

  async function cancelQueue() {
    try {
      const response = await fetch('/api/e2e-flows/run', { method: 'DELETE' });
      if (response.ok) {
        await invalidateAll();
      }
    } catch (e) {
      console.error('Failed to cancel queue:', e);
    }
  }

  // --- Selection for batch actions (sync to GitHub / upload to instance) ---
  let selectedFlowNames = $state(new Set());

  function isSelectable(flow) {
    return (
      (flow.flowId && (flow.syncStatus === 'modified' || flow.syncStatus === 'server_only')) ||
      (flow.githubPath && flow.syncStatus === 'not_deployed')
    );
  }

  const selectedFlows = $derived(flows.filter((f) => selectedFlowNames.has(f.flowName)));

  // Sync to GitHub: instance is the source (modified / server_only, needs flowId)
  const syncableFlows = $derived(
    selectedFlows.filter(
      (f) => f.flowId && (f.syncStatus === 'modified' || f.syncStatus === 'server_only')
    )
  );

  // Upload to instance: GitHub is the source (modified = overwrite, not_deployed = create)
  const uploadableFlows = $derived(
    selectedFlows.filter(
      (f) => f.githubPath && (f.syncStatus === 'modified' || f.syncStatus === 'not_deployed')
    )
  );

  function toggleFlowSelection(flowName) {
    const newSet = new Set(selectedFlowNames);
    if (newSet.has(flowName)) {
      newSet.delete(flowName);
    } else {
      newSet.add(flowName);
    }
    selectedFlowNames = newSet;
  }

  function clearSelection() {
    selectedFlowNames = new Set();
  }

  function toggleGroupSelection(groupFlows, allSelected) {
    const newSet = new Set(selectedFlowNames);
    for (const f of groupFlows) {
      if (allSelected) {
        newSet.delete(f.flowName);
      } else {
        newSet.add(f.flowName);
      }
    }
    selectedFlowNames = newSet;
  }

  // --- Sync to GitHub PR dialog ---
  let showSyncDialog = $state(false);
  let syncPrTitle = $state('');
  let syncPrDescription = $state('');
  let syncTargetBranch = $state('');
  let isSyncing = $state(false);
  let syncError = $state('');
  let syncResult = $state(null);

  function generateFlowPath(connector, flowName) {
    const safeName = flowName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return `src/appmixer/${connector || 'unknown'}/test-flow-${safeName}.json`;
  }

  function openSyncDialog() {
    const count = syncableFlows.length;
    syncPrTitle = `Sync ${count} E2E flow${count > 1 ? 's' : ''} from Appmixer`;
    syncPrDescription = '';
    syncTargetBranch = data.githubInfo?.branch || 'dev';
    syncError = '';
    syncResult = null;
    showSyncDialog = true;
  }

  async function performSync() {
    if (!syncPrTitle.trim()) {
      syncError = 'PR title is required';
      return;
    }

    isSyncing = true;
    syncError = '';

    try {
      const flowsToSync = syncableFlows.map((f) => ({
        flowId: f.flowId,
        name: f.flowName,
        connector: f.connector,
        githubPath: f.githubPath || null
      }));

      const response = await fetch('/api/e2e-flows/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flows: flowsToSync,
          prTitle: syncPrTitle.trim(),
          prDescription: syncPrDescription.trim(),
          targetBranch: syncTargetBranch.trim()
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to sync: ${response.status}`);
      }

      syncResult = await response.json();
      clearSelection();
    } catch (e) {
      syncError = e.message || 'Failed to sync flows';
    } finally {
      isSyncing = false;
    }
  }

  async function closeSyncDialog() {
    const hadSuccess = syncResult?.success;
    showSyncDialog = false;
    syncResult = null;
    if (hadSuccess) {
      await invalidateAll();
    }
  }

  // --- Upload to instance dialog (GitHub → instance, per-flow progress) ---
  let showUploadDialog = $state(false);
  let isUploading = $state(false);
  let uploadFinished = $state(false);
  /** @type {Array<{flowName: string, state: string, detail: string}>} */
  let uploadRows = $state([]);

  function openUploadDialog() {
    uploadRows = uploadableFlows.map((f) => ({
      flowName: f.flowName,
      state: 'pending',
      detail: f.syncStatus === 'not_deployed' ? 'will be created' : 'will be overwritten'
    }));
    uploadFinished = false;
    showUploadDialog = true;
  }

  async function performUpload() {
    isUploading = true;

    for (let i = 0; i < uploadRows.length; i++) {
      uploadRows[i] = { ...uploadRows[i], state: 'uploading', detail: '' };
      uploadRows = [...uploadRows];

      try {
        const response = await fetch('/api/e2e-flows/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flowNames: [uploadRows[i].flowName] })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `Upload failed: ${response.status}`);
        }

        const { results } = await response.json();
        const result = results?.[0] || {};

        if (result.error) {
          uploadRows[i] = { ...uploadRows[i], state: 'error', detail: result.error };
        } else {
          const parts = [result.created ? 'created' : 'updated'];
          if (result.accounts?.length) parts.push(`account bound`);
          if (result.warning) parts.push(result.warning);
          uploadRows[i] = {
            ...uploadRows[i],
            state: result.warning ? 'warning' : 'done',
            detail: parts.join(' · ')
          };
        }
      } catch (e) {
        uploadRows[i] = { ...uploadRows[i], state: 'error', detail: e.message || 'Upload failed' };
      }
      uploadRows = [...uploadRows];
    }

    isUploading = false;
    uploadFinished = true;
    await invalidateAll();
  }

  function closeUploadDialog() {
    if (isUploading) return;
    showUploadDialog = false;
    if (uploadFinished) {
      clearSelection();
    }
    uploadRows = [];
    uploadFinished = false;
  }

  // --- Toggle (start/stop) ---
  let togglingFlowNames = $state(new Set());

  async function toggleFlow(flow) {
    const action = flow.stage === 'running' ? 'stop' : 'start';
    const newSet = new Set(togglingFlowNames);
    newSet.add(flow.flowName);
    togglingFlowNames = newSet;

    try {
      const response = await fetch('/api/e2e-flows/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowId: flow.flowId, action })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to ${action} flow`);
      }

      await invalidateAll();
    } catch (e) {
      console.error(`Failed to ${action} flow:`, e);
      alert(`Failed to ${action} flow: ${e.message}`);
    } finally {
      const cleanup = new Set(togglingFlowNames);
      cleanup.delete(flow.flowName);
      togglingFlowNames = cleanup;
    }
  }

  // --- Delete dialog ---
  let showDeleteDialog = $state(false);
  let flowToDelete = $state(null);
  let isDeleting = $state(false);
  let deleteError = $state('');

  function confirmDelete(flow) {
    flowToDelete = flow;
    deleteError = '';
    showDeleteDialog = true;
  }

  async function performDelete() {
    if (!flowToDelete) return;

    isDeleting = true;
    deleteError = '';

    try {
      const response = await fetch('/api/e2e-flows/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowIds: [flowToDelete.flowId] })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to delete: ${response.status}`);
      }

      const result = await response.json();
      if (result.errors?.length > 0) {
        throw new Error(result.errors[0].error);
      }

      showDeleteDialog = false;
      flowToDelete = null;
      await invalidateAll();
    } catch (e) {
      deleteError = e.message || 'Failed to delete flow';
    } finally {
      isDeleting = false;
    }
  }

  // --- Diff dialog ---
  let showDiffDialog = $state(false);
  let diffFlow = $state(null);
  let isDiffLoading = $state(false);
  let diffError = $state('');
  let diffData = $state(null);
  let isReverting = $state(false);
  let revertError = $state('');
  let revertSuccess = $state(false);

  async function openDiff(flow) {
    diffFlow = flow;
    diffError = '';
    diffData = null;
    showDiffDialog = true;
    isDiffLoading = true;

    try {
      const response = await fetch('/api/e2e-flows/diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowId: flow.flowId, flowName: flow.flowName })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to load diff: ${response.status}`);
      }

      diffData = await response.json();
    } catch (e) {
      diffError = e.message || 'Failed to load diff';
    } finally {
      isDiffLoading = false;
    }
  }

  async function revertFlow() {
    if (!diffFlow) return;

    isReverting = true;
    revertError = '';

    try {
      const response = await fetch('/api/e2e-flows/revert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowId: diffFlow.flowId, flowName: diffFlow.flowName })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to revert: ${response.status}`);
      }

      revertSuccess = true;
    } catch (e) {
      revertError = e.message || 'Failed to revert flow';
    } finally {
      isReverting = false;
    }
  }

  async function closeDiffDialog() {
    const hadRevert = revertSuccess;
    showDiffDialog = false;
    revertSuccess = false;
    revertError = '';

    if (hadRevert) {
      await invalidateAll();
    }
  }

  // --- Results dialog (renders the cached last result) ---
  let showResultsDialog = $state(false);
  let resultsFlow = $state(null);

  function openResults(flow) {
    resultsFlow = flow;
    showResultsDialog = true;
  }

  const resultsDetails = $derived.by(() => {
    const detail = resultsFlow?.lastResultDetail;
    if (!Array.isArray(detail)) return [];
    return detail.map((item) => {
      const errors = Array.isArray(item?.error) ? item.error : [];
      const success = Array.isArray(item?.success) ? item.success : [];
      return {
        componentId: item?.componentId || '',
        componentName: item?.componentName || 'Unknown component',
        success,
        errors,
        status: errors.length > 0 ? 'failed' : 'passed'
      };
    });
  });

  function getComponentLink(componentId) {
    if (!resultsFlow?.url || !componentId) {
      return resultsFlow?.url || '#';
    }
    return `${resultsFlow.url}?componentId=${encodeURIComponent(componentId)}`;
  }

  // --- Markdown report export (same format as appmixer-component-preview) ---
  let exportCopied = $state(false);

  function formatResultTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
  }

  async function copyMarkdownReport() {
    const lines = [];

    for (const group of groupedFlows) {
      lines.push(`## ${group.connector}`);
      for (const flow of group.flows) {
        let line = flow.url ? `- [${flow.flowName}](${flow.url})` : `- ${flow.flowName}`;
        const fileName = flow.githubPath ? flow.githubPath.split('/').pop() : null;
        if (fileName) line += ` — \`${fileName}\``;

        if (flow.lastResult) {
          const label = flow.lastResult === 'failed' ? 'Failure' : 'Success';
          const time = flow.lastResultAt ? ` (${formatResultTimestamp(flow.lastResultAt)})` : '';
          line += ` — **${label}**${time}`;
        } else {
          line += ' — Not Available';
        }
        lines.push(line);

        if (Array.isArray(flow.lastResultDetail)) {
          for (const detail of flow.lastResultDetail) {
            for (const check of Array.isArray(detail?.success) ? detail.success : []) {
              lines.push(`  - ✅ ${check}`);
            }
            for (const check of Array.isArray(detail?.error) ? detail.error : []) {
              lines.push(`  - ❌ ${check}`);
            }
          }
        }
      }
      lines.push('');
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n').trim() + '\n');
      exportCopied = true;
      setTimeout(() => (exportCopied = false), 2000);
    } catch (e) {
      console.error('Failed to copy report:', e);
    }
  }

  // --- Diff computation (line-based LCS) ---
  function computeDiff(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const result = [];
    const lcs = buildLCS(oldLines, newLines);
    let li = 0, oi = 0, ni = 0;

    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length && oi < oldLines.length && ni < newLines.length && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
        result.push({ type: 'context', line: oldLines[oi] });
        oi++; ni++; li++;
      } else if (li < lcs.length && ni < newLines.length && newLines[ni] === lcs[li]) {
        result.push({ type: 'removed', line: oldLines[oi] });
        oi++;
      } else if (li < lcs.length && oi < oldLines.length && oldLines[oi] === lcs[li]) {
        result.push({ type: 'added', line: newLines[ni] });
        ni++;
      } else if (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        result.push({ type: 'removed', line: oldLines[oi] });
        oi++;
      } else if (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        result.push({ type: 'added', line: newLines[ni] });
        ni++;
      }
    }

    return result;
  }

  function buildLCS(a, b) {
    const m = a.length, n = b.length;
    if (m * n > 2_000_000) {
      return [];
    }
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const result = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift(a[i - 1]);
        i--; j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    return result;
  }

  // --- Helpers ---
  const syncStatusConfig = {
    match: { label: 'In Sync', class: 'bg-green-100 text-green-800 border-green-200' },
    modified: { label: 'Modified', class: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
    not_deployed: { label: 'Not Deployed', class: 'bg-orange-100 text-orange-800 border-orange-200' },
    server_only: { label: 'Server Only', class: 'bg-blue-100 text-blue-800 border-blue-200' },
    error: { label: 'Error', class: 'bg-red-100 text-red-800 border-red-200' }
  };

  function formatRelativeTime(value) {
    if (!value) return '';
    const date = new Date(String(value).includes('T') || String(value).includes('Z') ? value : `${String(value).replace(' ', 'T')}Z`);
    if (isNaN(date.getTime())) return '';
    const diff = Date.now() - date.getTime();
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      if (showDiffDialog) showDiffDialog = false;
      else if (showResultsDialog) showResultsDialog = false;
      else if (showDeleteDialog) showDeleteDialog = false;
      else if (showUploadDialog) closeUploadDialog();
      else if (showSyncDialog) showSyncDialog = false;
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
  <title>E2E Test Flows - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-3xl font-bold">E2E Test Flows</h1>
      <p class="text-muted-foreground">
        Test flows from GitHub ({data.githubInfo?.branch || 'dev'} branch), grouped by connector, with instance deployment state and run results
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Button
        variant="outline"
        onclick={copyMarkdownReport}
        disabled={flows.length === 0}
        title="Copy a markdown report of the listed flows with per-check results"
      >
        {#if exportCopied}
          <Check size={15} class="mr-2 text-green-600" />
          Copied
        {:else}
          <Clipboard size={15} class="mr-2" />
          Copy Report
        {/if}
      </Button>
      <Button variant="outline" onclick={runScan} disabled={isScanning}>
        <RefreshCw size={15} class="mr-2 {isScanning ? 'animate-spin' : ''}" />
        {isScanning ? 'Scanning...' : 'Scan'}
      </Button>
      <Button onclick={runAll} disabled={enqueueBusy || stats.deployed === 0}>
        <PlayCircle size={15} class="mr-2" />
        Run All
      </Button>
    </div>
  </div>

  <!-- Source Info -->
  <div class="flex flex-wrap gap-4 text-sm">
    <div class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md">
      <span class="text-muted-foreground">Appmixer:</span>
      {#if data.appmixerInfo?.baseUrl}
        <span class="text-blue-600">{data.appmixerInfo.baseUrl}</span>
        {#if data.appmixerInfo.username}
          <span class="text-muted-foreground">({data.appmixerInfo.username})</span>
        {/if}
      {:else}
        <span class="text-muted-foreground">Not configured</span>
      {/if}
    </div>
    {#if data.githubInfo}
      <div class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md">
        <span class="text-muted-foreground">GitHub:</span>
        <span class="text-blue-600">{data.githubInfo.owner}/{data.githubInfo.repo}</span>
        <Badge variant="outline">{data.githubInfo.branch}</Badge>
      </div>
    {/if}
    {#if data.lastScanAt}
      <div class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md">
        <span class="text-muted-foreground">Last scan:</span>
        <span>{formatRelativeTime(data.lastScanAt)}</span>
      </div>
    {/if}
    <a href="/settings" class="flex items-center gap-1 px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
      Settings
    </a>
  </div>

  {#if isScanning && scanProgress}
    <div class="border border-blue-200 bg-blue-50/60 rounded-lg p-4 space-y-2">
      <div class="flex items-center justify-between text-sm">
        <span class="font-medium text-blue-900">
          {scanPhaseLabels[scanProgress.phase] || 'Scanning…'}
          {#if scanProgress.total}
            <span class="text-blue-700 font-normal ml-1">({scanProgress.done || 0}/{scanProgress.total})</span>
          {/if}
        </span>
        <span class="text-blue-700 tabular-nums">{Math.round(scanProgressPercent)}%</span>
      </div>
      <div class="h-2 rounded-full bg-blue-100 overflow-hidden">
        <div
          class="h-full bg-blue-500 rounded-full transition-all duration-300"
          style="width: {scanProgressPercent}%"
        ></div>
      </div>
    </div>
  {/if}

  {#if scanError}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700 text-sm">Scan failed: {scanError}</p>
    </div>
  {/if}
  {#if scanSummary && !scanSummary.errors?.length}
    <div class="bg-green-50 border border-green-200 rounded-lg px-4 py-2.5 flex items-center justify-between">
      <p class="text-sm text-green-800">
        Scan complete: {scanSummary.total} flows ({scanSummary.deployed} deployed, {scanSummary.serverOnly} server-only)
      </p>
      <button type="button" class="text-green-700 hover:text-green-900 text-sm" onclick={() => (scanSummary = null)}>✕</button>
    </div>
  {/if}
  {#if scanSummary?.errors?.length > 0}
    <div class="bg-amber-50 border border-amber-200 rounded-lg p-4">
      <p class="text-sm font-medium text-amber-800">Scan finished with {scanSummary.errors.length} warning{scanSummary.errors.length > 1 ? 's' : ''}:</p>
      <ul class="mt-1 text-xs text-amber-700 max-h-32 overflow-auto">
        {#each scanSummary.errors as err}
          <li>- {err}</li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if enqueueError}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700 text-sm">{enqueueError}</p>
    </div>
  {/if}

  {#if data.error}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700">{data.error}</p>
    </div>
  {:else}
    <!-- Runner panel -->
    {#if runnerActive || runner.recent.length > 0}
      <div class="border rounded-lg p-4 space-y-3 {runnerActive ? 'bg-emerald-50/50 border-emerald-200' : 'bg-muted/30'}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            <h3 class="font-semibold text-sm">Test Runner</h3>
            {#if runnerActive}
              <span class="inline-flex items-center gap-1.5 text-sm text-emerald-700">
                <svg class="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Running {runner.running.length}/{data.runnerConfig.maxConcurrent}
                {#if runner.queued.length > 0}
                  · {runner.queued.length} queued
                {/if}
              </span>
            {:else}
              <span class="text-sm text-muted-foreground">Idle</span>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            {#if runner.queued.length > 0}
              <Button variant="outline" size="sm" onclick={cancelQueue}>
                <ListX size={14} class="mr-1.5" />
                Cancel Queue ({runner.queued.length})
              </Button>
            {/if}
            {#if runnerActive}
              <Button variant="outline" size="sm" onclick={tickRunner} disabled={ticking}>
                {ticking ? 'Checking...' : 'Check Now'}
              </Button>
            {/if}
          </div>
        </div>

        {#if runner.running.length > 0}
          <div class="flex flex-wrap gap-2">
            {#each runner.running as run (run.id)}
              <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
                <svg class="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {run.flowName}
                <span class="text-emerald-600 font-normal">{formatRelativeTime(run.startedAt)}</span>
              </span>
            {/each}
          </div>
        {/if}

        {#if runner.recent.length > 0}
          <div class="flex flex-wrap gap-1.5 items-center">
            <span class="text-xs text-muted-foreground">Recent:</span>
            {#each runner.recent.slice(0, 10) as run (run.id)}
              <span
                class="inline-flex items-center px-2 py-0.5 rounded-full text-xs border
                  {run.state === 'passed' ? 'bg-green-50 text-green-700 border-green-200' : ''}
                  {run.state === 'failed' ? 'bg-red-50 text-red-700 border-red-200' : ''}
                  {run.state === 'timeout' ? 'bg-orange-50 text-orange-700 border-orange-200' : ''}
                  {run.state === 'error' ? 'bg-red-50 text-red-700 border-red-200' : ''}"
                title={run.error || run.state}
              >
                {run.state === 'passed' ? '✓' : '✗'} {run.flowName}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Stats -->
    <div class="flex flex-col lg:flex-row gap-4">
      <!-- Deployment -->
      <div class="space-y-2 flex-1">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Deployment (GitHub → Instance)</h3>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
          <button
            type="button"
            onclick={() => { syncFilter = ''; resultFilter = ''; }}
            class="border rounded-lg p-3 text-left hover:bg-muted/50 transition-colors cursor-pointer {syncFilter === '' && resultFilter === '' ? 'ring-2 ring-primary' : ''}"
          >
            <div class="text-2xl font-bold">{stats.total}</div>
            <div class="text-xs text-muted-foreground">Total Flows</div>
          </button>
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'match' ? '' : 'match'}
            class="border rounded-lg p-3 bg-green-50 text-left hover:bg-green-100 transition-colors cursor-pointer {syncFilter === 'match' ? 'ring-2 ring-green-500' : ''}"
          >
            <div class="text-2xl font-bold text-green-700">{stats.match}</div>
            <div class="text-xs font-medium text-green-600">In Sync</div>
          </button>
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'modified' ? '' : 'modified'}
            class="border rounded-lg p-3 bg-yellow-50 text-left hover:bg-yellow-100 transition-colors cursor-pointer {syncFilter === 'modified' ? 'ring-2 ring-yellow-500' : ''}"
          >
            <div class="text-2xl font-bold text-yellow-700">{stats.modified}</div>
            <div class="text-xs font-medium text-yellow-600">Modified</div>
          </button>
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'not_deployed' ? '' : 'not_deployed'}
            class="border rounded-lg p-3 bg-orange-50 text-left hover:bg-orange-100 transition-colors cursor-pointer {syncFilter === 'not_deployed' ? 'ring-2 ring-orange-500' : ''}"
          >
            <div class="text-2xl font-bold text-orange-700">{stats.notDeployed}</div>
            <div class="text-xs font-medium text-orange-600">Not Deployed</div>
          </button>
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'server_only' ? '' : 'server_only'}
            class="border rounded-lg p-3 bg-blue-50 text-left hover:bg-blue-100 transition-colors cursor-pointer {syncFilter === 'server_only' ? 'ring-2 ring-blue-500' : ''}"
          >
            <div class="text-2xl font-bold text-blue-700">{stats.serverOnly}</div>
            <div class="text-xs font-medium text-blue-600">Server Only</div>
          </button>
        </div>
      </div>

      <!-- Divider -->
      <div class="hidden lg:block w-px bg-border self-stretch"></div>
      <div class="lg:hidden h-px bg-border"></div>

      <!-- Results -->
      <div class="space-y-2">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Last Run Results</h3>
        <div class="grid grid-cols-3 gap-3">
          <button
            type="button"
            onclick={() => resultFilter = resultFilter === 'passed' ? '' : 'passed'}
            class="border rounded-lg p-3 bg-green-50 text-left hover:bg-green-100 transition-colors cursor-pointer {resultFilter === 'passed' ? 'ring-2 ring-green-500' : ''}"
          >
            <div class="text-2xl font-bold text-green-700">{stats.passed}</div>
            <div class="text-xs font-medium text-green-600">Passed</div>
          </button>
          <button
            type="button"
            onclick={() => resultFilter = resultFilter === 'failed' ? '' : 'failed'}
            class="border rounded-lg p-3 bg-red-50 text-left hover:bg-red-100 transition-colors cursor-pointer {resultFilter === 'failed' ? 'ring-2 ring-red-500' : ''}"
          >
            <div class="text-2xl font-bold text-red-700">{stats.failed}</div>
            <div class="text-xs font-medium text-red-600">Failed</div>
          </button>
          <button
            type="button"
            onclick={() => resultFilter = resultFilter === 'none' ? '' : 'none'}
            class="border rounded-lg p-3 bg-gray-50 text-left hover:bg-gray-100 transition-colors cursor-pointer {resultFilter === 'none' ? 'ring-2 ring-gray-400' : ''}"
          >
            <div class="text-2xl font-bold text-gray-700">{stats.neverRan}</div>
            <div class="text-xs font-medium text-gray-600">No Result</div>
          </button>
        </div>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-4">
      <Input
        type="text"
        placeholder="Search flows..."
        bind:value={searchQuery}
        class="max-w-sm"
      />
      <select
        bind:value={connectorFilter}
        class="px-3 py-2 border rounded-md bg-background text-sm"
      >
        <option value="">All Connectors</option>
        {#each connectors as connector}
          <option value={connector}>{connector}</option>
        {/each}
      </select>
      <select
        bind:value={syncFilter}
        class="px-3 py-2 border rounded-md bg-background text-sm"
      >
        <option value="">All Sync Status</option>
        <option value="match">In Sync</option>
        <option value="modified">Modified</option>
        <option value="not_deployed">Not Deployed</option>
        <option value="server_only">Server Only</option>
        <option value="error">Error</option>
      </select>
      <select
        bind:value={resultFilter}
        class="px-3 py-2 border rounded-md bg-background text-sm"
      >
        <option value="">All Results</option>
        <option value="passed">Passed</option>
        <option value="failed">Failed</option>
        <option value="none">No Result</option>
        <option value="active">Running / Queued</option>
      </select>
      {#if searchQuery || connectorFilter || syncFilter || resultFilter}
        <Button
          variant="ghost"
          size="sm"
          onclick={() => { searchQuery = ''; connectorFilter = ''; syncFilter = ''; resultFilter = ''; }}
        >
          Clear filters
        </Button>
      {/if}
    </div>

    <!-- Results count -->
    <p class="text-sm text-muted-foreground">
      {filteredFlows.length} flow{filteredFlows.length !== 1 ? 's' : ''} in {groupedFlows.length} connector{groupedFlows.length !== 1 ? 's' : ''}
      {#if filteredFlows.length !== flows.length}
        <span class="text-muted-foreground/60">(filtered from {flows.length})</span>
      {/if}
    </p>

    <!-- Grouped flows -->
    {#if flows.length === 0}
      <div class="text-center py-12 border rounded-lg bg-muted/50">
        <p class="text-muted-foreground">No E2E flows cached yet.</p>
        <Button class="mt-4" onclick={runScan} disabled={isScanning}>
          <RefreshCw size={15} class="mr-2 {isScanning ? 'animate-spin' : ''}" />
          {isScanning ? 'Scanning...' : 'Run First Scan'}
        </Button>
      </div>
    {:else if filteredFlows.length === 0}
      <div class="text-center py-12 border rounded-lg bg-muted/50">
        <p class="text-muted-foreground">No flows match the current filters</p>
      </div>
    {:else}
      <div class="space-y-4">
        {#each groupedFlows as group (group.connector)}
          {@const groupSelectable = group.flows.filter(isSelectable)}
          {@const groupAllSelected =
            groupSelectable.length > 0 &&
            groupSelectable.every((f) => selectedFlowNames.has(f.flowName))}
          <div class="border rounded-lg overflow-hidden">
            <!-- Group header -->
            <div class="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b">
              <div class="flex items-center gap-3">
                {#if groupSelectable.length > 0}
                  <Checkbox
                    checked={groupAllSelected}
                    onCheckedChange={() => toggleGroupSelection(groupSelectable, groupAllSelected)}
                    aria-label="Select all actionable flows of {group.connector}"
                  />
                {/if}
                <span class="font-semibold">{group.connector}</span>
                <span class="text-xs text-muted-foreground">
                  {group.flows.length} flow{group.flows.length !== 1 ? 's' : ''} · {group.deployed} deployed
                </span>
                {#if group.passed > 0}
                  <span class="text-xs text-green-600 font-medium">✓ {group.passed}</span>
                {/if}
                {#if group.failed > 0}
                  <span class="text-xs text-red-600 font-medium">✗ {group.failed}</span>
                {/if}
                {#if group.accountAvailable === true}
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-emerald-50 text-emerald-700 border-emerald-200"
                    title="A service account for this connector exists on the instance"
                  >
                    Account
                  </span>
                {:else if group.accountAvailable === false}
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-amber-50 text-amber-800 border-amber-200"
                    title="No service account for this connector on the instance — flows will not run until one is connected"
                  >
                    No account
                  </span>
                {/if}
              </div>
              {#if group.deployed > 0}
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => runConnector(group.connector)}
                  disabled={enqueueBusy}
                  title="Queue all deployed flows of this connector"
                >
                  <Play size={13} class="mr-1.5" />
                  Run
                </Button>
              {/if}
            </div>

            <!-- Group rows -->
            <table class="w-full text-sm">
              <tbody class="divide-y">
                {#each group.flows as flow (flow.flowName)}
                  {@const isRunning = runningNames.has(flow.flowName)}
                  {@const isQueued = queuedNames.has(flow.flowName)}
                  {@const selectable = isSelectable(flow)}
                  {@const syncConfig = syncStatusConfig[flow.syncStatus] || syncStatusConfig.error}
                  <tr class="hover:bg-muted/30 {selectedFlowNames.has(flow.flowName) ? 'bg-muted/50' : ''}">
                    <td class="w-10 px-4 py-2">
                      {#if selectable}
                        <Checkbox
                          checked={selectedFlowNames.has(flow.flowName)}
                          onCheckedChange={() => toggleFlowSelection(flow.flowName)}
                          aria-label="Select {flow.flowName}"
                        />
                      {/if}
                    </td>
                    <td class="px-2 py-2">
                      <span class="font-medium">{flow.flowName}</span>
                      {#if flow.githubPath}
                        <div class="text-xs text-muted-foreground font-mono">{flow.githubPath}</div>
                      {:else if flow.flowId}
                        <div class="text-xs text-muted-foreground font-mono">{flow.flowId}</div>
                      {/if}
                    </td>
                    <td class="px-2 py-2 w-32">
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border {syncConfig.class}">
                        {syncConfig.label}
                      </span>
                    </td>
                    <td class="px-2 py-2 w-40">
                      {#if isRunning}
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border bg-emerald-100 text-emerald-800 border-emerald-200">
                          <svg class="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Running
                        </span>
                      {:else if isQueued}
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-sky-100 text-sky-800 border-sky-200">
                          Queued
                        </span>
                      {:else if flow.lastResult === 'passed'}
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-green-100 text-green-800 border-green-200" title={flow.lastResultAt}>
                          ✓ Passed
                        </span>
                        <span class="text-xs text-muted-foreground ml-1">{formatRelativeTime(flow.lastResultAt)}</span>
                      {:else if flow.lastResult === 'failed'}
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-red-100 text-red-800 border-red-200" title={flow.lastResultAt}>
                          ✗ Failed
                        </span>
                        <span class="text-xs text-muted-foreground ml-1">{formatRelativeTime(flow.lastResultAt)}</span>
                      {:else}
                        <span class="text-xs text-muted-foreground">—</span>
                      {/if}
                      {#if flow.stage === 'running' && !isRunning}
                        <span class="ml-1 inline-block w-2 h-2 rounded-full bg-emerald-500" title="Flow is running on the instance"></span>
                      {/if}
                    </td>
                    <td class="px-4 py-2 w-52">
                      <div class="flex items-center gap-1 justify-end">
                        {#if flow.flowId}
                          <button
                            type="button"
                            onclick={() => runFlow(flow)}
                            disabled={enqueueBusy || isRunning || isQueued}
                            class="inline-flex items-center justify-center rounded-md p-1.5 text-emerald-600 hover:bg-emerald-50 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                            title="Run E2E test"
                          >
                            <Play size={15} />
                          </button>
                        {/if}
                        {#if flow.lastResultDetail}
                          <button
                            type="button"
                            onclick={() => openResults(flow)}
                            class="inline-flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 transition-colors"
                            title="View last run details"
                          >
                            <FileText size={15} />
                          </button>
                        {/if}
                        {#if flow.syncStatus === 'modified'}
                          <button
                            type="button"
                            onclick={() => openDiff(flow)}
                            class="inline-flex items-center justify-center rounded-md p-1.5 text-yellow-600 hover:bg-yellow-50 transition-colors"
                            title="View changes (instance vs GitHub)"
                          >
                            <FileDiff size={15} />
                          </button>
                        {/if}
                        {#if flow.url}
                          <a
                            href={flow.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="inline-flex items-center justify-center rounded-md p-1.5 text-blue-600 hover:bg-blue-50 transition-colors"
                            title="Open in Designer"
                          >
                            <ExternalLink size={15} />
                          </a>
                        {/if}
                        {#if flow.githubUrl}
                          <a
                            href={flow.githubUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="inline-flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 transition-colors"
                            title="View on GitHub"
                          >
                            <Github size={15} />
                          </a>
                        {/if}
                        {#if flow.flowId}
                          <button
                            type="button"
                            onclick={() => toggleFlow(flow)}
                            disabled={togglingFlowNames.has(flow.flowName)}
                            class="inline-flex items-center justify-center rounded-md p-1.5 transition-colors {flow.stage === 'running' ? 'text-amber-600 hover:bg-amber-50' : 'text-gray-400 hover:bg-gray-100'} disabled:opacity-50 disabled:pointer-events-none"
                            title={flow.stage === 'running' ? 'Stop flow' : 'Start flow (without runner)'}
                          >
                            {#if togglingFlowNames.has(flow.flowName)}
                              <svg class="animate-spin h-[15px] w-[15px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                            {:else if flow.stage === 'running'}
                              <Square size={15} />
                            {:else}
                              <Play size={15} class="opacity-60" />
                            {/if}
                          </button>
                          <button
                            type="button"
                            onclick={() => confirmDelete(flow)}
                            class="inline-flex items-center justify-center rounded-md p-1.5 text-red-600 hover:bg-red-50 transition-colors"
                            title="Remove from Appmixer"
                          >
                            <Trash2 size={15} />
                          </button>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Floating Action Bar -->
    {#if selectedFlowNames.size > 0}
      <div class="fixed bottom-6 left-1/2 -translate-x-1/2 bg-background border shadow-lg rounded-lg px-4 py-3 flex items-center gap-4 z-50">
        <span class="text-sm font-medium">
          {selectedFlowNames.size} flow{selectedFlowNames.size > 1 ? 's' : ''} selected
        </span>
        <div class="h-4 w-px bg-border"></div>
        <Button variant="outline" size="sm" onclick={clearSelection}>
          Clear
        </Button>
        <Button
          variant="outline"
          size="sm"
          onclick={openUploadDialog}
          disabled={uploadableFlows.length === 0}
          title="Overwrite/create the selected flows on the instance from their GitHub version"
        >
          Upload to Instance{uploadableFlows.length ? ` (${uploadableFlows.length})` : ''}
        </Button>
        <Button size="sm" onclick={openSyncDialog} disabled={syncableFlows.length === 0}>
          Sync to GitHub{syncableFlows.length ? ` (${syncableFlows.length})` : ''}
        </Button>
      </div>
    {/if}
  {/if}
</div>

<!-- Upload to Instance Dialog -->
<Dialog bind:open={showUploadDialog}>
  <DialogContent class="max-w-2xl max-h-[85vh] flex flex-col">
    <DialogHeader>
      <DialogTitle>Upload Flows to Instance</DialogTitle>
      <DialogDescription>
        Deploy the GitHub version of the selected flows to the Appmixer instance.
        Existing flows are overwritten, missing ones are created; accounts are bound automatically.
      </DialogDescription>
    </DialogHeader>

    <div class="py-2 overflow-auto flex-1 min-h-0">
      <div class="border rounded-lg divide-y">
        {#each uploadRows as row (row.flowName)}
          <div class="flex items-center gap-3 px-3 py-2 text-sm">
            <span class="w-5 text-center shrink-0">
              {#if row.state === 'pending'}
                <span class="text-muted-foreground">·</span>
              {:else if row.state === 'uploading'}
                <svg class="animate-spin h-3.5 w-3.5 text-blue-600 inline" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
              {:else if row.state === 'done'}
                <span class="text-green-600">✓</span>
              {:else if row.state === 'warning'}
                <span class="text-amber-600">⚠</span>
              {:else}
                <span class="text-red-600">✗</span>
              {/if}
            </span>
            <span class="font-medium flex-1 min-w-0 truncate">{row.flowName}</span>
            <span class="text-xs shrink-0 max-w-[45%] truncate {row.state === 'error' ? 'text-red-600' : row.state === 'warning' ? 'text-amber-700' : 'text-muted-foreground'}" title={row.detail}>
              {row.detail}
            </span>
          </div>
        {/each}
      </div>
    </div>

    <DialogFooter>
      {#if uploadFinished}
        <Button onclick={closeUploadDialog}>Close</Button>
      {:else}
        <Button variant="outline" onclick={closeUploadDialog} disabled={isUploading}>
          Cancel
        </Button>
        <Button onclick={performUpload} disabled={isUploading}>
          {#if isUploading}
            <svg class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Uploading…
          {:else}
            Upload {uploadRows.length} flow{uploadRows.length !== 1 ? 's' : ''}
          {/if}
        </Button>
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Sync to GitHub Dialog -->
<Dialog bind:open={showSyncDialog}>
  <DialogContent class="max-w-2xl">
    <DialogHeader>
      <DialogTitle>Sync Flows to GitHub</DialogTitle>
      <DialogDescription>
        Create a pull request with the selected E2E flows.
      </DialogDescription>
    </DialogHeader>

    {#if syncResult?.success}
      <div class="py-6 text-center space-y-4">
        <div class="w-16 h-16 mx-auto bg-green-100 rounded-full flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-green-600">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
        <div>
          <h3 class="text-lg font-semibold">Pull Request Created</h3>
          <p class="text-muted-foreground mt-1">
            {syncResult.synced?.length || 0} flow{(syncResult.synced?.length || 0) > 1 ? 's' : ''} synced successfully
          </p>
        </div>
        <a
          href={syncResult.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-2 text-blue-600 hover:underline font-medium"
        >
          View Pull Request #{syncResult.prNumber}
          <ExternalLink size={16} />
        </a>
        {#if syncResult.errors?.length > 0}
          <div class="mt-4 text-left bg-amber-50 border border-amber-200 rounded-lg p-3">
            <p class="text-sm font-medium text-amber-800">Some flows failed to sync:</p>
            <ul class="mt-2 text-sm text-amber-700">
              {#each syncResult.errors as error}
                <li>- {error.name}: {error.error}</li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
      <DialogFooter>
        <Button onclick={closeSyncDialog}>Close</Button>
      </DialogFooter>
    {:else}
      <div class="py-4 space-y-4">
        <div class="space-y-2">
          <label for="pr-title" class="text-sm font-medium">PR Title</label>
          <Input
            id="pr-title"
            placeholder="Enter PR title..."
            bind:value={syncPrTitle}
            disabled={isSyncing}
          />
        </div>

        <div class="space-y-2">
          <label for="pr-description" class="text-sm font-medium">
            Description
            <span class="text-muted-foreground font-normal ml-1">(optional)</span>
          </label>
          <textarea
            id="pr-description"
            placeholder="Enter PR description..."
            bind:value={syncPrDescription}
            disabled={isSyncing}
            rows="3"
            class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          ></textarea>
        </div>

        <div class="space-y-2">
          <label for="target-branch" class="text-sm font-medium">Target Branch</label>
          <Input
            id="target-branch"
            placeholder="e.g., dev"
            bind:value={syncTargetBranch}
            disabled={isSyncing}
          />
        </div>

        <div class="space-y-2">
          <p class="text-sm font-medium">Flows to sync ({syncableFlows.length})</p>
          <div class="max-h-48 overflow-y-auto border rounded-lg">
            <table class="w-full text-sm">
              <thead class="bg-muted/50 sticky top-0">
                <tr>
                  <th class="text-left px-3 py-2 font-medium">Flow</th>
                  <th class="text-left px-3 py-2 font-medium">Path</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                {#each syncableFlows as flow}
                  <tr>
                    <td class="px-3 py-2">
                      <span class="font-medium">{flow.flowName}</span>
                      <Badge variant="outline" class="ml-2 text-xs">{flow.syncStatus === 'modified' ? 'Modified' : 'New'}</Badge>
                    </td>
                    <td class="px-3 py-2 text-muted-foreground font-mono text-xs">
                      {flow.githubPath || generateFlowPath(flow.connector, flow.flowName)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>

        {#if syncError}
          <div class="bg-red-50 border border-red-200 rounded-lg p-3">
            <p class="text-sm text-red-700">{syncError}</p>
          </div>
        {/if}
      </div>

      <DialogFooter>
        <Button variant="outline" onclick={() => showSyncDialog = false} disabled={isSyncing}>
          Cancel
        </Button>
        <Button onclick={performSync} disabled={isSyncing}>
          {#if isSyncing}
            <svg class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Creating PR...
          {:else}
            Create Pull Request
          {/if}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

<!-- Delete Confirmation Dialog -->
<Dialog bind:open={showDeleteDialog}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Remove Flow from Appmixer</DialogTitle>
      <DialogDescription>
        Are you sure you want to remove this flow from the Appmixer instance?
      </DialogDescription>
    </DialogHeader>

    <div class="py-4">
      {#if flowToDelete}
        <div class="bg-muted rounded-lg p-4">
          <p class="font-medium">{flowToDelete.flowName}</p>
          {#if flowToDelete.connector}
            <p class="text-sm text-muted-foreground mt-1">Connector: {flowToDelete.connector}</p>
          {/if}
        </div>
        <p class="text-sm text-muted-foreground mt-4">
          This action cannot be undone. The flow will be permanently deleted from the Appmixer instance.
        </p>
      {/if}

      {#if deleteError}
        <div class="bg-red-50 border border-red-200 rounded-lg p-3 mt-4">
          <p class="text-sm text-red-700">{deleteError}</p>
        </div>
      {/if}
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => showDeleteDialog = false} disabled={isDeleting}>
        Cancel
      </Button>
      <Button variant="destructive" onclick={performDelete} disabled={isDeleting}>
        {#if isDeleting}
          <svg class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          Removing...
        {:else}
          Remove Flow
        {/if}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Diff Dialog -->
<Dialog bind:open={showDiffDialog}>
  <DialogContent class="max-w-5xl max-h-[85vh] flex flex-col">
    <DialogHeader>
      <DialogTitle>Flow Changes</DialogTitle>
      <DialogDescription>
        {#if diffFlow}
          Comparing <span class="font-medium">{diffFlow.flowName}</span> — instance vs GitHub
          {#if diffData?.githubPath}
            <span class="text-muted-foreground">({diffData.githubPath})</span>
          {/if}
        {/if}
      </DialogDescription>
    </DialogHeader>

    {#if isDiffLoading}
      <div class="flex items-center justify-center py-12">
        <svg class="animate-spin h-6 w-6 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span class="ml-2 text-sm text-muted-foreground">Loading diff...</span>
      </div>
    {:else if diffError}
      <div class="bg-red-50 border border-red-200 rounded-lg p-4">
        <p class="text-red-700 text-sm">{diffError}</p>
      </div>
    {:else if diffData}
      {#if revertSuccess}
        <div class="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
          <p class="text-green-700 font-medium">Flow reverted to GitHub version successfully.</p>
        </div>
      {:else}
        {@const lines = computeDiff(diffData.github, diffData.server)}
        {@const added = lines.filter(l => l.type === 'added').length}
        {@const removed = lines.filter(l => l.type === 'removed').length}
        <div class="flex items-center gap-3 text-xs text-muted-foreground pb-2 border-b">
          <span class="text-green-700 font-medium">+{added} added</span>
          <span class="text-red-700 font-medium">-{removed} removed</span>
          <span>{lines.filter(l => l.type === 'context').length} unchanged</span>
        </div>
        <div class="overflow-auto flex-1 min-h-0 border rounded-md bg-muted/30">
          <table class="w-full text-xs font-mono leading-5">
            {#each lines as line}
              <tr class={line.type === 'added' ? 'bg-green-50' : line.type === 'removed' ? 'bg-red-50' : 'hover:bg-muted/50'}>
                <td class="w-6 text-center select-none {line.type === 'added' ? 'text-green-600 bg-green-100' : line.type === 'removed' ? 'text-red-600 bg-red-100' : 'text-muted-foreground'}">
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ''}
                </td>
                <td class="px-3 whitespace-pre {line.type === 'added' ? 'text-green-900' : line.type === 'removed' ? 'text-red-900' : ''}">{line.line}</td>
              </tr>
            {/each}
          </table>
        </div>
        {#if revertError}
          <div class="bg-red-50 border border-red-200 rounded-lg p-3">
            <p class="text-sm text-red-700">{revertError}</p>
          </div>
        {/if}
      {/if}
    {/if}

    <DialogFooter>
      {#if diffData && !revertSuccess}
        <Button variant="destructive" onclick={revertFlow} disabled={isReverting}>
          {#if isReverting}
            <svg class="animate-spin -ml-1 mr-2 h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            Reverting...
          {:else}
            Revert to GitHub Version
          {/if}
        </Button>
      {/if}
      <Button variant="outline" onclick={closeDiffDialog}>Close</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- E2E Results Dialog (cached last run) -->
<Dialog bind:open={showResultsDialog}>
  <DialogContent class="max-w-6xl max-h-[85vh] flex flex-col">
    <DialogHeader>
      <DialogTitle>E2E Test Run Details</DialogTitle>
      <DialogDescription>
        {#if resultsFlow}
          Latest run for <span class="font-medium">{resultsFlow.flowName}</span>
          {#if resultsFlow.lastResultAt}
            <span class="text-muted-foreground">({formatRelativeTime(resultsFlow.lastResultAt)})</span>
          {/if}
        {/if}
      </DialogDescription>
    </DialogHeader>

    {#if resultsFlow}
      <div class="space-y-6 overflow-auto flex-1 pr-1">
        <div class="border rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <tbody class="divide-y">
              <tr>
                <td class="w-44 font-medium bg-muted/30 px-3 py-2">Name</td>
                <td class="px-3 py-2">{resultsFlow.flowName}</td>
              </tr>
              <tr>
                <td class="font-medium bg-muted/30 px-3 py-2">Designer</td>
                <td class="px-3 py-2">
                  {#if resultsFlow.url}
                    <a href={resultsFlow.url} target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline break-all">{resultsFlow.url}</a>
                  {:else}
                    <span class="text-muted-foreground">N/A</span>
                  {/if}
                </td>
              </tr>
              <tr>
                <td class="font-medium bg-muted/30 px-3 py-2">Status</td>
                <td class="px-3 py-2">
                  {#if resultsFlow.lastResult === 'passed'}
                    <span class="text-green-700 font-medium">Passed</span>
                  {:else if resultsFlow.lastResult === 'failed'}
                    <span class="text-red-700 font-medium">Failed</span>
                  {:else}
                    <span class="text-muted-foreground">Unknown</span>
                  {/if}
                </td>
              </tr>
              <tr>
                <td class="font-medium bg-muted/30 px-3 py-2">Failed components</td>
                <td class="px-3 py-2">{resultsDetails.filter(d => d.status === 'failed').length} / {resultsDetails.length}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="border rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead class="bg-muted/40">
              <tr>
                <th class="text-left px-3 py-2 font-medium">Component</th>
                <th class="text-left px-3 py-2 font-medium w-20">Status</th>
                <th class="text-left px-3 py-2 font-medium">Checks</th>
                <th class="text-left px-3 py-2 font-medium">ComponentId</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              {#if resultsDetails.length > 0}
                {#each resultsDetails as detail}
                  <tr>
                    <td class="px-3 py-2">{detail.componentName}</td>
                    <td class="px-3 py-2 text-lg leading-none">{detail.status === 'failed' ? '❌' : '✅'}</td>
                    <td class="px-3 py-2">
                      {#if detail.success?.length > 0 || detail.errors?.length > 0}
                        <div class="space-y-1">
                          {#each detail.success as item}
                            <div class="text-green-700">✅ {item}</div>
                          {/each}
                          {#each detail.errors as item}
                            <div class="text-red-700">❌ {item}</div>
                          {/each}
                        </div>
                      {:else}
                        <span class="text-muted-foreground">—</span>
                      {/if}
                    </td>
                    <td class="px-3 py-2">
                      {#if detail.componentId}
                        <a
                          href={getComponentLink(detail.componentId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-blue-600 hover:underline break-all"
                        >
                          {detail.componentId}
                        </a>
                      {:else}
                        <span class="text-muted-foreground">—</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              {:else}
                <tr>
                  <td colspan="4" class="px-3 py-6 text-center text-muted-foreground">No component-level details found</td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    <DialogFooter>
      <Button variant="outline" onclick={() => showResultsDialog = false}>Close</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
