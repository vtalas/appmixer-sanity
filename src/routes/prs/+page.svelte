<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import {
    ExternalLink,
    Github,
    RefreshCw,
    GitPullRequest,
    CircleDot,
    ChevronRight
  } from 'lucide-svelte';

  let { data } = $props();

  // Initialize filters from URL params
  const params = $page.url.searchParams;
  let searchQuery = $state(params.get('q') || '');
  let connectorFilter = $state(params.get('connector') || '');
  let onlyWithFlows = $state(params.get('flows') === '1');
  let accountFilter = $state(params.get('account') || '');
  // Drafts are hidden by default
  let includeDrafts = $state(params.get('drafts') === '1');
  let readyOnly = $state(params.get('ready') === '1');
  let testingOnly = $state(params.get('testing') === '1');

  // Sync filter state to URL
  let initialized = false;
  $effect(() => {
    const q = searchQuery;
    const connector = connectorFilter;
    const flows = onlyWithFlows;
    const account = accountFilter;
    const drafts = includeDrafts;
    const ready = readyOnly;
    const testing = testingOnly;

    if (!initialized) {
      initialized = true;
      return;
    }

    const url = new URL($page.url);
    const sp = url.searchParams;
    q ? sp.set('q', q) : sp.delete('q');
    connector ? sp.set('connector', connector) : sp.delete('connector');
    flows ? sp.set('flows', '1') : sp.delete('flows');
    account ? sp.set('account', account) : sp.delete('account');
    drafts ? sp.set('drafts', '1') : sp.delete('drafts');
    ready ? sp.set('ready', '1') : sp.delete('ready');
    testing ? sp.set('testing', '1') : sp.delete('testing');

    goto(url.pathname + (sp.toString() ? '?' + sp.toString() : ''), {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  });

  const prs = $derived(data.prs || []);

  /** A touched connector has no service account on the instance yet */
  const prNeedsAccount = (pr) => pr.connectors.some((c) => c.accountAvailable === false);

  const needsAccountOnly = $derived(accountFilter === 'missing');

  const stats = $derived({
    total: prs.length,
    withFlows: prs.filter((pr) => pr.testFlowCount > 0).length,
    drafts: prs.filter((pr) => pr.draft).length,
    ready: prs.filter((pr) => pr.readyToMerge).length,
    // Drafts are hidden by default — count only what clicking the tile shows
    readyForTesting: prs.filter((pr) => pr.readyForTesting && (includeDrafts || !pr.draft)).length,
    needsAccount: prs.filter((pr) => prNeedsAccount(pr) && (includeDrafts || !pr.draft)).length
  });

  const allConnectors = $derived(
    [...new Set(prs.flatMap((pr) => pr.connectors.map((c) => c.name)))].sort()
  );

  const filteredPRs = $derived(
    prs.filter((pr) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch =
        !q ||
        pr.title?.toLowerCase().includes(q) ||
        String(pr.number).includes(q) ||
        pr.author?.toLowerCase().includes(q) ||
        pr.connectors.some((c) => c.name.toLowerCase().includes(q));

      const matchesConnector =
        !connectorFilter || pr.connectors.some((c) => c.name === connectorFilter);

      const matchesFlows = !onlyWithFlows || pr.testFlowCount > 0;

      const matchesAccount =
        !accountFilter ||
        (accountFilter === 'available' && pr.connectors.some((c) => c.accountAvailable === true)) ||
        (accountFilter === 'missing' && prNeedsAccount(pr));

      const matchesDraft = includeDrafts || !pr.draft;

      const matchesReady = !readyOnly || pr.readyToMerge;

      const matchesTesting = !testingOnly || pr.readyForTesting;

      return (
        matchesSearch &&
        matchesConnector &&
        matchesFlows &&
        matchesAccount &&
        matchesDraft &&
        matchesReady &&
        matchesTesting
      );
    })
  );

  // --- Scan ---
  let isScanning = $state(false);
  let scanError = $state('');
  let scanSummary = $state(null);

  async function runScan() {
    isScanning = true;
    scanError = '';
    scanSummary = null;
    try {
      const response = await fetch('/api/prs/scan', { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Scan failed (${response.status})`);
      }
      scanSummary = await response.json();
      await invalidateAll();
    } catch (e) {
      scanError = e.message;
    } finally {
      isScanning = false;
    }
  }

  // --- Per-PR refresh ---
  // A single PR costs a handful of GitHub calls instead of a few hundred, so a
  // card can be brought up to date without rescanning every other PR.
  let refreshingPRs = $state({});
  let refreshErrors = $state({});

  async function refreshPR(number) {
    refreshingPRs[number] = true;
    delete refreshErrors[number];
    try {
      const response = await fetch(`/api/prs/${number}/scan`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Refresh failed (${response.status})`);
      }
      const result = await response.json();
      if (result.errors?.length) {
        refreshErrors[number] = result.errors.join('; ');
      }
      // Reloads the page data from the caches only — no GitHub calls
      await invalidateAll();
    } catch (e) {
      refreshErrors[number] = e.message;
    } finally {
      delete refreshingPRs[number];
    }
  }

  // Flow listings are collapsed by default, expanded per (PR, connector)
  let expandedGroups = $state({});

  const checklistStatusConfig = {
    pass: { glyph: '✓', class: 'bg-green-50 text-green-700 border-green-200' },
    fail: { glyph: '✗', class: 'bg-red-50 text-red-700 border-red-200' },
    warn: { glyph: '!', class: 'bg-amber-50 text-amber-800 border-amber-200' }
  };

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

  function designerUrl(flow) {
    return flow.flowId && data.designerBaseUrl
      ? `${data.designerBaseUrl}/designer/${flow.flowId}`
      : null;
  }
</script>

<svelte:head>
  <title>Connector PRs - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-3xl font-bold">Connector PRs</h1>
      <p class="text-muted-foreground">
        Open pull requests of {data.repo}, with the E2E flow state of every touched connector
      </p>
    </div>
    <Button variant="outline" onclick={runScan} disabled={isScanning}>
      <RefreshCw size={15} class="mr-2 {isScanning ? 'animate-spin' : ''}" />
      {isScanning ? 'Scanning...' : 'Scan PRs'}
    </Button>
  </div>

  <!-- Source Info -->
  <div class="flex flex-wrap gap-4 text-sm">
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
  </div>

  {#if scanError}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700 text-sm">Scan failed: {scanError}</p>
    </div>
  {/if}
  {#if scanSummary && !scanSummary.errors?.length}
    <div class="bg-green-50 border border-green-200 rounded-lg px-4 py-2.5 flex items-center justify-between">
      <p class="text-sm text-green-800">
        Scan complete: {scanSummary.total} open PR{scanSummary.total !== 1 ? 's' : ''} ({scanSummary.withTestFlows} with test flows)
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

  <!-- Stats -->
  <div class="grid grid-cols-6 gap-3 max-w-5xl">
    <div class="border rounded-lg p-3">
      <div class="text-2xl font-bold">{stats.total}</div>
      <div class="text-xs text-muted-foreground">Open PRs</div>
    </div>
    <button
      type="button"
      onclick={() => (accountFilter = needsAccountOnly ? '' : 'missing')}
      class="border rounded-lg p-3 bg-orange-50 text-left hover:bg-orange-100 transition-colors cursor-pointer {needsAccountOnly ? 'ring-2 ring-orange-500' : ''}"
      title={needsAccountOnly
        ? 'Showing only PRs missing a service account — click to show all'
        : 'Click to show only PRs where a touched connector has no service account on the instance'}
    >
      <div class="text-2xl font-bold text-orange-700">{stats.needsAccount}</div>
      <div class="text-xs font-medium text-orange-600">Needs Account</div>
    </button>
    <button
      type="button"
      onclick={() => (testingOnly = !testingOnly)}
      class="border rounded-lg p-3 bg-blue-50 text-left hover:bg-blue-100 transition-colors cursor-pointer {testingOnly ? 'ring-2 ring-blue-500' : ''}"
      title={testingOnly
        ? 'Showing only PRs ready for testing — click to show all'
        : 'Click to show only PRs with a service account for every touched connector and green CI checks'}
    >
      <div class="text-2xl font-bold text-blue-700">{stats.readyForTesting}</div>
      <div class="text-xs font-medium text-blue-600">Ready for Testing</div>
    </button>
    <button
      type="button"
      onclick={() => (readyOnly = !readyOnly)}
      class="border rounded-lg p-3 bg-green-50 text-left hover:bg-green-100 transition-colors cursor-pointer {readyOnly ? 'ring-2 ring-green-500' : ''}"
      title={readyOnly ? 'Showing only mergeable PRs — click to show all' : 'Click to show only PRs whose merge checklist is fully green'}
    >
      <div class="text-2xl font-bold text-green-700">{stats.ready}</div>
      <div class="text-xs font-medium text-green-600">Ready to Merge</div>
    </button>
    <button
      type="button"
      onclick={() => (onlyWithFlows = !onlyWithFlows)}
      class="border rounded-lg p-3 bg-purple-50 text-left hover:bg-purple-100 transition-colors cursor-pointer {onlyWithFlows ? 'ring-2 ring-purple-500' : ''}"
    >
      <div class="text-2xl font-bold text-purple-700">{stats.withFlows}</div>
      <div class="text-xs font-medium text-purple-600">With Test Flows</div>
    </button>
    <button
      type="button"
      onclick={() => (includeDrafts = !includeDrafts)}
      class="border rounded-lg p-3 text-left hover:bg-muted/50 transition-colors cursor-pointer {includeDrafts ? 'ring-2 ring-gray-400' : ''}"
      title={includeDrafts ? 'Drafts are shown — click to hide them' : 'Drafts are hidden — click to show them'}
    >
      <div class="text-2xl font-bold text-muted-foreground">{stats.drafts}</div>
      <div class="text-xs text-muted-foreground">Drafts {includeDrafts ? '(shown)' : '(hidden)'}</div>
    </button>
  </div>

  <!-- Filters -->
  <div class="flex flex-wrap gap-3">
    <div class="flex-1 min-w-64">
      <Input placeholder="Search by title, number, author or connector..." bind:value={searchQuery} />
    </div>
    <select
      bind:value={connectorFilter}
      class="h-10 rounded-md border border-input bg-background px-3 text-sm"
    >
      <option value="">All connectors</option>
      {#each allConnectors as connector}
        <option value={connector}>{connector}</option>
      {/each}
    </select>
    <select
      bind:value={accountFilter}
      class="h-10 rounded-md border border-input bg-background px-3 text-sm"
    >
      <option value="">Any account state</option>
      <option value="available">Account available</option>
      <option value="missing">No account</option>
    </select>
  </div>

  <!-- Results count -->
  <p class="text-sm text-muted-foreground">
    {filteredPRs.length} PR{filteredPRs.length !== 1 ? 's' : ''}
    {#if filteredPRs.length !== prs.length}
      <span class="text-muted-foreground/60">(filtered from {prs.length})</span>
    {/if}
  </p>

  <!-- PR list -->
  {#if prs.length === 0}
    <div class="text-center py-12 border rounded-lg bg-muted/50">
      <p class="text-muted-foreground">No PRs cached yet.</p>
      <Button class="mt-4" onclick={runScan} disabled={isScanning}>
        <RefreshCw size={15} class="mr-2 {isScanning ? 'animate-spin' : ''}" />
        {isScanning ? 'Scanning...' : 'Run First Scan'}
      </Button>
    </div>
  {:else if filteredPRs.length === 0}
    <div class="text-center py-12 border rounded-lg bg-muted/50">
      <p class="text-muted-foreground">No PRs match the current filters</p>
    </div>
  {:else}
    <div class="space-y-4">
      {#each filteredPRs as pr (pr.number)}
        <div class="border rounded-lg overflow-hidden">
          <!-- PR header -->
          <div class="px-4 py-3 bg-muted/40 border-b space-y-1.5">
            <div class="flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <GitPullRequest size={16} class="shrink-0 {pr.draft ? 'text-gray-400' : 'text-green-600'}" />
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-semibold hover:underline truncate"
                  title={pr.title}
                >
                  #{pr.number} {pr.title}
                </a>
                {#if pr.draft}
                  <Badge variant="outline" class="text-xs shrink-0">Draft</Badge>
                {/if}
                {#if pr.readyToMerge}
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border bg-green-100 text-green-800 border-green-300 shrink-0">
                    ✓ Ready to merge
                  </span>
                {:else if pr.readyForTesting}
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border bg-blue-100 text-blue-800 border-blue-300 shrink-0"
                    title="Service account available for every touched connector and CI checks are green — the E2E suite can be run"
                  >
                    ✓ Ready for testing
                  </span>
                {/if}
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-xs text-muted-foreground" title={pr.updatedAt}>
                  updated {formatRelativeTime(pr.updatedAt)}
                </span>
                <button
                  type="button"
                  onclick={() => refreshPR(pr.number)}
                  disabled={!!refreshingPRs[pr.number]}
                  class="p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors cursor-pointer"
                  title={pr.scannedAt
                    ? `Refresh this PR (last scanned ${formatRelativeTime(pr.scannedAt)})`
                    : 'Refresh this PR'}
                  aria-label="Refresh PR #{pr.number}"
                >
                  <RefreshCw size={13} class={refreshingPRs[pr.number] ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {#if pr.author}
                <span>by {pr.author}</span>
              {/if}
              <span class="font-mono">{pr.headBranch} → {pr.baseBranch}</span>
              {#if pr.filesCount != null}
                <span>{pr.filesCount} file{pr.filesCount !== 1 ? 's' : ''}</span>
              {/if}
              {#if pr.testFlowCount > 0}
                <span class="inline-flex items-center px-2 py-0.5 rounded-full font-medium border bg-purple-50 text-purple-700 border-purple-200">
                  {pr.testFlowCount} test flow{pr.testFlowCount !== 1 ? 's' : ''} in PR
                </span>
              {/if}
              {#each pr.linkedIssues || [] as issue (issue.url)}
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 hover:underline {issue.state === 'open' ? 'text-green-700' : 'text-purple-700'}"
                  title="Linked issue ({issue.state}): {issue.title}"
                >
                  <CircleDot size={12} />
                  {issue.repo.split('/')[1]}#{issue.number}
                </a>
              {/each}
            </div>

            {#if refreshErrors[pr.number]}
              <p class="text-xs text-red-600">Refresh: {refreshErrors[pr.number]}</p>
            {/if}

            <!-- Merge checklist -->
            {#if pr.checklist?.length}
              <div class="flex flex-wrap gap-1.5 pt-0.5">
                {#each pr.checklist as item (item.key)}
                  {@const config = checklistStatusConfig[item.status] || checklistStatusConfig.warn}
                  {#if item.key === 'report' && pr.e2eReport?.url}
                    <a
                      href={pr.e2eReport.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border hover:opacity-80 {config.class}"
                      title={item.detail}
                    >
                      <span class="font-bold">{config.glyph}</span>
                      {item.label}
                    </a>
                  {:else}
                    <span
                      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border {config.class}"
                      title={item.detail}
                    >
                      <span class="font-bold">{config.glyph}</span>
                      {item.label}
                    </span>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>

          <!-- Connector groups -->
          {#if pr.connectors.length === 0}
            <p class="px-4 py-3 text-sm text-muted-foreground">
              No connector files touched by this PR.
            </p>
          {:else}
            <div class="divide-y">
              {#each pr.connectors as group (group.name)}
                {@const groupKey = `${pr.number}:${group.name}`}
                {@const isExpanded = !!expandedGroups[groupKey]}
                {@const passedCount = group.flows.filter((f) => f.lastResult === 'passed').length}
                {@const failedCount = group.flows.filter((f) => f.lastResult === 'failed').length}
                <div>
                  <button
                    type="button"
                    onclick={() => (expandedGroups[groupKey] = !isExpanded)}
                    class="w-full flex items-center gap-3 px-4 py-2 bg-muted/20 text-left hover:bg-muted/40 transition-colors cursor-pointer"
                    title={isExpanded ? 'Collapse flows' : 'Expand flows'}
                  >
                    <ChevronRight
                      size={14}
                      class="shrink-0 text-muted-foreground transition-transform {isExpanded
                        ? 'rotate-90'
                        : ''}"
                    />
                    <span class="font-medium text-sm">{group.name}</span>
                    <span class="text-xs text-muted-foreground">
                      {group.flows.length} flow{group.flows.length !== 1 ? 's' : ''}
                    </span>
                    {#if passedCount > 0}
                      <span
                        class="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800"
                        title="{passedCount} flow{passedCount !== 1 ? 's' : ''} passed"
                      >
                        {passedCount} ✓
                      </span>
                    {/if}
                    {#if failedCount > 0}
                      <span
                        class="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800"
                        title="{failedCount} flow{failedCount !== 1 ? 's' : ''} failed"
                      >
                        {failedCount} ✗
                      </span>
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
                  </button>

                  {#if !isExpanded}
                    <!-- collapsed -->
                  {:else if group.flows.length === 0}
                    <p class="px-4 py-2 text-xs text-muted-foreground">
                      No E2E flows known for this connector.
                    </p>
                  {:else}
                    <table class="w-full text-sm">
                      <tbody class="divide-y">
                        {#each group.flows as flow (flow.githubPath || flow.flowName)}
                          {@const syncConfig = syncStatusConfig[flow.syncStatus] || syncStatusConfig.error}
                          <tr class="hover:bg-muted/30">
                            <td class="px-4 py-2">
                              <span class="font-medium">{flow.flowName}</span>
                              {#if flow.changedInPR}
                                <span
                                  class="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border bg-purple-50 text-purple-700 border-purple-200"
                                  title={flow.newInPR ? 'This test flow is added by this PR' : 'This test flow is changed by this PR'}
                                >
                                  {flow.newInPR ? 'New in PR' : 'Changed in PR'}
                                </span>
                              {/if}
                              {#if flow.githubPath}
                                <div class="text-xs text-muted-foreground font-mono">{flow.githubPath}</div>
                              {/if}
                            </td>
                            <td class="px-2 py-2 w-32">
                              <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border {syncConfig.class}">
                                {syncConfig.label}
                              </span>
                            </td>
                            <td class="px-2 py-2 w-36">
                              {#if flow.lastResult === 'passed'}
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
                            </td>
                            <td class="px-4 py-2 w-24">
                              <div class="flex items-center gap-1 justify-end">
                                {#if designerUrl(flow)}
                                  <a
                                    href={designerUrl(flow)}
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
                              </div>
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
