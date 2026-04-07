<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';
  import { Select } from '$lib/components/ui/select';

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

  const statusOptions = [
    { value: 'not_verified', label: '\u274c Not Verified' },
    { value: 'verified', label: '\u2705 Verified' }
  ];

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

    // Reload cache to get icons and labels
    try {
      const cacheRes = await fetch('/api/auth-hub/bundle?env=prod');
      if (cacheRes.ok) {
        cachedInfo = await cacheRes.json();
      }
    } catch { /* ignore */ }

    fetchAllRunning = false;
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
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">Auth Hub</h1>
      <p class="text-muted-foreground">Browse connectors registered in Auth Hub</p>
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
              <TableHead class="w-24">Version</TableHead>
              <TableHead class="w-40">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each filteredConnectors as connector}
              {@const info = cachedInfo[connector.serviceId]}
              {@const currentStatus = statuses[connector.serviceId] || 'not_verified'}
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
                    <span class="tabular-nums">v{info.version}</span>
                  {:else}
                    <span class="text-muted-foreground">—</span>
                  {/if}
                </TableCell>
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
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  {/if}
</div>
