<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
  } from '$lib/components/ui/dialog';
  import { invalidateAll } from '$app/navigation';
  import { RefreshCw, Upload, TriangleAlert, ExternalLink, Settings } from 'lucide-svelte';
  import { compareVersions, publishVerdict } from '$lib/marketplace.js';

  let { data } = $props();

  /** @type {Record<string, {label: string, badge: string}>} */
  const VERDICT = {
    new: { label: 'Not installed', badge: 'bg-blue-100 text-blue-800' },
    upgrade: { label: 'Upgrade', badge: 'bg-amber-100 text-amber-800' },
    same: { label: 'Up to date', badge: 'bg-green-100 text-green-800' },
    downgrade: { label: 'Downgrade', badge: 'bg-red-100 text-red-800' }
  };

  const TILES = [
    { key: 'all', label: 'In marketplace', box: 'bg-muted/40', num: '', text: 'text-muted-foreground' },
    { key: 'new', label: 'Not installed', box: 'bg-blue-50 border-blue-200', num: 'text-blue-700', text: 'text-blue-700' },
    { key: 'upgrade', label: 'Upgrade available', box: 'bg-amber-50 border-amber-200', num: 'text-amber-700', text: 'text-amber-700' },
    { key: 'same', label: 'Up to date', box: 'bg-green-50 border-green-200', num: 'text-green-700', text: 'text-green-700' },
    { key: 'downgrade', label: 'Instance is newer', box: 'bg-red-50 border-red-200', num: 'text-red-700', text: 'text-red-700' }
  ];

  const POLL_MS = 2000;
  // The instance runs npm install for the package — minutes for the heavy ones
  const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

  // Overridable: `load` replaces it, a refresh after publishing assigns to it
  let instance = $derived(data.instance);

  let search = $state('');
  let view = $state('all');
  /** @type {Record<string, boolean>} */
  let selected = $state({});
  /** Version picked per connector — the latest one unless changed. @type {Record<string, string>} */
  let chosen = $state({});
  /** Versions loaded per connector. @type {Record<string, Array<{version: string, engine: string|null}>>} */
  let versions = $state({});
  /** @type {Record<string, string>} */
  let versionsError = $state({});
  let refreshing = $state(false);

  let dialogOpen = $state(false);
  /** @type {Array<{name: string, label: string, version: string, installed: string|null, verdict: keyof typeof VERDICT, include: boolean, state: 'idle'|'running'|'done'|'failed'|'skipped', message: string}>} */
  let targets = $state([]);
  let running = $state(false);
  let stopRequested = $state(false);
  let finished = $state(false);
  /** Instance the open dialog was confirmed for */
  let dialogInstance = $state({ baseUrl: '', host: '' });

  const instanceHost = $derived(hostOf(instance.baseUrl));

  const rows = $derived(
    data.modules.map((m) => {
      const version = chosen[m.name] || m.version;
      const installed = instance.installed?.[m.name] || null;
      return { ...m, version, latest: m.version, installed, verdict: publishVerdict(installed, version) };
    })
  );

  const counts = $derived.by(() => {
    /** @type {Record<string, number>} */
    const c = { all: rows.length, new: 0, upgrade: 0, same: 0, downgrade: 0 };
    for (const r of rows) c[r.verdict]++;
    return c;
  });

  const shown = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (view === 'all' || r.verdict === view) &&
        (!q || r.name.toLowerCase().includes(q) || (r.label || '').toLowerCase().includes(q))
    );
  });

  const selectedRows = $derived(rows.filter((r) => selected[r.name]));
  const allShownSelected = $derived(shown.length > 0 && shown.every((r) => selected[r.name]));

  /** Bundles the instance has that the marketplace doesn't offer (custom or retired) */
  const instanceOnly = $derived.by(() => {
    const offered = new Set(data.modules.map((m) => m.name));
    return Object.keys(instance.installed || {})
      .filter((name) => !offered.has(name))
      .sort();
  });

  /** Why publishing is unavailable, or '' */
  const blocked = $derived(
    !data.isAdmin
      ? 'Publishing is limited to admins.'
      : instance.error
        ? instance.error
        : !instance.isInstanceAdmin && instance.vendors.length === 0
          ? `${instance.username} may not upload connectors on ${instanceHost} — the account needs the admin scope there.`
          : ''
  );

  /** @param {string} url */
  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url || 'no instance';
    }
  }

  /** The engine checks vendors per file; an admin may upload any. @param {string} name */
  function mayPublish(name) {
    return !blocked && (instance.isInstanceAdmin || instance.vendors.includes(name.split('.')[0]));
  }

  function toggleAllShown() {
    const value = !allShownSelected;
    for (const r of shown) selected[r.name] = value;
  }

  /** @param {'new'|'upgrade'} verdict */
  function selectByVerdict(verdict) {
    selected = Object.fromEntries(rows.filter((r) => r.verdict === verdict).map((r) => [r.name, true]));
  }

  /** @param {string} name */
  async function loadVersions(name) {
    if (versions[name]) return;
    delete versionsError[name];
    try {
      const res = await fetch(`/api/marketplace/versions?name=${encodeURIComponent(name)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      versions[name] = body.versions;
    } catch (err) {
      versionsError[name] = /** @type {Error} */ (err).message;
    }
  }

  async function refresh() {
    refreshing = true;
    try {
      await invalidateAll();
    } finally {
      refreshing = false;
    }
  }

  /** Re-read what the instance has installed, without reloading the catalogue */
  async function refreshInstalled() {
    try {
      const res = await fetch('/api/marketplace/installed');
      if (res.ok) instance = await res.json();
    } catch {
      // the table keeps the previous state; Refresh reloads it
    }
  }

  /** @param {typeof rows} list */
  function openDialog(list) {
    targets = list
      .filter((r) => mayPublish(r.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({
        name: r.name,
        label: r.label || r.name,
        version: r.version,
        installed: r.installed,
        verdict: r.verdict,
        // Reinstalling the same version or going back is a deliberate act — tick it by hand
        include: r.verdict === 'new' || r.verdict === 'upgrade' || list.length === 1,
        state: 'idle',
        message: ''
      }));
    dialogInstance = { baseUrl: instance.baseUrl, host: instanceHost };
    finished = false;
    stopRequested = false;
    dialogOpen = true;
  }

  /**
   * Publish one package and wait for the instance to install it.
   * @param {(typeof targets)[number]} target
   */
  async function publishOne(target) {
    target.state = 'running';
    target.message = 'Downloading from the marketplace and uploading…';
    try {
      const res = await fetch('/api/marketplace/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: target.name,
          version: target.version,
          instanceUrl: dialogInstance.baseUrl
        })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

      const query = new URLSearchParams({ ticket: body.ticket, instanceUrl: dialogInstance.baseUrl });
      const started = Date.now();
      while (Date.now() - started < INSTALL_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const poll = await fetch(`/api/marketplace/publish?${query}`);
        const status = await poll.json().catch(() => ({}));
        if (poll.status === 409 || poll.status === 403) throw new Error(status.error);
        if (!poll.ok) continue; // a hiccup of the instance — the ticket is still valid
        // `finished` is set on failure too, so the error goes first
        if (status.err) {
          const detail = status.data ? ` ${JSON.stringify(status.data)}` : '';
          throw new Error(`The instance rejected the package: ${status.err}${detail}`);
        }
        if (status.finished) {
          target.state = 'done';
          target.message = `Installed in ${Math.round((Date.now() - started) / 1000)} s`;
          return;
        }
        target.message = `The instance is installing the package… ${Math.round((Date.now() - started) / 1000)} s`;
      }
      throw new Error('Timed out waiting for the instance to install the package');
    } catch (err) {
      target.state = 'failed';
      target.message = /** @type {Error} */ (err).message;
    }
  }

  /** @param {boolean} retry - run only the failed ones again */
  async function run(retry = false) {
    running = true;
    stopRequested = false;
    finished = false;
    for (const target of targets) {
      const due = retry ? target.state === 'failed' : target.include && target.state === 'idle';
      if (!due) continue;
      if (stopRequested) {
        if (!retry) target.state = 'skipped';
        continue;
      }
      await publishOne(target);
      if (target.state === 'done') selected[target.name] = false;
    }
    await refreshInstalled();
    running = false;
    finished = true;
  }

  const toRun = $derived(targets.filter((t) => t.include && t.state === 'idle').length);
  const failed = $derived(targets.filter((t) => t.state === 'failed').length);
  const done = $derived(targets.filter((t) => t.state === 'done').length);

  // Closing the dialog mid-run would hide a publish that keeps going
  $effect(() => {
    if (running && !dialogOpen) dialogOpen = true;
  });
</script>

<svelte:head>
  <title>Marketplace - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6 pb-4">
  <div class="flex items-center justify-between gap-4">
    <div>
      <h1 class="text-3xl font-bold">Marketplace</h1>
      <p class="text-muted-foreground">
        Connectors of the production marketplace against what the instance has installed — publish
        any version to it.
      </p>
    </div>
    <Button variant="outline" onclick={refresh} disabled={refreshing || running}>
      <RefreshCw size={15} class="mr-2 {refreshing ? 'animate-spin' : ''}" />
      Refresh
    </Button>
  </div>

  <div class="flex flex-wrap items-center gap-3 text-sm">
    <div class="flex items-center gap-2 px-3 py-1.5 bg-indigo-50 text-indigo-900 rounded-md">
      <span class="text-indigo-700">Instance:</span>
      {#if instance.baseUrl}
        <a href={instance.uiUrl} target="_blank" rel="noopener noreferrer" class="font-semibold hover:underline">
          {instanceHost}
        </a>
        <span class="text-xs text-indigo-700">
          as {instance.username}{instance.isInstanceAdmin
            ? ' · admin'
            : instance.vendors.length
              ? ` · vendors: ${instance.vendors.join(', ')}`
              : ''}
        </span>
      {:else}
        <span class="font-semibold">not configured</span>
      {/if}
    </div>
    <a href="/settings" class="flex items-center gap-1 text-blue-600 hover:underline">
      <Settings size={14} /> Change instance in Settings
    </a>
    <span class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md">
      <span class="text-muted-foreground">Marketplace:</span>
      <span>production</span>
      <code class="text-xs text-muted-foreground">{data.marketplaceHost}</code>
    </span>
  </div>

  {#if data.marketplaceError}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700 text-sm font-medium">Marketplace failed to load: {data.marketplaceError}</p>
    </div>
  {/if}

  {#if blocked}
    <div class="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
      <TriangleAlert size={16} class="mt-0.5 shrink-0" />
      <p>{blocked}</p>
    </div>
  {/if}

  <div class="grid grid-cols-2 sm:grid-cols-5 gap-3">
    {#each TILES as tile}
      <button
        type="button"
        class="border rounded-lg p-3 text-left transition-colors cursor-pointer {tile.box} {view === tile.key
          ? 'ring-2 ring-primary'
          : ''}"
        onclick={() => (view = tile.key)}
      >
        <div class="text-2xl font-bold {tile.num}">{counts[tile.key] || 0}</div>
        <div class="text-xs {tile.text}">{tile.label}</div>
      </button>
    {/each}
  </div>

  <div class="flex flex-wrap items-center gap-3">
    <div class="flex-1 min-w-64">
      <Input placeholder="Search connectors…" bind:value={search} />
    </div>
    <Button variant="outline" size="sm" onclick={() => selectByVerdict('upgrade')} disabled={!counts.upgrade}>
      Select upgrades ({counts.upgrade})
    </Button>
    <Button variant="outline" size="sm" onclick={() => selectByVerdict('new')} disabled={!counts.new}>
      Select not installed ({counts.new})
    </Button>
  </div>

  <p class="text-sm text-muted-foreground">
    Showing {shown.length} of {rows.length} connectors
    {#if instanceOnly.length}
      <span class="text-muted-foreground/70" title={instanceOnly.join('\n')}>
        · {instanceOnly.length} bundle{instanceOnly.length !== 1 ? 's' : ''} on the instance {instanceOnly.length !==
        1
          ? 'are'
          : 'is'} not in the marketplace
      </span>
    {/if}
  </p>

  {#if shown.length === 0}
    <div class="text-center py-12 border rounded-lg bg-muted/50">
      <p class="text-muted-foreground">No connectors match.</p>
    </div>
  {:else}
    <div class="border rounded-lg overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-muted/40 border-b text-left text-xs text-muted-foreground">
          <tr>
            <th class="px-3 py-2 w-8">
              <input
                type="checkbox"
                class="h-4 w-4 accent-primary cursor-pointer align-middle"
                checked={allShownSelected}
                onchange={toggleAllShown}
                aria-label="Select all shown"
              />
            </th>
            <th class="px-3 py-2 font-medium">Connector</th>
            <th class="px-3 py-2 font-medium">Marketplace</th>
            <th class="px-3 py-2 font-medium">Installed</th>
            <th class="px-3 py-2 font-medium">Status</th>
            <th class="px-3 py-2 font-medium">Latest changes</th>
            <th class="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each shown as r (r.name)}
            <tr class="border-b last:border-b-0 hover:bg-muted/30 {selected[r.name] ? 'bg-blue-50/50' : ''}">
              <td class="px-3 py-2">
                <input
                  type="checkbox"
                  class="h-4 w-4 accent-primary cursor-pointer align-middle"
                  checked={!!selected[r.name]}
                  onchange={(e) => (selected[r.name] = e.currentTarget.checked)}
                  aria-label="Select {r.name}"
                />
              </td>
              <td class="px-3 py-2">
                <div class="flex items-center gap-2">
                  {#if r.hasIcon}
                    <img
                      src="/api/marketplace/icon?name={encodeURIComponent(r.name)}"
                      alt=""
                      loading="lazy"
                      class="h-6 w-6 shrink-0 object-contain"
                    />
                  {:else}
                    <span class="h-6 w-6 shrink-0 rounded bg-muted"></span>
                  {/if}
                  <div class="min-w-0">
                    <div class="font-medium" title={r.description || ''}>{r.label || r.name}</div>
                    <div class="font-mono text-xs text-muted-foreground">{r.name}</div>
                  </div>
                </div>
              </td>
              <td class="px-3 py-2">
                <select
                  class="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs"
                  value={r.version}
                  onfocus={() => loadVersions(r.name)}
                  onmouseenter={() => loadVersions(r.name)}
                  onchange={(e) => (chosen[r.name] = e.currentTarget.value)}
                  aria-label="Version of {r.name} to publish"
                >
                  {#each versions[r.name] || [{ version: r.latest, engine: r.engine }] as v}
                    <option value={v.version}>
                      {v.version}{v.version === r.latest ? ' (latest)' : ''}
                    </option>
                  {/each}
                </select>
                {#if r.engine}
                  <div class="text-xs text-muted-foreground mt-0.5" title="Engine version the package requires">
                    engine {r.engine}
                  </div>
                {/if}
                {#if versionsError[r.name]}
                  <div class="text-xs text-red-600 mt-0.5">{versionsError[r.name]}</div>
                {/if}
              </td>
              <td class="px-3 py-2 font-mono text-xs {r.installed ? '' : 'text-muted-foreground'}">
                {r.installed ?? '—'}
              </td>
              <td class="px-3 py-2">
                <span class="inline-block px-2 py-0.5 rounded text-xs font-medium {VERDICT[r.verdict].badge}">
                  {VERDICT[r.verdict].label}
                </span>
              </td>
              <td class="px-3 py-2 text-xs text-muted-foreground max-w-md">
                {#if r.version === r.latest && r.changes.length}
                  <div class="truncate" title={r.changes.join('\n')}>
                    {r.changes[0]}{r.changes.length > 1 ? ` (+${r.changes.length - 1})` : ''}
                  </div>
                {/if}
              </td>
              <td class="px-3 py-2 text-right">
                <Button
                  size="sm"
                  variant={r.verdict === 'downgrade' ? 'outline' : 'default'}
                  disabled={!mayPublish(r.name) || running}
                  title={mayPublish(r.name) ? `Publish ${r.name} ${r.version} to ${instanceHost}` : blocked || 'Not your vendor on this instance'}
                  onclick={() => openDialog([r])}
                >
                  <Upload size={14} class="mr-1.5" />
                  {r.verdict === 'same' ? 'Reinstall' : 'Publish'}
                </Button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

{#if selectedRows.length > 0}
  <div class="sticky bottom-4 z-40 mx-auto w-fit flex items-center gap-4 rounded-lg border bg-background px-4 py-2 shadow-lg text-sm">
    <span>{selectedRows.length} selected</span>
    <Button size="sm" disabled={!!blocked || running} onclick={() => openDialog(selectedRows)}>
      <Upload size={14} class="mr-1.5" /> Publish to {instanceHost}…
    </Button>
    <button type="button" class="text-muted-foreground hover:underline" onclick={() => (selected = {})}>
      Clear
    </button>
  </div>
{/if}

<Dialog bind:open={dialogOpen}>
  <DialogContent class="max-w-3xl max-h-[85vh] overflow-y-auto">
    <DialogHeader>
      <DialogTitle>
        Publish {targets.length} connector{targets.length !== 1 ? 's' : ''} to {dialogInstance.host}
      </DialogTitle>
      <DialogDescription>
        Each package is downloaded from the production marketplace and installed on
        <span class="font-medium text-foreground">{dialogInstance.baseUrl}</span>
        as {instance.username}. Installing replaces the connector's code on the instance right away —
        running flows pick it up.
      </DialogDescription>
    </DialogHeader>

    <div class="border rounded-lg divide-y text-sm">
      {#each targets as t (t.name)}
        <div class="flex items-start gap-3 px-3 py-2">
          <input
            type="checkbox"
            class="mt-1 h-4 w-4 accent-primary cursor-pointer"
            bind:checked={t.include}
            disabled={running || t.state !== 'idle'}
            aria-label="Publish {t.name}"
          />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="font-medium">{t.label}</span>
              <span class="font-mono text-xs text-muted-foreground">{t.name}</span>
            </div>
            <div class="font-mono text-xs">
              {t.installed ?? 'not installed'} → {t.version}
              <span class="ml-2 inline-block px-1.5 py-0.5 rounded font-sans font-medium {VERDICT[t.verdict].badge}">
                {t.verdict === 'same' ? 'Reinstall' : VERDICT[t.verdict].label}
              </span>
            </div>
            {#if t.message}
              <div
                class="text-xs mt-1 break-words {t.state === 'failed'
                  ? 'text-red-600'
                  : t.state === 'done'
                    ? 'text-green-700'
                    : 'text-muted-foreground'}"
              >
                {t.message}
              </div>
            {/if}
          </div>
          <span class="text-xs shrink-0 {t.state === 'failed' ? 'text-red-600' : t.state === 'done' ? 'text-green-700' : 'text-muted-foreground'}">
            {t.state === 'running' ? 'publishing…' : t.state === 'idle' ? '' : t.state}
          </span>
        </div>
      {/each}
    </div>

    {#if targets.some((t) => t.include && t.state === 'idle' && t.verdict === 'downgrade')}
      <p class="flex items-start gap-2 text-sm text-red-700">
        <TriangleAlert size={16} class="mt-0.5 shrink-0" />
        A ticked connector goes back to an older version than the instance has.
      </p>
    {/if}

    {#if finished}
      <p class="text-sm">
        {done} published{failed ? `, ${failed} failed` : ''}.
        <a href={instance.uiUrl} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-blue-600 hover:underline">
          Open the instance <ExternalLink size={12} />
        </a>
      </p>
    {/if}

    <DialogFooter>
      {#if running}
        <Button variant="outline" onclick={() => (stopRequested = true)} disabled={stopRequested}>
          {stopRequested ? 'Stopping after this one…' : 'Stop'}
        </Button>
      {:else}
        <Button variant="outline" onclick={() => (dialogOpen = false)}>Close</Button>
        {#if failed}
          <Button variant="outline" onclick={() => run(true)}>Retry failed ({failed})</Button>
        {/if}
        {#if toRun}
          <Button onclick={() => run(false)}>
            <Upload size={14} class="mr-1.5" /> Publish {toRun} to {dialogInstance.host}
          </Button>
        {/if}
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>
