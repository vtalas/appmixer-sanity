<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll, goto } from '$app/navigation';
  import {
    Package,
    Blocks,
    FlaskConical,
    RefreshCw,
    ExternalLink,
    GitCommitHorizontal,
    TriangleAlert,
    ChevronLeft,
    ChevronRight,
    Rocket
  } from 'lucide-svelte';

  let { data } = $props();

  let refreshing = $state(false);
  let searchQuery = $state('');
  let tab = $state('releases');
  /** @type {Set<string>} release types shown; empty = all */
  let typeFilter = $state(new Set());
  let showOther = $state(false);

  async function refresh() {
    refreshing = true;
    try {
      await invalidateAll();
    } finally {
      refreshing = false;
    }
  }

  /** @param {string | null} key */
  function openMonth(key) {
    if (!key) return;
    searchQuery = '';
    typeFilter = new Set();
    goto(`/statistics?month=${key}`, { keepFocus: true });
  }

  /** @param {string} type */
  function toggleType(type) {
    const next = new Set(typeFilter);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    typeFilter = next;
  }

  // The last 24 months for the picker, newest first
  const monthOptions = $derived.by(() => {
    const options = [];
    const now = new Date();
    for (let i = 0; i < 24; i++) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      options.push({ key, label: monthLabel(key) });
    }
    if (!options.some((o) => o.key === data.month.key)) {
      options.push({ key: data.month.key, label: monthLabel(data.month.key) });
    }
    return options;
  });

  /** @param {string} key - "YYYY-MM" */
  function monthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }

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

  /** @param {string | null} iso */
  function formatDay(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  }

  const query = $derived(searchQuery.trim().toLowerCase());

  /** @type {Record<string, {label: string, class: string, ring: string}>} */
  const TYPE = {
    new: {
      label: 'New',
      class: 'bg-blue-100 text-blue-800 border-blue-200',
      ring: 'ring-blue-500'
    },
    major: {
      label: 'Major',
      class: 'bg-red-100 text-red-800 border-red-200',
      ring: 'ring-red-500'
    },
    minor: {
      label: 'Minor',
      class: 'bg-amber-100 text-amber-800 border-amber-200',
      ring: 'ring-amber-500'
    },
    patch: {
      label: 'Patch',
      class: 'bg-green-100 text-green-800 border-green-200',
      ring: 'ring-green-500'
    }
  };
  const TYPES = Object.keys(TYPE);

  const filteredReleases = $derived(
    data.releases.filter(
      (r) =>
        (typeFilter.size === 0 || typeFilter.has(r.type)) &&
        (!query || r.connector.toLowerCase().includes(query) || r.version.includes(query))
    )
  );

  const filteredOther = $derived(
    query ? data.other.filter((c) => c.message.toLowerCase().includes(query)) : data.other
  );

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

  /** @param {number} value */
  function delta(value) {
    if (value > 0) return { text: `+${value}`, class: 'text-green-700' };
    if (value < 0) return { text: `${value}`, class: 'text-red-700' };
    return { text: '±0', class: 'text-muted-foreground' };
  }

  /** @type {{key: 'connectors' | 'components' | 'e2eFlows', label: string, desc: string, icon: any, class: string}[]} */
  const TILES = [
    {
      key: 'connectors',
      label: 'Connectors',
      desc: 'bundle.json files',
      icon: Package,
      class: 'bg-blue-100 text-blue-600'
    },
    {
      key: 'components',
      label: 'Components',
      desc: 'component.json files',
      icon: Blocks,
      class: 'bg-green-100 text-green-600'
    },
    {
      key: 'e2eFlows',
      label: 'E2E Flows',
      desc: 'test-flow*.json files',
      icon: FlaskConical,
      class: 'bg-amber-100 text-amber-600'
    }
  ];

  const tiles = $derived(
    TILES.map((tile) => ({
      ...tile,
      value: data.counts[tile.key],
      delta:
        data.previous?.counts != null
          ? delta(data.counts[tile.key] - data.previous.counts[tile.key])
          : null
    }))
  );
