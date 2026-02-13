<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { invalidateAll } from '$app/navigation';
  import { ExternalLink, Github, Trash2, FileDiff, FileText, Play, Square } from 'lucide-svelte';

  let { data } = $props();

  const PAGE_SIZE = 16;

  let searchQuery = $state('');
  let connectorFilter = $state('');
  let syncFilter = $state('');
  let runningFilter = $state('');
  let currentPage = $state(1);

  // Flow selection state
  let selectedFlowIds = $state(new Set());

  // Sync status deferred loading
  /** @type {Record<string, {syncStatus: string, githubUrl: string|null, githubPath: string|null}>} */
  let syncStatuses = $state({});
  let syncStatusLoading = $state(false);

  // Merge sync statuses into flows
  const flows = $derived(
    data.flows.map(f => {
      const status = syncStatuses[f.flowId];
      if (status) {
        return { ...f, ...status };
      }
      return f;
    })
  );

  // Compute stats from merged flows
  const stats = $derived({
    total: flows.length,
    running: flows.filter(f => f.running).length,
    stopped: flows.filter(f => !f.running).length,
    match: flows.filter(f => f.syncStatus === 'match').length,
    modified: flows.filter(f => f.syncStatus === 'modified').length,
    serverOnly: flows.filter(f => f.syncStatus === 'server_only').length,
    error: flows.filter(f => f.syncStatus === 'error').length
  });

  // Fetch sync statuses lazily after page renders
  async function loadSyncStatuses() {
    if (!data.flows.length) return;

    syncStatusLoading = true;
    try {
      const response = await fetch('/api/e2e-flows/sync-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flows: data.flows.map(f => ({ flowId: f.flowId, name: f.name }))
        })
      });

      if (response.ok) {
        const result = await response.json();
        syncStatuses = result.statuses;
      }
    } catch (e) {
      console.error('Failed to load sync statuses:', e);
    } finally {
      syncStatusLoading = false;
    }
  }

  // Load sync statuses when data changes (initial load + after invalidateAll)
  $effect(() => {
    // Access data.flows to track dependency
    if (data.flows.length > 0) {
      loadSyncStatuses();
    }
  });

  // Sync dialog state
  let showSyncDialog = $state(false);
  let syncPrTitle = $state('');
  let syncPrDescription = $state('');
  let syncTargetBranch = $state('');
  let isSyncing = $state(false);
  let syncError = $state('');
  let syncResult = $state(null);

  // Delete dialog state
  let showDeleteDialog = $state(false);
  let flowToDelete = $state(null);
  let isDeleting = $state(false);
  let deleteError = $state('');

  // Toggle (start/stop) state - track which flows are currently toggling
  /** @type {Set<string>} */
  let togglingFlowIds = $state(new Set());

  async function toggleFlow(flow) {
    const action = flow.running ? 'stop' : 'start';
    const newSet = new Set(togglingFlowIds);
    newSet.add(flow.flowId);
    togglingFlowIds = newSet;

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
      const cleanup = new Set(togglingFlowIds);
      cleanup.delete(flow.flowId);
      togglingFlowIds = cleanup;
    }
  }

  // Diff dialog state
  let showDiffDialog = $state(false);
  let diffFlow = $state(null);
  let isDiffLoading = $state(false);
  let diffError = $state('');
  let diffData = $state(null);

  // E2E results dialog state
  let showResultsDialog = $state(false);
  let resultsFlow = $state(null);
  let isResultsLoading = $state(false);
  let resultsError = $state('');
  let resultsData = $state(null);

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
        body: JSON.stringify({ flowId: flow.flowId, flowName: flow.name })
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

  async function openResults(flow) {
    resultsFlow = flow;
    resultsError = '';
    resultsData = null;
    showResultsDialog = true;
    isResultsLoading = true;

    try {
      const response = await fetch('/api/e2e-flows/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flowId: flow.flowId, flowName: flow.name })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to load results: ${response.status}`);
      }

      resultsData = await response.json();
    } catch (e) {
      resultsError = e.message || 'Failed to load E2E results';
    } finally {
      isResultsLoading = false;
    }
  }

  function getComponentLink(componentId) {
    if (!resultsFlow?.url || !componentId) {
      return resultsFlow?.url || '#';
    }

    return `${resultsFlow.url}?componentId=${encodeURIComponent(componentId)}`;
  }

  /**
   * Compute a simple line-based unified diff between two strings
   */
  function computeDiff(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const result = [];
    let oi = 0, ni = 0;

    // Simple LCS-based diff
    const lcs = buildLCS(oldLines, newLines);
    let li = 0;
    oi = 0;
    ni = 0;

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
    // For very large files, skip LCS and show full replace
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

  // Check if a flow can be selected (only modified and server_only)
  function isSelectable(flow) {
    return flow.syncStatus === 'modified' || flow.syncStatus === 'server_only';
  }

  // Selected flows data (for sync dialog)
  const selectedFlows = $derived(
    flows.filter(f => selectedFlowIds.has(f.flowId))
  );

  // Toggle selection of a single flow
  function toggleFlowSelection(flowId) {
    const newSet = new Set(selectedFlowIds);
    if (newSet.has(flowId)) {
      newSet.delete(flowId);
    } else {
      newSet.add(flowId);
    }
    selectedFlowIds = newSet;
  }

  // Toggle selection of all selectable flows
  function toggleSelectAll() {
    if (allSelectableSelected) {
      // Deselect all selectable flows
      const newSet = new Set(selectedFlowIds);
      selectableFlows.forEach(f => newSet.delete(f.flowId));
      selectedFlowIds = newSet;
    } else {
      // Select all selectable flows
      const newSet = new Set(selectedFlowIds);
      selectableFlows.forEach(f => newSet.add(f.flowId));
      selectedFlowIds = newSet;
    }
  }

  // Clear all selections
  function clearSelection() {
    selectedFlowIds = new Set();
  }

  // Generate file path for server_only flows
  function generateFlowPath(connector, flowName) {
    const safeName = flowName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return `src/appmixer/${connector || 'unknown'}/test-flow-${safeName}.json`;
  }

  // Open sync dialog
  function openSyncDialog() {
    const count = selectedFlowIds.size;
    syncPrTitle = `Sync ${count} E2E flow${count > 1 ? 's' : ''} from Appmixer`;
    syncPrDescription = '';
    syncTargetBranch = data.githubInfo?.branch || 'dev';
    syncError = '';
    syncResult = null;
    showSyncDialog = true;
  }

  // Perform the sync
  async function performSync() {
    if (!syncPrTitle.trim()) {
      syncError = 'PR title is required';
      return;
    }

    isSyncing = true;
    syncError = '';

    try {
      const flowsToSync = selectedFlows.map(f => ({
        flowId: f.flowId,
        name: f.name,
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

      const result = await response.json();
      syncResult = result;

      // Clear selection after successful sync
      clearSelection();

    } catch (e) {
      syncError = e.message || 'Failed to sync flows';
    } finally {
      isSyncing = false;
    }
  }

  // Close sync dialog and refresh if successful
  async function closeSyncDialog() {
    const hadSuccess = syncResult?.success;
    showSyncDialog = false;
    syncResult = null;

    if (hadSuccess) {
      await invalidateAll();
    }
  }

  // Open delete confirmation dialog
  function confirmDelete(flow) {
    flowToDelete = flow;
    deleteError = '';
    showDeleteDialog = true;
  }

  // Perform the delete
  async function performDelete() {
    if (!flowToDelete) return;

    isDeleting = true;
    deleteError = '';

    try {
      const response = await fetch('/api/e2e-flows/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flowIds: [flowToDelete.flowId]
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to delete: ${response.status}`);
      }

      const result = await response.json();
      if (result.errors?.length > 0) {
        throw new Error(result.errors[0].error);
      }

      // Remove from selection if selected
      if (selectedFlowIds.has(flowToDelete?.flowId)) {
        const newSet = new Set(selectedFlowIds);
        newSet.delete(flowToDelete.flowId);
        selectedFlowIds = newSet;
      }

      // Close dialog and refresh
      showDeleteDialog = false;
      flowToDelete = null;

      await invalidateAll();

    } catch (e) {
      deleteError = e.message || 'Failed to delete flow';
    } finally {
      isDeleting = false;
    }
  }

  // GitHub settings dialog
  let showGitHubSettingsDialog = $state(false);
  let settingsOwner = $state('');
  let settingsRepo = $state('');
  let settingsBranch = $state('');
  let settingsToken = $state('');
  let clearCustomToken = $state(false);
  let isSavingGitHubSettings = $state(false);
  let gitHubSettingsError = $state('');

  // Appmixer settings dialog
  let showAppmixerSettingsDialog = $state(false);
  let appmixerBaseUrl = $state('');
  let appmixerUsername = $state('');
  let appmixerPassword = $state('');
  let clearAppmixerCredentials = $state(false);
  let isSavingAppmixerSettings = $state(false);
  let appmixerSettingsError = $state('');

  // Initialize GitHub settings form when dialog opens
  $effect(() => {
    if (showGitHubSettingsDialog && data.githubInfo) {
      settingsOwner = data.githubInfo.owner;
      settingsRepo = data.githubInfo.repo;
      settingsBranch = data.githubInfo.branch;
      settingsToken = '';
      clearCustomToken = false;
      gitHubSettingsError = '';
    }
  });

  // Initialize Appmixer settings form when dialog opens
  $effect(() => {
    if (showAppmixerSettingsDialog && data.appmixerInfo) {
      appmixerBaseUrl = data.appmixerInfo.baseUrl;
      appmixerUsername = data.appmixerInfo.username;
      appmixerPassword = '';
      clearAppmixerCredentials = false;
      appmixerSettingsError = '';
    }
  });

  async function saveGitHubSettings() {
    if (!settingsOwner.trim() || !settingsRepo.trim() || !settingsBranch.trim()) {
      gitHubSettingsError = 'All fields are required';
      return;
    }

    isSavingGitHubSettings = true;
    gitHubSettingsError = '';

    try {
      const response = await fetch('/api/settings/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: settingsOwner.trim(),
          repo: settingsRepo.trim(),
          branch: settingsBranch.trim(),
          token: settingsToken.trim(),
          clearToken: clearCustomToken
        })
      });

      if (!response.ok) {
        const error = await response.json();
        gitHubSettingsError = error.error || 'Failed to save settings';
        return;
      }

      showGitHubSettingsDialog = false;
      await invalidateAll();
    } catch (e) {
      gitHubSettingsError = 'Failed to save settings';
    } finally {
      isSavingGitHubSettings = false;
    }
  }

  async function saveAppmixerSettings() {
    if (clearAppmixerCredentials) {
      isSavingAppmixerSettings = true;
      appmixerSettingsError = '';

      try {
        const response = await fetch('/api/settings/appmixer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearCredentials: true })
        });

        if (!response.ok) {
          const error = await response.json();
          appmixerSettingsError = error.error || 'Failed to clear credentials';
          return;
        }

        showAppmixerSettingsDialog = false;
        await invalidateAll();
      } catch (e) {
        appmixerSettingsError = 'Failed to clear credentials';
      } finally {
        isSavingAppmixerSettings = false;
      }
      return;
    }

    if (!appmixerBaseUrl.trim() || !appmixerUsername.trim()) {
      appmixerSettingsError = 'Base URL and username are required';
      return;
    }

    isSavingAppmixerSettings = true;
    appmixerSettingsError = '';

    try {
      const response = await fetch('/api/settings/appmixer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: appmixerBaseUrl.trim(),
          username: appmixerUsername.trim(),
          password: appmixerPassword.trim()
        })
      });

      if (!response.ok) {
        const error = await response.json();
        appmixerSettingsError = error.error || 'Failed to save settings';
        return;
      }

      showAppmixerSettingsDialog = false;
      await invalidateAll();
    } catch (e) {
      appmixerSettingsError = 'Failed to save settings';
    } finally {
      isSavingAppmixerSettings = false;
    }
  }

  // Get unique connectors for filter dropdown
  const connectors = $derived(
    [...new Set(flows.map(f => f.connector).filter(Boolean))].sort()
  );

  const filteredFlows = $derived(
    flows.filter(flow => {
      const matchesSearch = !searchQuery ||
        flow.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        flow.connector?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesConnector = !connectorFilter || flow.connector === connectorFilter;

      const matchesSync = !syncFilter || flow.syncStatus === syncFilter;

      const matchesRunning = !runningFilter ||
        (runningFilter === 'running' && flow.running) ||
        (runningFilter === 'stopped' && !flow.running);

      return matchesSearch && matchesConnector && matchesSync && matchesRunning;
    })
  );

  // Reset to page 1 when filters change
  $effect(() => {
    // Track all filter dependencies
    searchQuery; connectorFilter; syncFilter; runningFilter;
    currentPage = 1;
  });

  // Pagination
  const totalPages = $derived(Math.max(1, Math.ceil(filteredFlows.length / PAGE_SIZE)));

  // Clamp currentPage when totalPages shrinks (e.g. sync statuses resolve with a filter active)
  $effect(() => {
    if (currentPage > totalPages) {
      currentPage = totalPages;
    }
  });

  const paginatedFlows = $derived(
    filteredFlows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  );

  // Selectable flows from filtered list (must be after filteredFlows)
  const selectableFlows = $derived(
    filteredFlows.filter(isSelectable)
  );

  // Check if all selectable flows are selected
  const allSelectableSelected = $derived(
    selectableFlows.length > 0 &&
    selectableFlows.every(f => selectedFlowIds.has(f.flowId))
  );

  // Visible page numbers (with ellipsis gaps)
  const visiblePages = $derived(() => {
    const pages = [];
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || (p >= currentPage - 2 && p <= currentPage + 2)) {
        pages.push(p);
      }
    }
    return pages;
  });

  // Sync status configuration
  const syncStatusConfig = {
    match: { label: 'In Sync', class: 'bg-green-100 text-green-800 border-green-200', description: 'Flow matches the GitHub repository' },
    modified: { label: 'Modified', class: 'bg-yellow-100 text-yellow-800 border-yellow-200', description: 'Changes on instance, needs to be pushed to git' },
    server_only: { label: 'Server Only', class: 'bg-blue-100 text-blue-800 border-blue-200', description: 'Flow is not in the GitHub repository' },
    error: { label: 'Error', class: 'bg-red-100 text-red-800 border-red-200', description: 'Failed to compare flow' }
  };

  // Handle Escape key to close dialogs
  function handleKeydown(event) {
    if (event.key === 'Escape') {
      if (showDiffDialog) showDiffDialog = false;
      else if (showResultsDialog) showResultsDialog = false;
      else if (showDeleteDialog) showDeleteDialog = false;
      else if (showSyncDialog) showSyncDialog = false;
      else if (showAppmixerSettingsDialog) showAppmixerSettingsDialog = false;
      else if (showGitHubSettingsDialog) showGitHubSettingsDialog = false;
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
      <p class="text-muted-foreground">All E2E test flows from the Appmixer instance compared with GitHub</p>
    </div>
  </div>

  <!-- Source Info -->
  <div class="flex flex-wrap gap-4 text-sm">
    <button
      type="button"
      onclick={() => showAppmixerSettingsDialog = true}
      class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md hover:bg-muted/80 transition-colors cursor-pointer"
    >
      <span class="text-muted-foreground">Appmixer:</span>
      {#if data.appmixerInfo?.baseUrl}
        <span class="text-blue-600">{data.appmixerInfo.baseUrl}</span>
        {#if data.appmixerInfo.username}
          <span class="text-muted-foreground">({data.appmixerInfo.username})</span>
        {/if}
      {:else}
        <span class="text-muted-foreground">Not configured</span>
      {/if}
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    </button>
    {#if data.githubInfo}
      <button
        type="button"
        onclick={() => showGitHubSettingsDialog = true}
        class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md hover:bg-muted/80 transition-colors cursor-pointer"
      >
        <span class="text-muted-foreground">GitHub:</span>
        <span class="text-blue-600">
          {data.githubInfo.owner}/{data.githubInfo.repo}
        </span>
        <Badge variant="outline">{data.githubInfo.branch}</Badge>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
      </button>
    {/if}
  </div>

  {#if data.error}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700">{data.error}</p>
    </div>
  {:else}
    <!-- Stats -->
    <div class="flex flex-col lg:flex-row gap-4">
      <!-- Flow Status -->
      <div class="space-y-2">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Flow Status</h3>
        <div class="grid grid-cols-3 gap-3">
          <button
            type="button"
            onclick={() => { syncFilter = ''; runningFilter = ''; }}
            class="border rounded-lg p-4 text-left hover:bg-muted/50 transition-colors cursor-pointer {syncFilter === '' && runningFilter === '' ? 'ring-2 ring-primary' : ''}"
          >
            <div class="text-2xl font-bold">{stats.total}</div>
            <div class="text-sm text-muted-foreground">Total</div>
          </button>
          <button
            type="button"
            onclick={() => runningFilter = runningFilter === 'running' ? '' : 'running'}
            class="border rounded-lg p-4 bg-emerald-50 text-left hover:bg-emerald-100 transition-colors cursor-pointer {runningFilter === 'running' ? 'ring-2 ring-emerald-500' : ''}"
          >
            <div class="text-2xl font-bold text-emerald-700">{stats.running}</div>
            <div class="text-sm font-medium text-emerald-600">Running</div>
          </button>
          <button
            type="button"
            onclick={() => runningFilter = runningFilter === 'stopped' ? '' : 'stopped'}
            class="border rounded-lg p-4 bg-gray-50 text-left hover:bg-gray-100 transition-colors cursor-pointer {runningFilter === 'stopped' ? 'ring-2 ring-gray-400' : ''}"
          >
            <div class="text-2xl font-bold text-gray-700">{stats.stopped}</div>
            <div class="text-sm font-medium text-gray-600">Stopped</div>
          </button>
        </div>
      </div>

      <!-- Divider -->
      <div class="hidden lg:block w-px bg-border self-stretch"></div>
      <div class="lg:hidden h-px bg-border"></div>

      <!-- GitHub Sync -->
      <div class="space-y-2 flex-1">
        <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">GitHub Sync</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'match' ? '' : 'match'}
            class="border rounded-lg p-4 bg-green-50 text-left hover:bg-green-100 transition-colors cursor-pointer {syncFilter === 'match' ? 'ring-2 ring-green-500' : ''}"
          >
            {#if syncStatusLoading}
              <div class="text-2xl font-bold text-green-700/50">...</div>
            {:else}
              <div class="text-2xl font-bold text-green-700">{stats.match}</div>
            {/if}
            <div class="text-sm font-medium text-green-600">In Sync</div>
          </button>
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'modified' ? '' : 'modified'}
            class="border rounded-lg p-4 bg-yellow-50 text-left hover:bg-yellow-100 transition-colors cursor-pointer {syncFilter === 'modified' ? 'ring-2 ring-yellow-500' : ''}"
          >
            {#if syncStatusLoading}
              <div class="text-2xl font-bold text-yellow-700/50">...</div>
            {:else}
              <div class="text-2xl font-bold text-yellow-700">{stats.modified}</div>
            {/if}
            <div class="text-sm font-medium text-yellow-600">Modified</div>
          </button>
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'server_only' ? '' : 'server_only'}
            class="border rounded-lg p-4 bg-blue-50 text-left hover:bg-blue-100 transition-colors cursor-pointer {syncFilter === 'server_only' ? 'ring-2 ring-blue-500' : ''}"
          >
            {#if syncStatusLoading}
              <div class="text-2xl font-bold text-blue-700/50">...</div>
            {:else}
              <div class="text-2xl font-bold text-blue-700">{stats.serverOnly}</div>
            {/if}
            <div class="text-sm font-medium text-blue-600">Server Only</div>
          </button>
          <button
            type="button"
            onclick={() => syncFilter = syncFilter === 'error' ? '' : 'error'}
            class="border rounded-lg p-4 bg-red-50 text-left hover:bg-red-100 transition-colors cursor-pointer {syncFilter === 'error' ? 'ring-2 ring-red-500' : ''}"
          >
            {#if syncStatusLoading}
              <div class="text-2xl font-bold text-red-700/50">...</div>
            {:else}
              <div class="text-2xl font-bold text-red-700">{stats.error}</div>
            {/if}
            <div class="text-sm font-medium text-red-600">Errors</div>
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
        bind:value={runningFilter}
        class="px-3 py-2 border rounded-md bg-background text-sm"
      >
        <option value="">All Statuses</option>
        <option value="running">Running</option>
        <option value="stopped">Stopped</option>
      </select>
      <select
        bind:value={syncFilter}
        class="px-3 py-2 border rounded-md bg-background text-sm"
      >
        <option value="">All Sync Status</option>
        <option value="match">In Sync</option>
        <option value="modified">Modified</option>
        <option value="server_only">Server Only</option>
        <option value="error">Error</option>
      </select>
      {#if searchQuery || connectorFilter || syncFilter || runningFilter}
        <Button
          variant="ghost"
          size="sm"
          onclick={() => { searchQuery = ''; connectorFilter = ''; syncFilter = ''; runningFilter = ''; }}
        >
          Clear filters
        </Button>
      {/if}
    </div>

    <!-- Results count -->
    <p class="text-sm text-muted-foreground">
      Showing {Math.min((currentPage - 1) * PAGE_SIZE + 1, filteredFlows.length)}–{Math.min(currentPage * PAGE_SIZE, filteredFlows.length)} of {filteredFlows.length} flows
      {#if filteredFlows.length !== flows.length}
        <span class="text-muted-foreground/60">(filtered from {flows.length})</span>
      {/if}
      {#if syncStatusLoading}
        <span class="ml-2 text-muted-foreground/60">— Loading sync statuses...</span>
      {/if}
    </p>

    <!-- Flows Table -->
    {#if filteredFlows.length === 0}
      <div class="text-center py-12 border rounded-lg bg-muted/50">
        <p class="text-muted-foreground">No E2E flows found</p>
      </div>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-12">
              {#if selectableFlows.length > 0}
                <Checkbox
                  checked={allSelectableSelected}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all syncable flows"
                />
              {/if}
            </TableHead>
            <TableHead>Connector</TableHead>
            <TableHead>Flow Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sync Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each paginatedFlows as flow (flow.flowId)}
            {@const selectable = isSelectable(flow)}
            <TableRow class={selectedFlowIds.has(flow.flowId) ? 'bg-muted/50' : ''}>
              <TableCell>
                {#if selectable}
                  <Checkbox
                    checked={selectedFlowIds.has(flow.flowId)}
                    onCheckedChange={() => toggleFlowSelection(flow.flowId)}
                    aria-label="Select {flow.name}"
                  />
                {/if}
              </TableCell>
              <TableCell>
                {#if flow.connector}
                  <Badge variant="outline">{flow.connector}</Badge>
                {:else}
                  <span class="text-muted-foreground text-sm">Unknown</span>
                {/if}
              </TableCell>
              <TableCell>
                <span class="font-medium">{flow.name}</span>
              </TableCell>
              <TableCell>
                {#if flow.running}
                  <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-emerald-100 text-emerald-800 border-emerald-200">
                    Running
                  </span>
                {:else}
                  <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-gray-100 text-gray-600 border-gray-200">
                    Stopped
                  </span>
                {/if}
              </TableCell>
              <TableCell>
                {#if flow.syncStatus === null}
                  <div class="inline-flex items-center px-2.5 py-0.5 rounded-full h-5 min-w-20 bg-gradient-to-r from-muted via-muted/50 to-muted animate-pulse">
                  </div>
                {:else}
                  {@const config = syncStatusConfig[flow.syncStatus] || syncStatusConfig.error}
                  <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border {config.class}">
                    {config.label}
                  </span>
                {/if}
              </TableCell>
              <TableCell>
                <div class="flex items-center gap-1">
                  <a
                    href={flow.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center justify-center rounded-md p-1.5 text-blue-600 hover:bg-blue-50 transition-colors"
                    title="Open in Designer"
                  >
                    <ExternalLink size={15} />
                  </a>
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
                  {:else if flow.syncStatus === null}
                    <div class="inline-flex items-center justify-center rounded-md p-1.5 w-6 h-6 bg-gradient-to-r from-muted via-muted/50 to-muted animate-pulse">
                    </div>
                  {/if}
                  {#if flow.syncStatus === 'modified'}
                    <button
                      type="button"
                      onclick={() => openDiff(flow)}
                      class="inline-flex items-center justify-center rounded-md p-1.5 text-yellow-600 hover:bg-yellow-50 transition-colors"
                      title="View changes"
                    >
                      <FileDiff size={15} />
                    </button>
                  {:else if flow.syncStatus === null}
                    <div class="inline-flex items-center justify-center rounded-md p-1.5 w-6 h-6 bg-gradient-to-r from-muted via-muted/50 to-muted animate-pulse">
                    </div>
                  {/if}
                  <button
                    type="button"
                    onclick={() => openResults(flow)}
                    class="inline-flex items-center justify-center rounded-md p-1.5 text-gray-600 hover:bg-gray-100 transition-colors"
                    title="View E2E results"
                  >
                    <FileText size={15} />
                  </button>
                  <button
                    type="button"
                    onclick={() => toggleFlow(flow)}
                    disabled={togglingFlowIds.has(flow.flowId)}
                    class="inline-flex items-center justify-center rounded-md p-1.5 transition-colors {flow.running ? 'text-amber-600 hover:bg-amber-50' : 'text-emerald-600 hover:bg-emerald-50'} disabled:opacity-50 disabled:pointer-events-none"
                    title={flow.running ? 'Stop flow' : 'Start flow'}
                  >
                    {#if togglingFlowIds.has(flow.flowId)}
                      <svg class="animate-spin h-[15px] w-[15px]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    {:else if flow.running}
                      <Square size={15} />
                    {:else}
                      <Play size={15} />
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
                </div>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}

    <!-- Pagination -->
    {#if totalPages > 1}
      <div class="flex items-center justify-between">
        <p class="text-sm text-muted-foreground">
          Page {currentPage} of {totalPages}
        </p>
        <div class="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === 1}
            onclick={() => currentPage = 1}
          >
            First
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === 1}
            onclick={() => currentPage--}
          >
            Previous
          </Button>
          {#each visiblePages() as page, idx}
            {#if idx > 0 && page - visiblePages()[idx - 1] > 1}
              <span class="px-1 text-muted-foreground text-sm">...</span>
            {/if}
            <Button
              variant={page === currentPage ? 'default' : 'outline'}
              size="sm"
              onclick={() => currentPage = page}
            >
              {page}
            </Button>
          {/each}
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === totalPages}
            onclick={() => currentPage++}
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage === totalPages}
            onclick={() => currentPage = totalPages}
          >
            Last
          </Button>
        </div>
      </div>
    {/if}

    <!-- Floating Action Bar -->
    {#if selectedFlowIds.size > 0}
      <div class="fixed bottom-6 left-1/2 -translate-x-1/2 bg-background border shadow-lg rounded-lg px-4 py-3 flex items-center gap-4 z-50">
        <span class="text-sm font-medium">
          {selectedFlowIds.size} flow{selectedFlowIds.size > 1 ? 's' : ''} selected
        </span>
        <div class="h-4 w-px bg-border"></div>
        <Button variant="outline" size="sm" onclick={clearSelection}>
          Clear
        </Button>
        <Button size="sm" onclick={openSyncDialog}>
          Sync to GitHub
        </Button>
      </div>
    {/if}
  {/if}
</div>

<!-- GitHub Settings Dialog -->
<Dialog bind:open={showGitHubSettingsDialog}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>GitHub Repository Settings</DialogTitle>
      <DialogDescription>
        Configure which GitHub repository and branch to compare E2E flows with.
      </DialogDescription>
    </DialogHeader>

    <div class="py-4 space-y-4">
      <div class="space-y-2">
        <label for="owner" class="text-sm font-medium">Owner</label>
        <Input
          id="owner"
          placeholder="e.g., clientIO"
          bind:value={settingsOwner}
          disabled={isSavingGitHubSettings}
        />
      </div>

      <div class="space-y-2">
        <label for="repo" class="text-sm font-medium">Repository</label>
        <Input
          id="repo"
          placeholder="e.g., appmixer-connectors"
          bind:value={settingsRepo}
          disabled={isSavingGitHubSettings}
        />
      </div>

      <div class="space-y-2">
        <label for="branch" class="text-sm font-medium">Branch</label>
        <Input
          id="branch"
          placeholder="e.g., dev"
          bind:value={settingsBranch}
          disabled={isSavingGitHubSettings}
        />
      </div>

      <div class="space-y-2">
        <label for="token" class="text-sm font-medium">
          Personal Access Token
          <span class="text-muted-foreground font-normal ml-1">(optional)</span>
        </label>
        <Input
          id="token"
          type="password"
          placeholder={data.githubInfo?.hasCustomToken ? '••••••••••••••••' : (data.githubInfo?.hasEnvToken ? 'Using token from environment' : 'Enter token for private repos')}
          bind:value={settingsToken}
          disabled={isSavingGitHubSettings || clearCustomToken}
        />
        <p class="text-xs text-muted-foreground">
          {#if data.githubInfo?.hasCustomToken}
            Custom token is set.
            <button
              type="button"
              class="text-blue-600 hover:underline"
              onclick={() => clearCustomToken = !clearCustomToken}
            >
              {clearCustomToken ? 'Keep custom token' : 'Clear and use env token'}
            </button>
          {:else if data.githubInfo?.hasEnvToken}
            Using token from GITHUB_TOKEN environment variable. Enter a new token to override.
          {:else}
            No token configured. Create one at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">github.com/settings/tokens</a>
          {/if}
        </p>
        {#if clearCustomToken}
          <p class="text-xs text-amber-600">Custom token will be cleared on save.</p>
        {/if}
      </div>

      {#if gitHubSettingsError}
        <p class="text-sm text-destructive">{gitHubSettingsError}</p>
      {/if}
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => showGitHubSettingsDialog = false} disabled={isSavingGitHubSettings}>
        Cancel
      </Button>
      <Button onclick={saveGitHubSettings} disabled={isSavingGitHubSettings}>
        {isSavingGitHubSettings ? 'Saving...' : 'Save'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Appmixer Settings Dialog -->
<Dialog bind:open={showAppmixerSettingsDialog}>
  <DialogContent class="max-w-2xl">
    <DialogHeader>
      <DialogTitle>Appmixer Instance Settings</DialogTitle>
      <DialogDescription>
        Configure the Appmixer instance to fetch E2E test flows from.
      </DialogDescription>
    </DialogHeader>

    <div class="py-4 space-y-4">
      <div class="space-y-2">
        <label for="appmixer-url" class="text-sm font-medium">Base URL</label>
        <div class="flex flex-wrap gap-2 mb-2">
          <button
            type="button"
            class="px-3 py-1 text-xs rounded-full border transition-colors {appmixerBaseUrl === 'https://api-dev-automated-00001.dev.appmixer.ai' ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted hover:bg-muted/80 border-border'}"
            onclick={() => appmixerBaseUrl = 'https://api-dev-automated-00001.dev.appmixer.ai'}
            disabled={isSavingAppmixerSettings || clearAppmixerCredentials}
          >
            QA
          </button>
          <button
            type="button"
            class="px-3 py-1 text-xs rounded-full border transition-colors {appmixerBaseUrl === 'https://api.clientio.appmixer.cloud' ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted hover:bg-muted/80 border-border'}"
            onclick={() => appmixerBaseUrl = 'https://api.clientio.appmixer.cloud'}
            disabled={isSavingAppmixerSettings || clearAppmixerCredentials}
          >
            ClientIO Cloud
          </button>
        </div>
        <Input
          id="appmixer-url"
          placeholder="Or enter custom URL..."
          bind:value={appmixerBaseUrl}
          disabled={isSavingAppmixerSettings || clearAppmixerCredentials}
        />
      </div>

      <div class="space-y-2">
        <label for="appmixer-username" class="text-sm font-medium">Username</label>
        <Input
          id="appmixer-username"
          placeholder="e.g., user@example.com"
          bind:value={appmixerUsername}
          disabled={isSavingAppmixerSettings || clearAppmixerCredentials}
        />
      </div>

      <div class="space-y-2">
        <label for="appmixer-password" class="text-sm font-medium">
          Password
          <span class="text-muted-foreground font-normal ml-1">(leave empty to keep current)</span>
        </label>
        <Input
          id="appmixer-password"
          type="password"
          placeholder={data.appmixerInfo?.hasCustomCredentials ? '••••••••••••••••' : (data.appmixerInfo?.hasEnvCredentials ? 'Using password from environment' : 'Enter password')}
          bind:value={appmixerPassword}
          disabled={isSavingAppmixerSettings || clearAppmixerCredentials}
        />
        <p class="text-xs text-muted-foreground">
          {#if data.appmixerInfo?.hasCustomCredentials}
            Custom credentials are set.
            <button
              type="button"
              class="text-blue-600 hover:underline"
              onclick={() => clearAppmixerCredentials = !clearAppmixerCredentials}
            >
              {clearAppmixerCredentials ? 'Keep custom credentials' : 'Clear and use env credentials'}
            </button>
          {:else if data.appmixerInfo?.hasEnvCredentials}
            Using credentials from environment variables. Enter new values to override.
          {:else}
            No credentials configured. Set APPMIXER_BASE_URL, APPMIXER_USERNAME, and APPMIXER_PASSWORD environment variables or enter them here.
          {/if}
        </p>
        {#if clearAppmixerCredentials}
          <p class="text-xs text-amber-600">Custom credentials will be cleared on save.</p>
        {/if}
      </div>

      {#if appmixerSettingsError}
        <p class="text-sm text-destructive">{appmixerSettingsError}</p>
      {/if}
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => showAppmixerSettingsDialog = false} disabled={isSavingAppmixerSettings}>
        Cancel
      </Button>
      <Button onclick={saveAppmixerSettings} disabled={isSavingAppmixerSettings}>
        {isSavingAppmixerSettings ? 'Saving...' : 'Save'}
      </Button>
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
      <!-- Success state -->
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
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
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
      <!-- Form state -->
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
          <p class="text-sm font-medium">Flows to sync ({selectedFlows.length})</p>
          <div class="max-h-48 overflow-y-auto border rounded-lg">
            <table class="w-full text-sm">
              <thead class="bg-muted/50 sticky top-0">
                <tr>
                  <th class="text-left px-3 py-2 font-medium">Flow</th>
                  <th class="text-left px-3 py-2 font-medium">Path</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                {#each selectedFlows as flow}
                  <tr>
                    <td class="px-3 py-2">
                      <span class="font-medium">{flow.name}</span>
                      <Badge variant="outline" class="ml-2 text-xs">{flow.syncStatus === 'modified' ? 'Modified' : 'New'}</Badge>
                    </td>
                    <td class="px-3 py-2 text-muted-foreground font-mono text-xs">
                      {flow.githubPath || generateFlowPath(flow.connector, flow.name)}
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
          <p class="font-medium">{flowToDelete.name}</p>
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
          Comparing <span class="font-medium">{diffFlow.name}</span> — instance vs GitHub
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
    {/if}

    <DialogFooter>
      <Button variant="outline" onclick={() => showDiffDialog = false}>Close</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- E2E Results Dialog -->
<Dialog bind:open={showResultsDialog}>
  <DialogContent class="max-w-6xl max-h-[85vh] flex flex-col">
    <DialogHeader>
      <DialogTitle>E2E Test Run Details</DialogTitle>
      <DialogDescription>
        {#if resultsFlow}
          Latest run for <span class="font-medium">{resultsFlow.name}</span>
        {/if}
      </DialogDescription>
    </DialogHeader>

    {#if isResultsLoading}
      <div class="flex items-center justify-center py-12">
        <svg class="animate-spin h-6 w-6 text-muted-foreground" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span class="ml-2 text-sm text-muted-foreground">Loading E2E results...</span>
      </div>
    {:else if resultsError}
      <div class="bg-red-50 border border-red-200 rounded-lg p-4">
        <p class="text-red-700 text-sm">{resultsError}</p>
      </div>
    {:else if resultsData}
      <div class="space-y-6 overflow-auto flex-1 pr-1">
        <div class="border rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <tbody class="divide-y">
              <tr>
                <td class="w-44 font-medium bg-muted/30 px-3 py-2">Name</td>
                <td class="px-3 py-2">{resultsData.name}</td>
              </tr>
              <tr>
                <td class="font-medium bg-muted/30 px-3 py-2">URL</td>
                <td class="px-3 py-2">
                  {#if resultsFlow?.url}
                    <a href={resultsFlow.url} target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline break-all">{resultsFlow.url}</a>
                  {:else}
                    <span class="text-muted-foreground">N/A</span>
                  {/if}
                </td>
              </tr>
              <tr>
                <td class="font-medium bg-muted/30 px-3 py-2">Status</td>
                <td class="px-3 py-2">{resultsData.status}</td>
              </tr>
              <tr>
                <td class="font-medium bg-muted/30 px-3 py-2">Failed asserts</td>
                <td class="px-3 py-2">{resultsData.failedAsserts}</td>
              </tr>
              <tr>
                <td class="font-medium bg-muted/30 px-3 py-2">Total asserts</td>
                <td class="px-3 py-2">{resultsData.totalAsserts}</td>
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
                <th class="text-left px-3 py-2 font-medium w-20">Asserts</th>
                <th class="text-left px-3 py-2 font-medium">Errors</th>
                <th class="text-left px-3 py-2 font-medium">ComponentId</th>
              </tr>
            </thead>
            <tbody class="divide-y">
              {#if resultsData.details?.length > 0}
                {#each resultsData.details as detail}
                  <tr>
                    <td class="px-3 py-2">{detail.componentName}</td>
                    <td class="px-3 py-2 text-lg leading-none">{detail.status === 'failed' ? '❌' : '✅'}</td>
                    <td class="px-3 py-2">{detail.asserts}</td>
                    <td class="px-3 py-2">
                      {#if detail.errors?.length > 0}
                        <div class="space-y-1">
                          {#each detail.errors as item}
                            <div class="text-red-700">{item}</div>
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
                  <td colspan="5" class="px-3 py-6 text-center text-muted-foreground">No component-level details found</td>
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
