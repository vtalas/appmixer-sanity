<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';

  let { data } = $props();

  let search = $state('');
  /** @type {Set<string>} */
  let statusFilter = $state(new Set());
  /** @type {Record<string, {version?: string, icon?: string, label?: string}>} */
  let cachedInfo = $state(data.cachedInfo || {});
  /** @type {Record<string, string>} */
  let statuses = $state(data.statuses || {});
  /** @type {Record<string, boolean>} */
  let bundleLoading = $state({});
  let fetchAllRunning = $state(false);
  let fetchAllProgress = $state({ done: 0, total: 0 });

  // Upload (admin only)
  let uploadDialogOpen = $state(false);
  /** @type {File|null} */
  let uploadFile = $state(null);
  let uploadDragOver = $state(false);
  let uploading = $state(false);
  /** @type {'idle'|'uploading'|'polling'|'done'|'error'} */
  let uploadStatus = $state('idle');
  let uploadMessage = $state('');

  /** @param {File} file */
  function setUploadFile(file) {
    if (!file.name.endsWith('.zip')) {
      uploadMessage = 'Only .zip files are supported';
      return;
    }
    uploadFile = file;
    uploadMessage = '';
  }

  async function doUpload() {
    if (!uploadFile) return;
    uploading = true;
    uploadStatus = 'uploading';
    uploadMessage = `Uploading ${uploadFile.name}...`;

    try {
      const res = await fetch('/api/auth-hub/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: uploadFile
      });
      const data = await res.json();
      if (!res.ok) {
        uploadStatus = 'error';
        uploadMessage = data.error || 'Upload failed';
        uploading = false;
        return;
      }

      const { ticket } = data;
      uploadStatus = 'polling';
      uploadMessage = 'Processing...';

      // Poll for completion
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const pollRes = await fetch(`/api/auth-hub/upload?ticket=${encodeURIComponent(ticket)}`);
        if (!pollRes.ok) continue;
        const status = await pollRes.json();
        console.log(`[upload poll ${i + 1}]`, status);

        if (status.finished || status.status === 'finished' || status.status === 'done' || status.completed) {
          uploadStatus = 'done';
          uploadMessage = 'Upload complete!';
          uploading = false;
          if (viewServiceId) {
            try {
              const refreshRes = await fetch('/api/auth-hub/bundle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serviceId: viewServiceId })
              });
              const refreshResult = await refreshRes.json();
              if (refreshRes.ok && refreshResult.version) {
                cachedInfo = { ...cachedInfo, [viewServiceId]: { ...cachedInfo[viewServiceId], version: refreshResult.version } };
              }
            } catch { /* ignore */ }
          }
          return;
        }
        if (status.status === 'error' || status.error) {
          uploadStatus = 'error';
          uploadMessage = status.error || status.message || 'Upload processing failed';
          uploading = false;
          return;
        }
        if (status.progress !== undefined) {
          uploadMessage = `Processing... ${status.progress || ''}`;
        }
      }

      uploadStatus = 'error';
      uploadMessage = 'Timed out waiting for upload to complete';
    } catch (err) {
      uploadStatus = 'error';
      uploadMessage = /** @type {Error} */ (err).message;
    } finally {
      uploading = false;
    }
  }

  function resetUpload() {
    uploadFile = null;
    uploadStatus = 'idle';
    uploadMessage = '';
    uploadDragOver = false;
  }

  // Upload New (admin only) — service name + config + bundle
  let uploadNewDialogOpen = $state(false);
  let uploadNewServiceId = $state('');
  /** @type {Record<string, string>} */
  let uploadNewConfig = $state({});
  let uploadNewConfigKey = $state('');
  let uploadNewConfigValue = $state('');
  /** @type {File|null} */
  let uploadNewFile = $state(null);
  let uploadNewDragOver = $state(false);
  /** @type {'form'|'checking'|'confirm'|'saving'|'uploading'|'polling'|'done'|'error'} */
  let uploadNewStep = $state('form');
  let uploadNewMessage = $state('');

  function resetUploadNew() {
    uploadNewServiceId = '';
    uploadNewConfig = {};
    uploadNewConfigKey = '';
    uploadNewConfigValue = '';
    uploadNewFile = null;
    uploadNewDragOver = false;
    uploadNewStep = 'form';
    uploadNewMessage = '';
  }

  /** @param {File} file */
  function setUploadNewFile(file) {
    if (!file.name.endsWith('.zip')) { uploadNewMessage = 'Only .zip files are supported'; return; }
    uploadNewFile = file;
    uploadNewMessage = '';
  }

  async function doUploadNew(force = false) {
    const sid = uploadNewServiceId.trim();
    if (!sid) { uploadNewMessage = 'Service name is required'; return; }

    if (!force) {
      // Check if config already exists
      uploadNewStep = 'checking';
      uploadNewMessage = '';
      try {
        const res = await fetch(`/api/auth-hub/service-config?serviceId=${encodeURIComponent(sid)}`);
        if (res.ok) {
          // Exists — ask to confirm
          uploadNewStep = 'confirm';
          return;
        }
      } catch { /* treat as not found */ }
    }

    // Save config first (if any keys)
    if (Object.keys(uploadNewConfig).length > 0) {
      uploadNewStep = 'saving';
      uploadNewMessage = 'Saving service config...';
      const body = Object.fromEntries(
        Object.entries(uploadNewConfig).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch { return [k, v]; } })
      );
      // Always include serviceId in config
      if (!body.serviceId) body.serviceId = sid;
      const res = await fetch('/api/auth-hub/service-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: sid, config: body })
      });
      if (!res.ok) {
        const r = await res.json();
        uploadNewStep = 'error';
        uploadNewMessage = r.error || 'Failed to save config';
        return;
      }
    }

    // Upload bundle (if file selected)
    if (uploadNewFile) {
      uploadNewStep = 'uploading';
      uploadNewMessage = `Uploading ${uploadNewFile.name}...`;
      try {
        const res = await fetch('/api/auth-hub/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: uploadNewFile
        });
        const result = await res.json();
        if (!res.ok) { uploadNewStep = 'error'; uploadNewMessage = result.error || 'Upload failed'; return; }

        const { ticket } = result;
        uploadNewStep = 'polling';
        uploadNewMessage = 'Processing...';
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const pollRes = await fetch(`/api/auth-hub/upload?ticket=${encodeURIComponent(ticket)}`);
          if (!pollRes.ok) continue;
          const status = await pollRes.json();
          console.log(`[upload-new poll ${i + 1}]`, status);
          if (status.finished || status.status === 'finished' || status.status === 'done' || status.completed) break;
          if (status.status === 'error' || status.error) {
            uploadNewStep = 'error';
            uploadNewMessage = status.error || status.message || 'Upload processing failed';
            return;
          }
          if (status.progress !== undefined) uploadNewMessage = `Processing... ${status.progress || ''}`;
        }
      } catch (err) {
        uploadNewStep = 'error';
        uploadNewMessage = /** @type {Error} */ (err).message;
        return;
      }
    }

    uploadNewStep = 'done';
    uploadNewMessage = 'Done!';
    // Add to connector list if not already there
    if (!data.connectors.find(c => c.serviceId === sid)) {
      data.connectors = [...data.connectors, { serviceId: sid }];
    }
    // Refresh bundle info
    try {
      const r = await fetch('/api/auth-hub/bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: sid })
      });
      const result = await r.json();
      if (r.ok && result.version) cachedInfo = { ...cachedInfo, [sid]: { ...cachedInfo[sid], version: result.version } };
    } catch { /* ignore */ }
  }

  // View connector details popup
  const WHITELIST_EXCLUDED = new Set(['serviceId', 'clientId', 'clientSecret']);

  /** @type {string|null} */
  let viewServiceId = $state(null);
  let viewDialogOpen = $state(false);
  /** @type {Record<string, unknown>|null} */
  let viewServiceConfig = $state(null);
  /** @type {Set<string>} */
  let viewWhitelistKeys = $state(new Set());
  let viewLoading = $state(false);
  let viewError = $state('');

  let viewEditMode = $state(false);
  /** @type {Record<string, string>} */
  let viewEditConfig = $state({});
  let configSaving = $state(false);
  let configSaveError = $state('');
  let newConfigKey = $state('');
  let newConfigValue = $state('');
  /** @type {Record<string, boolean>} */
  let whitelistAdding = $state({});
  /** @type {Record<string, boolean>} */
  let whitelistRemoving = $state({});

  /** @param {string} serviceId */
  async function openView(serviceId) {
    viewServiceId = serviceId;
    viewServiceConfig = null;
    viewWhitelistKeys = new Set();
    viewEditMode = false;
    viewError = '';
    viewLoading = true;
    viewDialogOpen = true;
    await refreshView(serviceId);
    viewLoading = false;
  }

  /** @param {string} serviceId */
  async function refreshView(serviceId) {
    try {
      const [configRes, whitelistRes, bundleRes] = await Promise.all([
        fetch(`/api/auth-hub/service-config?serviceId=${encodeURIComponent(serviceId)}`),
        fetch(`/api/auth-hub/service-config?serviceId=${encodeURIComponent(serviceId)}&whitelist=1`),
        fetch('/api/auth-hub/bundle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceId })
        })
      ]);
      const configResult = await configRes.json();
      if (!configRes.ok) {
        viewError = configResult.error || `Error ${configRes.status}`;
      } else {
        viewServiceConfig = configResult;
      }
      if (whitelistRes.ok) {
        const wl = await whitelistRes.json();
        viewWhitelistKeys = new Set(Array.isArray(wl) ? wl : Object.keys(wl));
      }
      if (bundleRes.ok) {
        const bundleResult = await bundleRes.json();
        if (bundleResult.version) {
          cachedInfo = { ...cachedInfo, [serviceId]: { ...cachedInfo[serviceId], ...bundleResult } };
        }
      }
    } catch (err) {
      viewError = /** @type {Error} */ (err).message;
    }
  }

  function enterEditMode() {
    if (viewServiceConfig) {
      viewEditConfig = Object.fromEntries(
        Object.entries(viewServiceConfig).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')])
      );
    }
    configSaveError = '';
    newConfigKey = '';
    newConfigValue = '';
    viewEditMode = true;
  }

  async function saveServiceConfig() {
    if (!viewServiceId) return;
    configSaving = true;
    configSaveError = '';
    try {
      const body = Object.fromEntries(
        Object.entries(viewEditConfig).map(([k, v]) => {
          try { return [k, JSON.parse(v)]; } catch { return [k, v]; }
        })
      );
      const res = await fetch(`/api/auth-hub/service-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: viewServiceId, config: body })
      });
      const result = await res.json();
      if (!res.ok) {
        configSaveError = result.error || `Error ${res.status}`;
      } else {
        viewServiceConfig = body;
        viewEditMode = false;
      }
    } catch (err) {
      configSaveError = /** @type {Error} */ (err).message;
    } finally {
      configSaving = false;
    }
  }

  /** @param {string} key */
  async function addToWhitelist(key) {
    if (!viewServiceId) return;
    whitelistAdding = { ...whitelistAdding, [key]: true };
    try {
      const res = await fetch(`/api/auth-hub/service-config/whitelist-key`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: viewServiceId, key, value: null })
      });
      if (res.ok) await refreshView(viewServiceId);
    } catch { /* ignore */ } finally {
      whitelistAdding = { ...whitelistAdding, [key]: false };
    }
  }

  /** @param {string} key */
  async function removeFromWhitelist(key) {
    if (!viewServiceId) return;
    whitelistRemoving = { ...whitelistRemoving, [key]: true };
    try {
      const res = await fetch(`/api/auth-hub/service-config/whitelist-key`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: viewServiceId, key })
      });
      if (res.ok) await refreshView(viewServiceId);
    } catch { /* ignore */ } finally {
      whitelistRemoving = { ...whitelistRemoving, [key]: false };
    }
  }

  /** @param {string} serviceId */
  function downloadBundle(serviceId) {
    const selector = serviceId.replaceAll(':', '.');
    window.open(`/api/auth-hub/bundle-download?serviceId=${encodeURIComponent(serviceId)}`, '_blank');
  }

  // Delete confirm (admin only)
  /** @type {string|null} */
  let deleteServiceId = $state(null);
  let deleteDialogOpen = $state(false);
  let deleting = $state(false);
  let deleteError = $state('');

  // GitHub versions (admin only)
  /** @type {Record<string, {version: string, path: string}>} */
  let githubVersions = $state({});
  let githubLoading = $state(false);
  let githubLoaded = $state(false);

  let filteredConnectors = $derived(
    data.connectors.filter(c => {
      if (search) {
        const q = search.toLowerCase();
        if (!(c.serviceId || '').toLowerCase().includes(q)) return false;
      }
      if (statusFilter.size > 0) {
        const s = statuses[c.serviceId] || 'not_verified';
        if (!statusFilter.has(s)) return false;
      }
      return true;
    })
  );

  /** @param {string} serviceId */
  function shortName(serviceId) {
    if (!serviceId) return '';
    const parts = serviceId.split(':');
    return parts.length > 1 ? parts.slice(1).join(':') : serviceId;
  }

  async function fetchAll() {
    fetchAllRunning = true;
    const ids = data.connectors.map(c => c.serviceId).filter(Boolean);
    fetchAllProgress = { done: 0, total: ids.length };

    for (const serviceId of ids) {
      bundleLoading = { ...bundleLoading, [serviceId]: true };
      try {
        const res = await fetch('/api/auth-hub/bundle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceId })
        });
        const result = await res.json();
        if (res.ok && result.version) {
          cachedInfo = { ...cachedInfo, [serviceId]: { ...cachedInfo[serviceId], version: result.version } };
        }
      } catch { /* continue */ }
      bundleLoading = { ...bundleLoading, [serviceId]: false };
      fetchAllProgress = { done: fetchAllProgress.done + 1, total: ids.length };
    }

    try {
      const cacheRes = await fetch('/api/auth-hub/bundle?env=prod');
      if (cacheRes.ok) {
        cachedInfo = await cacheRes.json();
      }
    } catch { /* ignore */ }

    fetchAllRunning = false;
  }

  async function fetchGitHubVersions() {
    githubLoading = true;
    try {
      const res = await fetch('/api/auth-hub/github-versions');
      if (res.ok) {
        githubVersions = await res.json();
        githubLoaded = true;
      }
    } catch { /* ignore */ }
    githubLoading = false;
  }

  /**
   * @param {string} serviceId
   * @param {string} status
   */
  async function updateStatus(serviceId, status) {
    statuses = { ...statuses, [serviceId]: status };
    try {
      await fetch('/api/auth-hub/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId, status })
      });
    } catch { /* ignore */ }
  }

  async function confirmDelete() {
    if (!deleteServiceId) return;
    deleting = true;
    deleteError = '';
    try {
      const res = await fetch('/api/auth-hub/connector', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: deleteServiceId })
      });
      const result = await res.json();
      if (!res.ok) {
        deleteError = result.error || 'Delete failed';
        return;
      }
      // Remove from local state
      data.connectors = data.connectors.filter(c => c.serviceId !== deleteServiceId);
      cachedInfo = Object.fromEntries(Object.entries(cachedInfo).filter(([k]) => k !== deleteServiceId));
      deleteServiceId = null;
      deleteDialogOpen = false;
    } catch {
      deleteError = 'Delete failed';
    } finally {
      deleting = false;
    }
  }

  /**
   * @param {string|undefined} authhubVersion
   * @param {string|undefined} githubVersion
   * @returns {'outdated'|'newer'|'match'|null}
   */
  function compareVersions(authhubVersion, githubVersion) {
    if (!authhubVersion || !githubVersion) return null;
    const a = authhubVersion.split('.').map(Number);
    const g = githubVersion.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, g.length); i++) {
      const av = a[i] || 0;
      const gv = g[i] || 0;
      if (av < gv) return 'outdated';
      if (av > gv) return 'newer';
    }
    return 'match';
  }
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Auth Hub</h1>
      <p class="text-muted-foreground">Browse connectors registered in Auth Hub</p>
      {#if data.isAdmin && data.githubInfo}
        <p class="text-xs text-muted-foreground mt-1">
          GitHub: <a href={data.githubInfo.url} target="_blank" class="underline hover:text-foreground">{data.githubInfo.owner}/{data.githubInfo.repo}</a> ({data.githubInfo.branch})
          · <a href="/settings" class="underline hover:text-foreground">Settings</a>
        </p>
      {/if}
    </div>
    <div class="flex items-center gap-3">
      <Badge variant="secondary">{filteredConnectors.length} connectors</Badge>
      {#if !data.error}
        <Button
          variant="outline"
          size="sm"
          onclick={fetchAll}
          disabled={fetchAllRunning}
        >
          {#if fetchAllRunning}
            Fetching {fetchAllProgress.done}/{fetchAllProgress.total}...
          {:else}
            Refresh
          {/if}
        </Button>
        {#if data.isAdmin}
          <Button
            variant="outline"
            size="sm"
            onclick={fetchGitHubVersions}
            disabled={githubLoading}
          >
            {#if githubLoading}
              Loading GitHub...
            {:else if githubLoaded}
              Reload GitHub
            {:else}
              Compare with GitHub
            {/if}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onclick={() => { resetUploadNew(); uploadNewDialogOpen = true; }}
          >
            Upload New
          </Button>
        {/if}
      {/if}
    </div>
  </div>

  {#if data.error}
    <div class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-destructive">
      <p>{data.error}</p>
    </div>
  {:else}
    <div class="flex items-center gap-3">
      <div class="max-w-sm flex-1">
        <Input
          placeholder="Search connectors..."
          bind:value={search}
        />
      </div>
      <div class="flex items-center gap-1">
        {#each [{ value: 'not_verified', label: '\u274c Not Verified' }, { value: 'in_progress', label: '\u23f3 In Progress' }, { value: 'verified', label: '\u2705 Verified' }] as opt}
          <button
            class="h-8 px-3 rounded-md border text-xs transition-colors {statusFilter.has(opt.value) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input text-muted-foreground hover:bg-muted'}"
            onclick={() => {
              const next = new Set(statusFilter);
              next.has(opt.value) ? next.delete(opt.value) : next.add(opt.value);
              statusFilter = next;
            }}
          >
            {opt.label}
          </button>
        {/each}
      </div>
    </div>

    {#if filteredConnectors.length === 0}
      <div class="text-center py-12 border rounded-lg bg-muted/50">
        <p class="text-muted-foreground">No connectors found</p>
      </div>
    {:else}
      <div class="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-10"><span></span></TableHead>
              <TableHead>Connector</TableHead>
              <TableHead class="w-28">Auth Hub</TableHead>
              {#if githubLoaded}
                <TableHead class="w-28">GitHub</TableHead>
              {/if}
              <TableHead class="w-40">Status</TableHead>
              <TableHead class="w-20"><span></span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each filteredConnectors as connector}
              {@const info = cachedInfo[connector.serviceId]}
              {@const currentStatus = statuses[connector.serviceId] || 'not_verified'}
              {@const ghInfo = githubVersions[connector.serviceId]}
              {@const cmp = compareVersions(info?.version, ghInfo?.version)}
              <TableRow>
                <TableCell>
                  {#if info?.icon}
                    <img src={info.icon} alt="" class="w-5 h-5 object-contain" />
                  {:else}
                    <div class="w-5 h-5 rounded bg-muted flex items-center justify-center text-xs text-muted-foreground">
                      {(shortName(connector.serviceId) || '?')[0].toUpperCase()}
                    </div>
                  {/if}
                </TableCell>
                <TableCell>
                  <div class="flex items-baseline gap-2">
                    <span class="font-medium">{info?.label || shortName(connector.serviceId)}</span>
                    <span class="text-xs text-muted-foreground">{connector.serviceId}</span>
                  </div>
                </TableCell>
                <TableCell>
                  {#if bundleLoading[connector.serviceId]}
                    <span class="text-xs text-muted-foreground">loading...</span>
                  {:else if info?.version}
                    <span class="tabular-nums {cmp === 'outdated' ? 'text-red-600 font-semibold' : ''}">v{info.version}</span>
                  {:else}
                    <span class="text-muted-foreground">—</span>
                  {/if}
                </TableCell>
                {#if githubLoaded}
                  <TableCell>
                    {#if ghInfo?.version}
                      <span class="tabular-nums {cmp === 'outdated' ? 'text-green-600 font-semibold' : ''}">v{ghInfo.version}</span>
                      {#if cmp === 'outdated'}
                        <span class="ml-1 text-xs text-red-600" title="Auth Hub version is outdated">⚠️</span>
                      {:else if cmp === 'match'}
                        <span class="ml-1 text-xs text-green-600">✓</span>
                      {/if}
                    {:else}
                      <span class="text-muted-foreground text-xs">not in repo</span>
                    {/if}
                  </TableCell>
                {/if}
                <TableCell>
                  <select
                    class="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    value={currentStatus}
                    onchange={(/** @type {Event} */ e) => updateStatus(connector.serviceId, /** @type {HTMLSelectElement} */ (e.target).value)}
                  >
                    <option value="not_verified">{'\u274c'} Not Verified</option>
                    <option value="in_progress">{'\u23f3'} In Progress</option>
                    <option value="verified">{'\u2705'} Verified</option>
                  </select>
                </TableCell>
                <TableCell>
                  {#if data.isAdmin}
                    <button
                      class="text-xs text-muted-foreground hover:text-foreground transition-colors underline"
                      onclick={() => openView(connector.serviceId)}
                    >
                      Details
                    </button>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  {/if}
</div>

<!-- Upload New Dialog -->
<Dialog bind:open={uploadNewDialogOpen}>
  <DialogContent class="max-w-xl">
    <DialogHeader>
      <DialogTitle>Upload New Connector</DialogTitle>
      <DialogDescription>Define service name, config properties, and optionally upload a bundle.</DialogDescription>
    </DialogHeader>

    {#if uploadNewStep === 'confirm'}
      <p class="text-sm">Service config for <strong>{uploadNewServiceId}</strong> already exists. Do you want to overwrite it?</p>
      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewStep = 'form'; }}>Cancel</Button>
        <Button variant="destructive" onclick={() => doUploadNew(true)}>Overwrite</Button>
      </DialogFooter>
    {:else if uploadNewStep === 'done'}
      <div class="flex flex-col items-center gap-3 py-6">
        <span class="text-3xl">✅</span>
        <p class="text-sm font-medium text-green-600">{uploadNewMessage}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewDialogOpen = false; }}>Close</Button>
      </DialogFooter>
    {:else if uploadNewStep === 'error'}
      <p class="text-sm text-destructive">{uploadNewMessage}</p>
      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewStep = 'form'; uploadNewMessage = ''; }}>Back</Button>
      </DialogFooter>
    {:else if uploadNewStep !== 'form'}
      <!-- checking / saving / uploading / polling -->
      <div class="flex flex-col items-center gap-3 py-6">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
        <p class="text-sm text-muted-foreground">{uploadNewMessage}</p>
      </div>
    {:else}
      <!-- Form -->
      <div class="space-y-4">
        <!-- Service name -->
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">Service name</label>
          <input
            class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="e.g. appmixer:box"
            bind:value={uploadNewServiceId}
          />
        </div>

        <!-- Config properties -->
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">Config properties</label>
          <div class="space-y-1 rounded-md border p-3">
            {#each Object.keys(uploadNewConfig) as key (key)}
              <div class="flex items-center gap-2">
                <span class="w-32 shrink-0 text-xs text-muted-foreground truncate font-mono" title={key}>{key}</span>
                <input
                  class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  value={uploadNewConfig[key]}
                  oninput={(e) => { uploadNewConfig = { ...uploadNewConfig, [key]: /** @type {HTMLInputElement} */ (e.target).value }; }}
                />
                <button
                  class="shrink-0 text-muted-foreground hover:text-destructive px-1 text-xs"
                  onclick={() => { const c = { ...uploadNewConfig }; delete c[key]; uploadNewConfig = c; }}
                >✕</button>
              </div>
            {/each}
            <div class="flex items-center gap-2 {Object.keys(uploadNewConfig).length > 0 ? 'pt-2 border-t mt-1' : ''}">
              <input
                class="h-7 w-32 shrink-0 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="key"
                bind:value={uploadNewConfigKey}
              />
              <input
                class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="value"
                bind:value={uploadNewConfigValue}
              />
              <button
                class="shrink-0 rounded border border-input px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
                disabled={!uploadNewConfigKey}
                onclick={() => { if (uploadNewConfigKey) { uploadNewConfig = { ...uploadNewConfig, [uploadNewConfigKey]: uploadNewConfigValue }; uploadNewConfigKey = ''; uploadNewConfigValue = ''; } }}
              >+ Add</button>
            </div>
          </div>
        </div>

        <!-- Bundle drop zone -->
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">Bundle (.zip) — optional</label>
          <div
            class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors {uploadNewDragOver ? 'border-primary bg-primary/5' : 'border-input bg-muted/30'}"
            role="region"
            aria-label="File drop zone"
            ondragover={(e) => { e.preventDefault(); uploadNewDragOver = true; }}
            ondragleave={() => { uploadNewDragOver = false; }}
            ondrop={(e) => { e.preventDefault(); uploadNewDragOver = false; const f = e.dataTransfer?.files?.[0]; if (f) setUploadNewFile(f); }}
          >
            {#if uploadNewFile}
              <p class="text-sm font-medium">{uploadNewFile.name}</p>
              <p class="text-xs text-muted-foreground mt-1">{(uploadNewFile.size / 1024).toFixed(1)} KB</p>
              <button class="mt-1 text-xs text-muted-foreground underline hover:text-foreground" onclick={() => { uploadNewFile = null; }}>Remove</button>
            {:else}
              <p class="text-sm text-muted-foreground">Drop .zip here or</p>
              <label class="mt-1 cursor-pointer text-sm text-primary underline hover:text-primary/80">
                browse
                <input type="file" accept=".zip" class="sr-only" onchange={(e) => { const f = /** @type {HTMLInputElement} */ (e.target).files?.[0]; if (f) setUploadNewFile(f); }} />
              </label>
            {/if}
          </div>
          {#if uploadNewMessage}
            <p class="mt-1 text-xs text-destructive">{uploadNewMessage}</p>
          {/if}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewDialogOpen = false; }}>Cancel</Button>
        <Button onclick={() => doUploadNew(false)} disabled={!uploadNewServiceId.trim()}>Upload</Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

<!-- View Connector Dialog -->
<Dialog bind:open={viewDialogOpen}>
  <DialogContent class="max-w-2xl">
    <DialogHeader>
      <DialogTitle>{viewServiceId}</DialogTitle>
      <DialogDescription>Service config from Auth Hub</DialogDescription>
    </DialogHeader>

    {#if viewLoading}
      <div class="flex items-center justify-center py-10">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
      </div>
    {:else if viewError}
      <p class="text-sm text-destructive">{viewError}</p>
    {:else if viewServiceConfig}
      <div class="max-h-[60vh] overflow-y-auto space-y-4 pr-1">
        <!-- Service Config -->
        <div>
          <p class="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Service Config</p>
          {#if viewEditMode}
            <div class="space-y-1 rounded-md border p-3">
              {#each Object.keys(viewEditConfig) as key (key)}
                <div class="flex items-center gap-2">
                  <span class="w-36 shrink-0 text-xs text-muted-foreground truncate" title={key}>{key}</span>
                  <input
                    class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                    value={viewEditConfig[key]}
                    oninput={(e) => { viewEditConfig = { ...viewEditConfig, [key]: /** @type {HTMLInputElement} */ (e.target).value }; }}
                  />
                  <button
                    class="shrink-0 text-muted-foreground hover:text-destructive px-1 text-xs"
                    title="Remove property"
                    onclick={() => { const c = { ...viewEditConfig }; delete c[key]; viewEditConfig = c; }}
                  >✕</button>
                </div>
              {/each}
              <!-- Add new property row -->
              <div class="flex items-center gap-2 pt-2 border-t mt-2">
                <input
                  class="h-7 w-36 shrink-0 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="key"
                  bind:value={newConfigKey}
                />
                <input
                  class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  placeholder="value"
                  bind:value={newConfigValue}
                />
                <button
                  class="shrink-0 rounded border border-input px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
                  disabled={!newConfigKey}
                  onclick={() => { if (newConfigKey) { viewEditConfig = { ...viewEditConfig, [newConfigKey]: newConfigValue }; newConfigKey = ''; newConfigValue = ''; } }}
                >+ Add</button>
              </div>
            </div>
            {#if configSaveError}
              <p class="mt-1 text-xs text-destructive">{configSaveError}</p>
            {/if}
            <Button size="sm" class="mt-2" onclick={saveServiceConfig} disabled={configSaving}>
              {configSaving ? 'Saving...' : 'Save Config'}
            </Button>
          {:else}
            <!-- Read-only view with Add to Whitelist buttons -->
            <div class="space-y-1 rounded-md border p-3">
              {#each Object.entries(viewServiceConfig) as [key, val]}
                <div class="flex items-center gap-2">
                  <span class="w-36 shrink-0 text-xs text-muted-foreground truncate" title={key}>{key}</span>
                  <span class="flex-1 text-xs font-mono truncate">{typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}</span>
                  {#if !WHITELIST_EXCLUDED.has(key)}
                    {#if viewWhitelistKeys.has(key)}
                      <button
                        class="shrink-0 text-xs text-green-600 hover:text-destructive disabled:opacity-40"
                        title="Remove from whitelist"
                        disabled={whitelistRemoving[key]}
                        onclick={() => removeFromWhitelist(key)}
                      >{whitelistRemoving[key] ? '...' : '✓ whitelisted'}</button>
                    {:else}
                      <button
                        class="shrink-0 rounded border border-input px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
                        disabled={whitelistAdding[key]}
                        onclick={() => addToWhitelist(key)}
                      >{whitelistAdding[key] ? '...' : '+ Whitelist'}</button>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Whitelist (read-only) -->
        <div>
          <p class="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Whitelisted keys</p>
          {#if viewWhitelistKeys.size === 0}
            <p class="text-xs text-muted-foreground italic">None</p>
          {:else}
            <div class="flex flex-wrap gap-1">
              {#each [...viewWhitelistKeys] as key}
                <span class="rounded bg-muted px-2 py-0.5 text-xs font-mono">{key}</span>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <DialogFooter class="flex-wrap gap-2">
      <Button
        variant="outline"
        onclick={() => { if (viewServiceId) downloadBundle(viewServiceId); }}
        disabled={viewLoading}
      >
        Download Bundle
      </Button>
      {#if data.isAdmin}
        {#if !viewEditMode}
          <Button variant="outline" onclick={enterEditMode} disabled={viewLoading}>Edit</Button>
        {:else}
          <Button variant="outline" onclick={() => { viewEditMode = false; }} disabled={configSaving}>Cancel Edit</Button>
        {/if}
        <Button
          variant="outline"
          onclick={() => { resetUpload(); viewDialogOpen = false; uploadDialogOpen = true; }}
          disabled={viewLoading}
        >
          Upload Bundle
        </Button>
        <Button
          variant="destructive"
          onclick={() => { if (viewServiceId) { deleteServiceId = viewServiceId; deleteError = ''; viewDialogOpen = false; deleteDialogOpen = true; } }}
          disabled={viewLoading}
        >
          Delete
        </Button>
      {/if}
      <Button variant="outline" onclick={() => { viewDialogOpen = false; }}>Close</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Upload Bundle Dialog -->
<Dialog bind:open={uploadDialogOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Upload Bundle</DialogTitle>
      <DialogDescription>
        {viewServiceId ? `Uploading bundle for ${viewServiceId}` : 'Drop a .zip connector bundle or click to select a file.'}
      </DialogDescription>
    </DialogHeader>

    {#if uploadStatus === 'idle' || uploadStatus === 'error'}
      <!-- Drop zone -->
      <div
        class="mt-2 flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors {uploadDragOver ? 'border-primary bg-primary/5' : 'border-input bg-muted/30'}"
        role="region"
        aria-label="File drop zone"
        ondragover={(e) => { e.preventDefault(); uploadDragOver = true; }}
        ondragleave={() => { uploadDragOver = false; }}
        ondrop={(e) => {
          e.preventDefault();
          uploadDragOver = false;
          const file = e.dataTransfer?.files?.[0];
          if (file) setUploadFile(file);
        }}
      >
        {#if uploadFile}
          <p class="text-sm font-medium">{uploadFile.name}</p>
          <p class="text-xs text-muted-foreground mt-1">{(uploadFile.size / 1024).toFixed(1)} KB</p>
          <button class="mt-2 text-xs text-muted-foreground underline hover:text-foreground" onclick={() => { uploadFile = null; uploadMessage = ''; }}>
            Remove
          </button>
        {:else}
          <p class="text-sm text-muted-foreground">Drop .zip here or</p>
          <label class="mt-2 cursor-pointer text-sm text-primary underline hover:text-primary/80">
            browse
            <input
              type="file"
              accept=".zip"
              class="sr-only"
              onchange={(e) => {
                const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
                if (file) setUploadFile(file);
              }}
            />
          </label>
        {/if}
      </div>
      {#if uploadMessage}
        <p class="text-sm {uploadStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}">{uploadMessage}</p>
      {/if}
    {:else}
      <!-- Progress -->
      <div class="flex flex-col items-center gap-3 py-6">
        {#if uploadStatus === 'done'}
          <span class="text-3xl">✅</span>
          <p class="text-sm font-medium text-green-600">{uploadMessage}</p>
        {:else}
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
          <p class="text-sm text-muted-foreground">{uploadMessage}</p>
        {/if}
      </div>
    {/if}

    <DialogFooter>
      <Button variant="outline" onclick={() => { uploadDialogOpen = false; }} disabled={uploading}>
        {uploadStatus === 'done' ? 'Close' : 'Cancel'}
      </Button>
      {#if uploadStatus === 'idle' || uploadStatus === 'error'}
        <Button onclick={doUpload} disabled={!uploadFile || uploading}>
          Upload
        </Button>
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Delete Confirm Dialog -->
<Dialog bind:open={deleteDialogOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Delete Connector</DialogTitle>
      <DialogDescription>
        This will permanently delete the service config and bundle for <strong>{deleteServiceId}</strong> from Auth Hub. This action cannot be undone.
      </DialogDescription>
    </DialogHeader>
    {#if deleteError}
      <p class="text-sm text-destructive">{deleteError}</p>
    {/if}
    <DialogFooter>
      <Button variant="outline" onclick={() => { deleteDialogOpen = false; deleteServiceId = null; }} disabled={deleting}>
        Cancel
      </Button>
      <Button variant="destructive" onclick={confirmDelete} disabled={deleting}>
        {deleting ? 'Deleting...' : 'Delete'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