</script>

<svelte:head>
  <title>Statistics {monthLabel(data.month.key)} - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <div class="flex items-start justify-between gap-4 flex-wrap">
    <div>
      <h1 class="text-3xl font-bold">Statistics</h1>
      <p class="text-sm text-muted-foreground mt-1">
        What is released month by month — connectors, components and E2E test flows on
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
    </div>
    <div class="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onclick={() => openMonth(data.month.previousKey)}
        title={monthLabel(data.month.previousKey)}
      >
        <ChevronLeft class="h-4 w-4" />
      </Button>
      <select
        class="h-9 rounded-md border border-input bg-background px-3 text-sm font-medium"
        value={data.month.key}
        onchange={(e) => openMonth(/** @type {HTMLSelectElement} */ (e.currentTarget).value)}
      >
        {#each monthOptions as option (option.key)}
          <option value={option.key}>{option.label}</option>
        {/each}
      </select>
      <Button
        variant="outline"
        size="sm"
        onclick={() => openMonth(data.month.nextKey)}
        disabled={!data.month.nextKey}
        title={data.month.nextKey ? monthLabel(data.month.nextKey) : 'Current month'}
      >
        <ChevronRight class="h-4 w-4" />
      </Button>
      <Button variant="outline" size="sm" onclick={refresh} disabled={refreshing}>
        <RefreshCw class="h-4 w-4 mr-2 {refreshing ? 'animate-spin' : ''}" />
        Refresh
      </Button>
    </div>
  </div>

  {#if data.error}
    <div
      class="border border-red-200 bg-red-50 text-red-800 rounded-lg p-4 text-sm flex items-start gap-2"
    >
      <TriangleAlert class="h-4 w-4 mt-0.5 shrink-0" />
      <span>{data.error}</span>
    </div>
  {/if}

  <!-- State at the end of the month -->
  <div>
    <div class="flex items-baseline justify-between gap-4 flex-wrap mb-2">
      <h2 class="text-lg font-semibold">
        {monthLabel(data.month.key)}
        {#if data.month.current}
          <span class="text-sm font-normal text-muted-foreground">(so far)</span>
        {/if}
      </h2>
      {#if data.head}
        <p class="text-xs text-muted-foreground inline-flex items-center gap-1">
          <GitCommitHorizontal class="h-3 w-3" />
          {data.month.current ? 'as of' : 'at the end of the month:'}
          <a
            href={data.head.url}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono hover:underline"
          >
            {data.head.sha.slice(0, 7)}
          </a>
          <span>· {formatDate(data.head.date)}</span>
          {#if data.previous}
            <span class="ml-2">
              change against {monthLabel(data.previous.month)} ({data.previous.head.sha.slice(
                0,
                7
              )})
            </span>
          {/if}
        </p>
      {:else if !data.error}
        <p class="text-xs text-muted-foreground">
          No commit on the branch before this month ended.
        </p>
      {/if}
    </div>
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      {#each tiles as tile (tile.key)}
        <div class="border rounded-lg p-5 flex items-center gap-4 bg-card">
          <div class="h-12 w-12 rounded-xl flex items-center justify-center shrink-0 {tile.class}">
            <tile.icon class="h-6 w-6" />
          </div>
          <div class="flex flex-col">
            <span class="flex items-baseline gap-2">
              <span class="text-3xl font-bold leading-none">{tile.value}</span>
              {#if tile.delta}
                <span
                  class="text-sm font-semibold tabular-nums {tile.delta.class}"
                  title="Change during the month">{tile.delta.text}</span
                >
              {/if}
            </span>
            <span class="text-sm font-medium mt-1">{tile.label}</span>
            <span class="text-xs text-muted-foreground">{tile.desc}</span>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Releases of the month -->
  <div>
    <h2 class="text-lg font-semibold mb-2 inline-flex items-center gap-2">
      <Rocket class="h-4 w-4" />
      Released this month
      <span class="text-sm font-normal text-muted-foreground">
        {data.releases.length} release{data.releases.length === 1 ? '' : 's'}
      </span>
    </h2>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      {#each TYPES as type (type)}
        {@const config = TYPE[type]}
        {@const active = typeFilter.has(type)}
        <button
          type="button"
          onclick={() => toggleType(type)}
          class="border rounded-lg p-3 text-left transition-colors cursor-pointer {config.class} {active
            ? `ring-2 ${config.ring}`
            : 'hover:opacity-80'}"
          title={active
            ? 'Click to drop this type from the filter'
            : `Show only ${config.label} releases`}
        >
          <div class="text-2xl font-bold">{data.releasesByType[type]}</div>
          <div class="text-xs font-medium">
            {config.label}
            <span class="font-normal opacity-70">({type})</span>
          </div>
        </button>
      {/each}
    </div>
  </div>

  <!-- Lists -->
  <div class="flex flex-wrap items-center gap-3">
    <div class="flex rounded-md border overflow-hidden">
      <button
        type="button"
        class="px-3 py-1.5 text-sm {tab === 'releases'
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-muted'}"
        onclick={() => (tab = 'releases')}
      >
        Releases
        <span class="ml-1 text-xs opacity-70">{filteredReleases.length}</span>
      </button>
      <button
        type="button"
        class="px-3 py-1.5 text-sm border-l {tab === 'connectors'
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
      <Input placeholder="Filter by connector, version or file name..." bind:value={searchQuery} />
    </div>
  </div>

  {#if tab === 'releases'}
    <div class="border rounded-lg overflow-hidden">
      <div
        class="grid grid-cols-[5rem_1fr_6rem_5rem_auto] gap-x-4 px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/50 border-b"
      >
        <span>Date</span>
        <span>Connector</span>
        <span>Version</span>
        <span>Type</span>
        <span class="text-right">Commit</span>
      </div>
      {#each filteredReleases as release (release.sha)}
        <div
          class="grid grid-cols-[5rem_1fr_6rem_5rem_auto] gap-x-4 items-center px-3 py-2 text-sm border-b last:border-b-0 hover:bg-muted/50"
        >
          <span class="text-muted-foreground tabular-nums">{formatDay(release.date)}</span>
          <span class="font-semibold truncate" title={release.message}>{release.connector}</span>
          <code class="text-xs bg-muted rounded-full px-2 py-0.5 w-fit">{release.version}</code>
          <span
            class="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs font-semibold {TYPE[
              release.type
            ].class}"
          >
            {TYPE[release.type].label}
          </span>
          <a
            href={release.url}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-xs text-muted-foreground hover:underline text-right"
          >
            {release.sha.slice(0, 7)}
          </a>
        </div>
      {:else}
        <div class="px-3 py-6 text-sm text-muted-foreground text-center">
          {data.releases.length === 0 ? 'Nothing released this month.' : 'No releases match.'}
        </div>
      {/each}
    </div>

    {#if data.other.length > 0}
      <div class="text-sm">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground hover:underline"
          onclick={() => (showOther = !showOther)}
        >
          {showOther ? 'Hide' : 'Show'}
          {data.other.length} other commit{data.other.length === 1 ? '' : 's'} of the month (not a release
          message)
        </button>
        {#if showOther}
          <div class="border rounded-lg overflow-hidden mt-2">
            {#each filteredOther as commit (commit.sha)}
              <div
                class="grid grid-cols-[5rem_1fr_auto] gap-x-4 items-center px-3 py-2 text-sm border-b last:border-b-0 hover:bg-muted/50"
              >
                <span class="text-muted-foreground tabular-nums">{formatDay(commit.date)}</span>
                <span class="truncate" title={commit.message}>{commit.message}</span>
                <a
                  href={commit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-mono text-xs text-muted-foreground hover:underline"
                >
                  {commit.sha.slice(0, 7)}
                </a>
              </div>
            {:else}
              <div class="px-3 py-4 text-sm text-muted-foreground text-center">
                No commits match.
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {:else if tab === 'connectors'}
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
