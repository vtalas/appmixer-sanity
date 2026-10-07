<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll } from '$app/navigation';
  import {
    Package,
    Blocks,
    FlaskConical,
    RefreshCw,
    ExternalLink,
    GitCommitHorizontal,
    TriangleAlert
  } from 'lucide-svelte';

  let { data } = $props();

  let refreshing = $state(false);
  let searchQuery = $state('');
  let tab = $state('connectors');

  async function refresh() {
    refreshing = true;
    try {
      await invalidateAll();
    } finally {
      refreshing = false;
    }
  }

  const query = $derived(searchQuery.trim().toLowerCase());

  const filteredConnectors = $derived(
    query
      ? data.connectors.filter(
          (c) => c.name.toLowerCase().includes(query) || c.directory.toLowerCase().includes(query)
        )
      : data.connectors
  );

  const filteredFlows = $derived(
    query
      ? data.e2eFlows.filter(
          (f) =>
            f.connector.toLowerCase().includes(query) || f.fileName.toLowerCase().includes(query)
        )
      : data.e2eFlows
  );

  const tiles = $derived([
    {
      value: data.counts.connectors,
      label: 'Connectors',
      desc: 'bundle.json files',
      icon: Package,
      class: 'bg-blue-100 text-blue-600'
    },
    {
      value: data.counts.components,
      label: 'Components',
      desc: 'component.json files',
      icon: Blocks,
      class: 'bg-green-100 text-green-600'
    },
    {
      value: data.counts.e2eFlows,
      label: 'E2E Flows',
      desc: 'test-flow*.json files',
      icon: FlaskConical,
      class: 'bg-amber-100 text-amber-600'
    }
  ]);

  /** @param {string | null} iso */
  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
</script>

<svelte:head>
  <title>Statistics - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-3xl font-bold">Statistics</h1>
      <p class="text-sm text-muted-foreground mt-1">
        What is released — connectors, components and E2E test flows on
        {#if data.repo}
          <a
            href={data.repo.url}
            target="_blank"
            rel="noopener noreferrer"
            class="font-medium text-foreground hover:underline inline-flex items-center gap-1"
          >
            {data.repo.repo}
            <code class="text-xs">{data.repo.branch}</code>
            <ExternalLink class="h-3 w-3" />
          </a>
        {:else}
          the release branch
        {/if}
      </p>
      {#if data.repo}
        <p class="text-xs text-muted-foreground mt-1 inline-flex items-center gap-1">
          <GitCommitHorizontal class="h-3 w-3" />
          <a
            href="https://github.com/{data.repo.repo}/commit/{data.repo.commitSha}"
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono hover:underline"
          >
            {data.repo.commitSha.slice(0, 7)}
          </a>
          {#if data.repo.committedAt}
            <span>· {formatDate(data.repo.committedAt)}</span>
          {/if}
        </p>
      {/if}
    </div>
    <Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}>
      <RefreshCw class="h-4 w-4 mr-2 {refreshing ? 'animate-spin' : ''}" />
      Refresh
    </Button>
  </div>

  {#if data.error}
    <div
      class="border border-red-200 bg-red-50 text-red-800 rounded-lg p-4 text-sm flex items-start gap-2"
    >
      <TriangleAlert class="h-4 w-4 mt-0.5 shrink-0" />
      <span>{data.error}</span>
    </div>
  {/if}

  <!-- Counts -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
    {#each tiles as tile}
      <div class="border rounded-lg p-5 flex items-center gap-4 bg-card">
        <div class="h-12 w-12 rounded-xl flex items-center justify-center shrink-0 {tile.class}">
          <tile.icon class="h-6 w-6" />
        </div>
        <div class="flex flex-col">
          <span class="text-3xl font-bold leading-none">{tile.value}</span>
          <span class="text-sm font-medium mt-1">{tile.label}</span>
          <span class="text-xs text-muted-foreground">{tile.desc}</span>
        </div>
      </div>
    {/each}
  </div>

  <!-- Lists -->
  <div class="flex flex-wrap items-center gap-3">
    <div class="flex rounded-md border overflow-hidden">
      <button
        type="button"
        class="px-3 py-1.5 text-sm {tab === 'connectors'
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-muted'}"
        onclick={() => (tab = 'connectors')}
      >
        Connectors
        <span class="ml-1 text-xs opacity-70">{filteredConnectors.length}</span>
      </button>
      <button
        type="button"
        class="px-3 py-1.5 text-sm border-l {tab === 'flows'
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-muted'}"
        onclick={() => (tab = 'flows')}
      >
        E2E Test Flows
        <span class="ml-1 text-xs opacity-70">{filteredFlows.length}</span>
      </button>
    </div>
    <div class="flex-1 min-w-[16rem] max-w-md">
      <Input placeholder="Filter by connector or file name..." bind:value={searchQuery} />
    </div>
  </div>

  {#if tab === 'connectors'}
    <div class="border rounded-lg overflow-hidden">
      <div
        class="grid grid-cols-[1fr_auto_auto_auto] gap-x-6 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50 border-b"
      >
        <span>Connector</span>
        <span class="text-right">Components</span>
        <span class="text-right">E2E flows</span>
        <span class="text-right w-20">Version</span>
      </div>
      {#each filteredConnectors as connector (connector.directory)}
        <div
          class="grid grid-cols-[1fr_auto_auto_auto] gap-x-6 items-center px-3 py-2 text-sm border-b last:border-b-0 hover:bg-muted/50"
        >
          <div class="min-w-0 flex items-baseline gap-2">
            <a
              href={connector.url}
              target="_blank"
              rel="noopener noreferrer"
              class="font-semibold hover:underline truncate"
            >
              {connector.name}
            </a>
            {#if connector.name !== `appmixer.${connector.directory.replace(/\//g, '.')}`}
              <span class="text-xs text-muted-foreground font-mono truncate">
                {connector.directory}
              </span>
            {/if}
            {#if !connector.valid}
              <span
                class="text-xs text-red-700 inline-flex items-center gap-1"
                title="bundle.json does not parse"
              >
                <TriangleAlert class="h-3 w-3" /> invalid bundle.json
              </span>
            {/if}
          </div>
          <span class="text-right tabular-nums text-muted-foreground">{connector.components}</span>
          <span class="text-right tabular-nums text-muted-foreground">{connector.e2eFlows}</span>
          <span class="text-right w-20">
            <code class="text-xs bg-muted rounded-full px-2 py-0.5">
              {connector.version ?? '—'}
            </code>
          </span>
        </div>
      {:else}
        <div class="px-3 py-6 text-sm text-muted-foreground text-center">No connectors match.</div>
      {/each}
    </div>
  {:else}
    <div class="border rounded-lg overflow-hidden">
      <div
        class="grid grid-cols-[12rem_1fr] gap-x-6 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50 border-b"
      >
        <span>Connector</span>
        <span>Flow file</span>
      </div>
      {#each filteredFlows as flow (flow.path)}
        <div
          class="grid grid-cols-[12rem_1fr] gap-x-6 items-center px-3 py-2 text-sm border-b last:border-b-0 hover:bg-muted/50"
        >
          <span class="font-semibold truncate">{flow.connector}</span>
          <a
            href={flow.url}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-xs hover:underline truncate"
            title={flow.path}
          >
            {flow.fileName}
          </a>
        </div>
      {:else}
        <div class="px-3 py-6 text-sm text-muted-foreground text-center">No flows match.</div>
      {/each}
    </div>
  {/if}
</div>
