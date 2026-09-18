<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
  } from '$lib/components/ui/dialog';
  import { invalidateAll, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import {
    RefreshCw,
    Rocket,
    ChevronRight,
    ExternalLink,
    TriangleAlert,
    GitCommitHorizontal,
    GitPullRequest,
    CircleCheck,
    CircleDot
  } from 'lucide-svelte';

  let { data } = $props();

  const STATUS = {
    new: {
      label: 'New',
      class: 'bg-blue-100 text-blue-800 border-blue-200',
      title: 'Not on the release branch yet'
    },
    major: {
      label: 'Major',
      class: 'bg-red-100 text-red-800 border-red-200',
      title: 'dev has a higher major version'
    },
    minor: {
      label: 'Minor',
      class: 'bg-amber-100 text-amber-800 border-amber-200',
      title: 'dev has a higher minor version'
    },
    patch: {
      label: 'Patch',
      class: 'bg-green-100 text-green-800 border-green-200',
      title: 'dev has a higher patch version'
    },
    drift: {
      label: 'Unbumped changes',
      class: 'bg-yellow-50 text-yellow-800 border-yellow-300',
      title: 'Same version on both branches but the files differ — bump the version on dev to release them'
    },
    behind: {
      label: 'Release ahead',
      class: 'bg-purple-100 text-purple-800 border-purple-200',
      title: 'The release branch has a higher version than dev (hotfix?)'
    },
    'master-only': {
      label: 'Release only',
      class: 'bg-gray-100 text-gray-700 border-gray-200',
      title: 'On the release branch, not on dev'
    },
    same: {
      label: 'In sync',
      class: 'bg-gray-50 text-gray-500 border-gray-200',
      title: 'Same version and the same files'
    },
    invalid: {
      label: 'Invalid version',
      class: 'bg-red-50 text-red-700 border-red-300',
      title: 'bundle.json has no valid semver version'
    }
  };

  // Project status of the PRs a release would ship (see readiness.js)
  const READINESS = {
    ready: {
      label: 'Ready',
      class: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      title: 'Every tracked pull request since the last release is ready on the project'
    },
    'not-ready': {
      label: 'Not ready',
      class: 'bg-orange-100 text-orange-800 border-orange-200',
      title: 'A pull request since the last release is not ready on the project yet'
    },
    untracked: {
      label: 'Untracked',
      class: 'bg-gray-100 text-gray-600 border-gray-200',
      title: 'None of the pull requests since the last release is on the project — neither itself nor through an issue'
    },
    unknown: {
      label: 'No PR',
      class: 'bg-gray-50 text-gray-500 border-gray-200',
      title: 'No pull request found for the unreleased changes'
    }
  };

  // Stat tiles double as filters; `release` = everything releasable
  const TILES = [
    { key: 'release', label: 'To release', title: 'New, major, minor and patch — not in the open release PR yet', box: 'bg-slate-50 hover:bg-slate-100', num: 'text-slate-900', text: 'text-slate-700 font-medium', ring: 'ring-slate-500' },
    { key: 'ready', label: 'Ready', title: 'To release, and every tracked pull request is ready on the project', box: 'bg-emerald-50 hover:bg-emerald-100', num: 'text-emerald-700', text: 'text-emerald-700 font-medium', ring: 'ring-emerald-500' },
    { key: 'pending', label: 'In release PR', title: 'Already in the open release PR', box: 'bg-indigo-50 hover:bg-indigo-100', num: 'text-indigo-700', text: 'text-indigo-600 font-medium', ring: 'ring-indigo-500', hideEmpty: true },
    { key: 'new', label: 'New', box: 'bg-blue-50 hover:bg-blue-100', num: 'text-blue-700', text: 'text-blue-600 font-medium', ring: 'ring-blue-500' },
    { key: 'major', label: 'Major', box: 'bg-red-50 hover:bg-red-100', num: 'text-red-700', text: 'text-red-600 font-medium', ring: 'ring-red-500' },
    { key: 'minor', label: 'Minor', box: 'bg-amber-50 hover:bg-amber-100', num: 'text-amber-700', text: 'text-amber-600 font-medium', ring: 'ring-amber-500' },
    { key: 'patch', label: 'Patch', box: 'bg-green-50 hover:bg-green-100', num: 'text-green-700', text: 'text-green-600 font-medium', ring: 'ring-green-500' },
    { key: 'drift', label: 'Unbumped', box: 'bg-yellow-50 hover:bg-yellow-100', num: 'text-yellow-700', text: 'text-yellow-700 font-medium', ring: 'ring-yellow-500' },
    { key: 'behind', label: 'Release ahead', box: 'bg-purple-50 hover:bg-purple-100', num: 'text-purple-700', text: 'text-purple-600 font-medium', ring: 'ring-purple-500' },
    { key: 'master-only', label: 'Release only', box: 'hover:bg-muted/50', num: 'text-muted-foreground', text: 'text-muted-foreground', ring: 'ring-gray-400' },
    { key: 'same', label: 'In sync', box: 'hover:bg-muted/50', num: 'text-muted-foreground', text: 'text-muted-foreground', ring: 'ring-gray-400' },
    { key: 'invalid', label: 'Invalid version', box: 'bg-red-50 hover:bg-red-100', num: 'text-red-700', text: 'text-red-600 font-medium', ring: 'ring-red-500', hideEmpty: true }
  ];

  // Filters from/to URL params
  const params = $page.url.searchParams;
  let view = $state(params.get('view') || 'release');
  let searchQuery = $state(params.get('q') || '');

  let initialized = false;
  $effect(() => {
    const v = view;
    const q = searchQuery;
    if (!initialized) {
      initialized = true;
      return;
    }
    const url = new URL($page.url);
    const sp = url.searchParams;
    v !== 'release' ? sp.set('view', v) : sp.delete('view');
    q ? sp.set('q', q) : sp.delete('q');
    goto(url.pathname + (sp.toString() ? '?' + sp.toString() : ''), {
      replaceState: true,
      keepFocus: true,
      noScroll: true
    });
  });

  const connectors = $derived(data.connectors || []);

  // Release readiness is streamed in after the comparison (data.readiness is a promise)
  // (`loading` from the start, so the server-rendered page shows it as pending)
  let readiness = $state({ loading: !!data.readiness, connectors: {}, error: null });
  $effect(() => {
    const pending = data.readiness;
    if (!pending) {
      readiness = { loading: false, connectors: {}, error: null };
      return;
    }
    let stale = false;
    readiness = { loading: true, connectors: {}, error: null };
    Promise.resolve(pending)
      .then((r) => {
        if (!stale) readiness = { loading: false, connectors: r.connectors || {}, error: r.error };
      })
      .catch((e) => {
        if (!stale) readiness = { loading: false, connectors: {}, error: e?.message || 'Release readiness failed' };
      });
    return () => {
      stale = true;
    };
  });
  const isReady = (c) => c.releasable && readiness.connectors[c.name]?.state === 'ready';

  function statusSummary(pr) {
    if (!pr.via) return 'not on the project';
    return pr.statuses.map((status) => status || 'No status').join(', ');
  }
  const namespaceChanges = $derived(
    Object.fromEntries((data.namespaces || []).map((ns) => [ns.name, ns]))
  );
  const counts = $derived.by(() => {
    const result = { all: connectors.length, release: 0, pending: 0, ready: 0 };
    for (const c of connectors) {
      result[c.status] = (result[c.status] || 0) + 1;
      if (c.releasable) result.release++;
      if (isReady(c)) result.ready++;
      if (c.inPr) result.pending++;
    }
    return result;
  });

  const filtered = $derived(
    connectors.filter((c) => {
      const inView =
        view === 'all' ||
        (view === 'release'
          ? c.releasable
          : view === 'ready'
            ? isReady(c)
            : view === 'pending'
              ? !!c.inPr
              : c.status === view);
      const q = searchQuery.trim().toLowerCase();
      return inView && (!q || c.name.toLowerCase().includes(q));
    })
  );

  // --- Selection (admins only) ---
  let selected = $state({});
  const selectedConnectors = $derived(connectors.filter((c) => c.releasable && selected[c.name]));
  const visibleReleasable = $derived(filtered.filter((c) => c.releasable));
  const allVisibleSelected = $derived(
    visibleReleasable.length > 0 && visibleReleasable.every((c) => selected[c.name])
  );

  function toggleAllVisible() {
    const value = !allVisibleSelected;
    for (const c of visibleReleasable) selected[c.name] = value;
  }

  let expanded = $state({});

  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    try {
      await invalidateAll();
    } finally {
      refreshing = false;
    }
  }

  // --- Release dialog ---
  let dialogOpen = $state(false);
  let releaseTargets = $state([]);
  let plan = $state(null);
  let planLoading = $state(false);
  let planError = $state('');
  let releasing = $state(false);
  let releaseError = $state('');
  let result = $state(null);

  async function postRelease(targets, dryRun) {
    const response = await fetch('/api/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dryRun,
        connectors: targets.map((c) => ({ name: c.name, devVersion: c.devVersion }))
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(body?.message || `Release failed (${response.status})`);
    }
    return body;
  }

  /** Open the dialog with the exact commits the release would create (dry run) */
  async function openRelease(targets) {
    releaseTargets = targets;
    plan = null;
    planError = '';
    releaseError = '';
    result = null;
    dialogOpen = true;
    planLoading = true;
    try {
      plan = await postRelease(targets, true);
    } catch (e) {
      planError = e.message;
    } finally {
      planLoading = false;
    }
  }

  async function confirmRelease() {
    releasing = true;
    releaseError = '';
    try {
      result = await postRelease(releaseTargets, false);
      for (const c of releaseTargets) delete selected[c.name];
    } catch (e) {
      releaseError = e.message;
    } finally {
      releasing = false;
    }
  }

  const confirmLabel = $derived.by(() => {
    const count = plan ? plan.commits.length : releaseTargets.length;
    const commits = `${count} commit${count !== 1 ? 's' : ''}`;
    const pr = plan?.pr ?? data.pr;
    return pr ? `Add ${commits} to PR #${pr.number}` : `Push ${commits} & open PR`;
  });

  // After a release, reload the comparison once the dialog is closed (button or backdrop)
  $effect(() => {
    if (!dialogOpen && result) {
      result = null;
      invalidateAll();
    }
  });

  function fileUrl(info, path) {
    return `https://github.com/${info.repo}/blob/${info.branch}/src/appmixer/${path}`;
  }

  function dirUrl(info, name) {
    return `https://github.com/${info.repo}/tree/${info.branch}/src/appmixer/${name}`;
  }

  function formatRelativeTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  // Shared namespace files are mostly test flows and samples — list code files
  // by name and only count the artifacts
  function summarizeShared(paths) {
    const code = paths.filter((p) => !p.split('/').includes('artifacts'));
    const artifacts = paths.length - code.length;
    return [
      ...code,
      ...(artifacts ? [`${artifacts} artifact file${artifacts !== 1 ? 's' : ''}`] : [])
    ].join(', ');
  }

  function renamedList(renamed) {
    return renamed.map((r) => (r.from === r.to ? `${r.to} (moved)` : `${r.from} → ${r.to}`)).join(', ');
  }

  function latestChange(c) {
    const entry = c.changelog.at(-1);
    return entry ? `${entry.version}: ${entry.items[0] ?? ''}` : '';
  }
</script>

<svelte:head>
  <title>Release - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6 pb-4">
  <!-- Header -->
  <div class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-3xl font-bold">Release</h1>
      <p class="text-muted-foreground">
        Connector versions on the release branch against dev — everything dev has that isn't
        released yet
      </p>
    </div>
    <Button variant="outline" onclick={refresh} disabled={refreshing}>
      <RefreshCw size={15} class="mr-2 {refreshing ? 'animate-spin' : ''}" />
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </Button>
  </div>

  {#if data.error}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4 space-y-1">
      <p class="text-red-700 text-sm font-medium">Comparison failed: {data.error}</p>
      <p class="text-red-700/80 text-xs">
        The GitHub token (<code>SANITY_GITHUB_TOKEN</code> or your token in Settings) needs read
        access to both repositories — appmixer-components is private.
      </p>
    </div>
  {:else}
    <!-- Source Info -->
    <div class="flex flex-wrap gap-3 text-sm">
      {#each [['Release', data.target], ['Development', data.source]] as [label, info]}
        <a
          href={info.url}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md hover:bg-muted/70"
        >
          <span class="text-muted-foreground">{label}:</span>
          <span class="text-blue-600">{info.repo}</span>
          <Badge variant="outline">{info.branch}</Badge>
          <code class="text-xs text-muted-foreground">{info.commitSha.slice(0, 7)}</code>
          <span class="text-xs text-muted-foreground" title={info.committedAt}>
            {formatRelativeTime(info.committedAt)}
          </span>
        </a>
      {/each}
      {#if data.pr}
        <a
          href={data.pr.url}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-800 rounded-md hover:bg-indigo-100"
        >
          <GitPullRequest size={14} />
          <span>Open release PR #{data.pr.number}</span>
          <span class="text-xs text-indigo-600">{data.head.repo}:{data.head.branch}</span>
        </a>
      {:else}
        <a
          href={data.head.url}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md hover:bg-muted/70"
        >
          <span class="text-muted-foreground">PR from:</span>
          <span class="text-blue-600">{data.head.repo}</span>
          <Badge variant="outline">{data.head.branch}</Badge>
          <span class="text-xs text-muted-foreground">no open release PR</span>
        </a>
      {/if}
    </div>

    {#if readiness.error}
      <div class="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
        <p class="font-medium">Release readiness is unavailable: {readiness.error}</p>
        <p class="text-xs text-amber-800/80">
          The project status is read with the GitHub token (<code>SANITY_GITHUB_TOKEN</code> or your
          token in Settings), which needs the <code>read:project</code> scope on top of the read access
          to both repositories.
        </p>
      </div>
    {/if}

    <!-- Stats / filters -->
    <div class="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-10 gap-3">
      {#each TILES.filter((t) => !t.hideEmpty || counts[t.key]) as tile (tile.key)}
        <button
          type="button"
          onclick={() => (view = view === tile.key ? 'all' : tile.key)}
          class="border rounded-lg p-3 text-left transition-colors cursor-pointer {tile.box} {view ===
          tile.key
            ? `ring-2 ${tile.ring}`
            : ''}"
          title={view === tile.key ? 'Click to show all connectors' : tile.title || STATUS[tile.key]?.title}
        >
          <div class="text-2xl font-bold {tile.num}">{counts[tile.key] || 0}</div>
          <div class="text-xs {tile.text}">{tile.label}</div>
        </button>
      {/each}
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex-1 min-w-64">
        <Input placeholder="Search connectors..." bind:value={searchQuery} />
      </div>
      <select bind:value={view} class="h-10 rounded-md border border-input bg-background px-3 text-sm">
        <option value="release">To release ({counts.release})</option>
        <option value="ready">Ready ({counts.ready})</option>
        <option value="all">All connectors ({counts.all})</option>
        {#if counts.pending}
          <option value="pending">In release PR ({counts.pending})</option>
        {/if}
        {#each Object.entries(STATUS) as [key, status]}
          {#if counts[key]}
            <option value={key}>{status.label} ({counts[key]})</option>
          {/if}
        {/each}
      </select>
    </div>

    <p class="text-sm text-muted-foreground">
      {filtered.length} connector{filtered.length !== 1 ? 's' : ''}
      {#if !data.isAdmin}
        <span class="text-muted-foreground/70">· releasing is limited to admins</span>
      {/if}
    </p>

    {#if data.namespaces.length > 0 && (view === 'release' || view === 'all')}
      <div class="border rounded-lg px-4 py-3 bg-muted/30 text-sm space-y-1">
        <p class="font-medium">Shared namespace files differ</p>
        <p class="text-xs text-muted-foreground">
          Added and changed files ship with the first released connector of the namespace; files
          removed on dev stay on the release branch.
        </p>
        <ul class="text-xs space-y-1 pt-1">
          {#each data.namespaces as ns (ns.name)}
            <li class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span class="font-mono font-semibold">{ns.name}/</span>
              {#if ns.modified.length > 0}
                <span class="text-amber-700 break-all" title={ns.modified.join('\n')}>
                  changed: {summarizeShared(ns.modified)}
                </span>
              {/if}
              {#if ns.added.length > 0}
                <span class="text-green-700 break-all" title={ns.added.join('\n')}>
                  added: {summarizeShared(ns.added)}
                </span>
              {/if}
              {#if ns.removed.length > 0}
                <span class="text-muted-foreground break-all" title="Removed on dev — kept on the release branch">
                  removed on dev (kept): {ns.removed.join(', ')}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- Connector table -->
    {#if filtered.length === 0}
      <div class="text-center py-12 border rounded-lg bg-muted/50">
        <p class="text-muted-foreground">
          {view === 'release' ? 'Nothing to release — the release branch is up to date' : 'No connectors match the current filters'}
        </p>
      </div>
    {:else}
      <div class="border rounded-lg overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-muted/40 border-b text-left text-xs text-muted-foreground">
            <tr>
              <th class="px-3 py-2 w-8">
                {#if data.isAdmin && visibleReleasable.length > 0}
                  <input
                    type="checkbox"
                    class="h-4 w-4 accent-primary cursor-pointer align-middle"
                    checked={allVisibleSelected}
                    onchange={toggleAllVisible}
                    title="Select all releasable connectors shown"
                  />
                {/if}
              </th>
              <th class="px-3 py-2 font-medium">Connector</th>
              <th class="px-3 py-2 font-medium">{data.target.branch}</th>
              <th class="px-3 py-2 font-medium">{data.source.branch}</th>
              <th class="px-3 py-2 font-medium">Status</th>
              <th class="px-3 py-2 font-medium">
                <a
                  href={data.project.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="hover:underline"
                  title="Status of the pull requests since the last release on the GitHub project — ready means {data.project.readyStatuses.join(' / ')}"
                >Project</a>
              </th>
              <th class="px-3 py-2 font-medium">Files</th>
              <th class="px-3 py-2 font-medium">Changelog</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#each filtered as c (c.name)}
              {@const status = STATUS[c.status]}
              {@const shared = c.releasable && c.namespace ? namespaceChanges[c.namespace] : null}
              {@const ready = readiness.connectors[c.name]}
              <tr class="border-b last:border-b-0 hover:bg-muted/30 {selected[c.name] ? 'bg-blue-50/50' : ''}">
                <td class="px-3 py-2">
                  {#if data.isAdmin && c.releasable}
                    <input
                      type="checkbox"
                      class="h-4 w-4 accent-primary cursor-pointer align-middle"
                      checked={!!selected[c.name]}
                      onchange={(e) => (selected[c.name] = e.currentTarget.checked)}
                    />
                  {/if}
                </td>
                <td class="px-3 py-2">
                  <button
                    type="button"
                    class="flex items-center gap-1 font-medium hover:underline text-left"
                    onclick={() => (expanded[c.name] = !expanded[c.name])}
                  >
                    <ChevronRight
                      size={14}
                      class="shrink-0 text-muted-foreground transition-transform {expanded[c.name] ? 'rotate-90' : ''}"
                    />
                    {c.name}
                  </button>
                </td>
                <td class="px-3 py-2 font-mono text-xs text-muted-foreground">{c.masterVersion ?? '—'}</td>
                <td class="px-3 py-2 font-mono text-xs">{c.devVersion ?? '—'}</td>
                <td class="px-3 py-2">
                  <span
                    class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap {status.class}"
                    title={status.title}
                  >
                    {status.label}
                  </span>
                  {#if c.inPr}
                    <a
                      href={c.inPr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
                      title="The open release PR carries {c.name} {c.inPr.version}"
                    >
                      <GitPullRequest size={11} /> #{c.inPr.number} · {c.inPr.version}
                    </a>
                  {/if}
                </td>
                <td class="px-3 py-2 whitespace-nowrap">
                  {#if ready}
                    {@const untracked = ready.prs.filter((pr) => !pr.via).length}
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border {READINESS[ready.state].class}"
                      title="{READINESS[ready.state].title}{ready.prs.length ? '\n' + ready.prs.map((pr) => `#${pr.number}: ${statusSummary(pr)}`).join('\n') : ''}"
                      onclick={() => (expanded[c.name] = true)}
                    >
                      {#if ready.state === 'ready'}
                        <CircleCheck size={11} />
                      {:else if ready.state === 'not-ready'}
                        <CircleDot size={11} />
                      {/if}
                      {READINESS[ready.state].label}
                    </button>
                    {#if untracked > 0 && ready.state !== 'untracked'}
                      <span
                        class="ml-1 text-xs text-muted-foreground"
                        title="{untracked} pull request{untracked !== 1 ? 's' : ''} not on the project — listed in the details, not counted"
                      >+{untracked}</span>
                    {/if}
                  {:else if c.releasable && readiness.loading}
                    <RefreshCw size={12} class="animate-spin text-muted-foreground" />
                  {:else}
                    <span class="text-xs text-muted-foreground">—</span>
                  {/if}
                </td>
                <td class="px-3 py-2 font-mono text-xs whitespace-nowrap">
                  {#if c.changes.added.length + c.changes.modified.length + c.changes.removed.length > 0}
                    <span class="text-green-700">+{c.changes.added.length}</span>
                    <span class="text-amber-700 ml-1">~{c.changes.modified.length}</span>
                    <span class="text-red-700 ml-1">−{c.changes.removed.length}</span>
                  {:else}
                    <span class="text-muted-foreground">—</span>
                  {/if}
                  {#if c.releasable && c.removedComponents.length > 0}
                    <span
                      class="inline-flex align-middle text-red-600 ml-1"
                      title="Deletes components dev no longer has: {c.removedComponents.join(', ')}"
                    >
                      <TriangleAlert size={13} />
                    </span>
                  {/if}
                  {#if shared}
                    <span
                      class="ml-1 text-muted-foreground"
                      title="The namespace's shared files differ — added/changed ones ship with the first {c.namespace}/* connector released"
                    >+{c.namespace}/</span>
                  {/if}
                </td>
                <td class="px-3 py-2 text-xs text-muted-foreground max-w-md truncate" title={latestChange(c)}>
                  {latestChange(c)}
                </td>
                <td class="px-3 py-2 text-right">
                  {#if data.isAdmin && c.releasable}
                    <Button variant="outline" size="sm" class="h-7 px-2 text-xs" onclick={() => openRelease([c])}>
                      Release
                    </Button>
                  {/if}
                </td>
              </tr>
              {#if expanded[c.name]}
                <tr class="border-b bg-muted/20">
                  <td></td>
                  <td colspan="8" class="px-3 py-3 space-y-3 text-xs">
                    <div class="flex flex-wrap items-center gap-3">
                      {#if c.message}
                        <span class="flex items-center gap-1.5">
                          <GitCommitHorizontal size={14} class="text-muted-foreground" />
                          <code class="font-mono font-semibold">{c.message}</code>
                        </span>
                      {/if}
                      {#if c.masterVersion}
                        <a href={dirUrl(data.target, c.name)} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-blue-600 hover:underline">
                          {data.target.branch} <ExternalLink size={11} />
                        </a>
                      {/if}
                      {#if c.devVersion}
                        <a href={dirUrl(data.source, c.name)} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-blue-600 hover:underline">
                          {data.source.branch} <ExternalLink size={11} />
                        </a>
                      {/if}
                    </div>

                    {#if c.removedComponents.length > 0}
                      <p class="text-red-700 flex items-center gap-1.5">
                        <TriangleAlert size={13} />
                        Deletes components dev no longer has: {c.removedComponents.join(', ')}
                      </p>
                    {/if}
                    {#if c.renamedComponents.length > 0}
                      <p class="text-amber-700">Renamed: {renamedList(c.renamedComponents)}</p>
                    {/if}
                    {#if c.addedComponents.length > 0}
                      <p class="text-green-700">New components: {c.addedComponents.join(', ')}</p>
                    {/if}

                    {#if ready && (ready.prs.length > 0 || ready.directCommits.length > 0)}
                      <div>
                        <p class="font-medium mb-1">
                          Pull requests since {c.masterVersion ?? 'the beginning'}
                          <span class="font-normal text-muted-foreground">
                            · ready = {data.project.readyStatuses.join(' / ')} on the
                            <a href={data.project.url} target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">project</a>
                          </span>
                        </p>
                        <ul class="space-y-1.5">
                          {#each ready.prs as pr (pr.number)}
                            <li>
                              <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                <GitPullRequest size={12} class="shrink-0 {pr.merged ? 'text-purple-600' : 'text-green-600'}" />
                                <a href={pr.url} target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">#{pr.number}</a>
                                <span class="text-foreground">{pr.title}</span>
                                {#if pr.via === 'pr'}
                                  <span
                                    class="inline-flex items-center px-1.5 py-0.5 rounded-full border font-semibold {pr.ready ? READINESS.ready.class : READINESS['not-ready'].class}"
                                    title="The pull request itself is on the project"
                                  >{pr.status || 'No status'}</span>
                                {:else if !pr.via}
                                  <span class="inline-flex items-center px-1.5 py-0.5 rounded-full border {READINESS.untracked.class}" title="Neither the pull request nor an issue it closes is on the project — not counted">
                                    not on the project
                                  </span>
                                {/if}
                              </div>
                              {#each pr.issues as issue (issue.url)}
                                <div class="ml-5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                                  <span>↳</span>
                                  <a href={issue.url} target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">{issue.repo}#{issue.number}</a>
                                  <span>{issue.title}</span>
                                  {#if issue.tracked}
                                    <span class="inline-flex items-center px-1.5 py-0.5 rounded-full border font-semibold {issue.ready ? READINESS.ready.class : READINESS['not-ready'].class}">
                                      {issue.status || 'No status'}
                                    </span>
                                  {:else}
                                    <span class="inline-flex items-center px-1.5 py-0.5 rounded-full border {READINESS.untracked.class}">not on the project</span>
                                  {/if}
                                </div>
                              {/each}
                            </li>
                          {/each}
                          {#each ready.directCommits as commit (commit.sha)}
                            <li class="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                              <GitCommitHorizontal size={12} class="shrink-0" />
                              <a href={commit.url} target="_blank" rel="noopener noreferrer" class="font-mono text-blue-600 hover:underline">{commit.sha.slice(0, 7)}</a>
                              <span>{commit.message}</span>
                              <span class="italic">no pull request</span>
                            </li>
                          {/each}
                        </ul>
                        {#if ready.truncated}
                          <p class="text-muted-foreground mt-1">Only the latest unreleased commits were checked — older pull requests may be missing.</p>
                        {/if}
                      </div>
                    {/if}

                    {#if c.changelog.length > 0}
                      <div>
                        <p class="font-medium mb-1">Changelog since {c.masterVersion ?? 'nothing released'}</p>
                        <ul class="space-y-1">
                          {#each c.changelog as entry (entry.version)}
                            <li>
                              <span class="font-mono font-semibold">{entry.version}</span>
                              <ul class="list-disc ml-5 text-muted-foreground">
                                {#each entry.items as item}
                                  <li>{item}</li>
                                {/each}
                              </ul>
                            </li>
                          {/each}
                        </ul>
                      </div>
                    {/if}

                    {#if c.changes.added.length + c.changes.modified.length + c.changes.removed.length > 0}
                      <div>
                        <p class="font-medium mb-1">Files ({data.target.branch} → {data.source.branch})</p>
                        <ul class="font-mono space-y-0.5 max-h-64 overflow-auto">
                          {#each c.changes.added as path}
                            <li><a class="text-green-700 hover:underline" href={fileUrl(data.source, `${c.name}/${path}`)} target="_blank" rel="noopener noreferrer">+ {path}</a></li>
                          {/each}
                          {#each c.changes.modified as path}
                            <li><a class="text-amber-700 hover:underline" href={fileUrl(data.source, `${c.name}/${path}`)} target="_blank" rel="noopener noreferrer">~ {path}</a></li>
                          {/each}
                          {#each c.changes.removed as path}
                            <li><a class="text-red-700 hover:underline" href={fileUrl(data.target, `${c.name}/${path}`)} target="_blank" rel="noopener noreferrer">− {path}</a></li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- Selection bar -->
    {#if data.isAdmin && selectedConnectors.length > 0}
      <div class="sticky bottom-4 z-10 border rounded-lg bg-background shadow-lg px-4 py-3 flex items-center justify-between gap-3">
        <p class="text-sm min-w-0 truncate">
          <span class="font-semibold">{selectedConnectors.length} selected:</span>
          <span class="text-muted-foreground">
            {selectedConnectors.map((c) => `${c.name} ${c.devVersion}`).join(', ')}
          </span>
        </p>
        <div class="flex items-center gap-2 shrink-0">
          <Button variant="ghost" size="sm" onclick={() => (selected = {})}>Clear</Button>
          <Button size="sm" onclick={() => openRelease(selectedConnectors)}>
            <Rocket size={14} class="mr-2" />
            Release {selectedConnectors.length}
          </Button>
        </div>
      </div>
    {/if}
  {/if}
</div>

<Dialog bind:open={dialogOpen}>
  <DialogContent class="max-w-3xl max-h-[85vh] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>
        {#if result}
          {result.pr.created ? 'Opened' : 'Updated'} release PR #{result.pr.number}
        {:else}
          Release {releaseTargets.length} connector{releaseTargets.length !== 1 ? 's' : ''}
        {/if}
      </DialogTitle>
      <DialogDescription>
        One commit per connector from {data.source?.repo}@{data.source?.branch}, pushed to
        <span class="font-medium text-foreground">{data.head?.repo}:{data.head?.branch}</span>
        {#if data.pr}
          and added to the open release PR #{data.pr.number}
        {:else}
          with a new <code>[RELEASE]</code> PR
        {/if}
        into {data.target?.repo}@{data.target?.branch}.
      </DialogDescription>
    </DialogHeader>

    {#if result}
      <a
        href={result.pr.url}
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:underline"
      >
        <GitPullRequest size={14} />
        {result.pr.title} #{result.pr.number}
        <ExternalLink size={12} />
      </a>
      <p class="text-xs text-muted-foreground">
        Merge it with <strong>Rebase and merge</strong> to keep one commit per connector — merging
        starts the Marketplace PRD workflow.
      </p>
      <ul class="space-y-1.5 text-sm">
        {#each result.commits as commit (commit.sha)}
          <li class="flex items-center gap-2">
            <GitCommitHorizontal size={14} class="text-green-600 shrink-0" />
            <a href={commit.url} target="_blank" rel="noopener noreferrer" class="font-mono hover:underline">
              {commit.message}
            </a>
            <code class="text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</code>
          </li>
        {/each}
      </ul>
    {:else}
      <div class="bg-blue-50 border border-blue-200 rounded-md p-3 text-sm text-blue-900 flex gap-2">
        <GitPullRequest size={16} class="shrink-0 mt-0.5" />
        <span>
          Nothing reaches <code>{data.target?.branch}</code> until the PR is merged. Merge it with
          <strong>Rebase and merge</strong> to keep one commit per connector — merging starts the
          <strong>Marketplace PRD</strong> workflow.
        </span>
      </div>

      {#if planLoading}
        <p class="text-sm text-muted-foreground flex items-center gap-2">
          <RefreshCw size={14} class="animate-spin" /> Preparing the commits...
        </p>
      {:else if planError}
        <div class="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{planError}</div>
      {:else if plan}
        <ol class="space-y-2">
          {#each plan.commits as commit (commit.connector)}
            {@const sharedFiles = [...commit.shared.added, ...commit.shared.modified]}
            <li class="border rounded-md px-3 py-2 space-y-1">
              <div class="flex items-center gap-2">
                <GitCommitHorizontal size={14} class="text-muted-foreground shrink-0" />
                <code class="font-mono text-sm font-semibold">{commit.message}</code>
              </div>
              <p class="text-xs text-muted-foreground font-mono">
                <span class="text-green-700">+{commit.added.length}</span>
                <span class="text-amber-700 ml-1">~{commit.modified.length}</span>
                <span class="text-red-700 ml-1">−{commit.removed.length}</span>
                files
                {#if sharedFiles.length > 0}
                  · <span class="break-all" title={sharedFiles.join('\n')}>shared: {summarizeShared(sharedFiles)}</span>
                {/if}
              </p>
              {#if commit.removedComponents.length > 0}
                <p class="text-xs text-red-700 flex items-center gap-1">
                  <TriangleAlert size={12} /> Deletes components dev no longer has: {commit.removedComponents.join(', ')}
                </p>
              {/if}
              {#if commit.renamedComponents.length > 0}
                <p class="text-xs text-amber-700">Renamed: {renamedList(commit.renamedComponents)}</p>
              {/if}
              {#if commit.addedComponents.length > 0}
                <p class="text-xs text-green-700">New components: {commit.addedComponents.join(', ')}</p>
              {/if}
              {#if commit.shared.keptRemoved.length > 0}
                <p class="text-xs text-muted-foreground">
                  Kept on {data.target?.branch} (removed on dev, shared): {commit.shared.keptRemoved.join(', ')}
                </p>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}

      {#if releaseError}
        <div class="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700">{releaseError}</div>
      {/if}
    {/if}

    <DialogFooter>
      {#if result}
        <Button onclick={() => (dialogOpen = false)}>Close</Button>
      {:else}
        <Button variant="outline" onclick={() => (dialogOpen = false)} disabled={releasing}>Cancel</Button>
        <Button onclick={confirmRelease} disabled={!plan || planLoading || releasing}>
          <GitPullRequest size={14} class="mr-2" />
          {releasing ? 'Pushing...' : confirmLabel}
        </Button>
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>
