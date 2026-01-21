<script>
  import { Input } from '$lib/components/ui/input';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';

  let { data } = $props();

  let searchQuery = $state('');
  let connectorFilter = $state('');
  let syncFilter = $state('');

  // Get unique connectors for filter dropdown
  const connectors = $derived(
    [...new Set(data.flows.map(f => f.connector).filter(Boolean))].sort()
  );

  const filteredFlows = $derived(
    data.flows.filter(flow => {
      const matchesSearch = !searchQuery ||
        flow.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        flow.connector?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesConnector = !connectorFilter || flow.connector === connectorFilter;

      const matchesSync = !syncFilter || flow.syncStatus === syncFilter;

      return matchesSearch && matchesConnector && matchesSync;
    })
  );

  // Sync status configuration
  const syncStatusConfig = {
    match: { label: 'In Sync', class: 'bg-green-100 text-green-800 border-green-200' },
    modified: { label: 'Modified', class: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
    server_only: { label: 'Server Only', class: 'bg-blue-100 text-blue-800 border-blue-200' },
    error: { label: 'Error', class: 'bg-red-100 text-red-800 border-red-200' }
  };
</script>

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

  {#if data.error}
    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
      <p class="text-red-700">{data.error}</p>
    </div>
  {:else}
    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
      <div class="border rounded-lg p-4">
        <div class="text-2xl font-bold">{data.stats.total}</div>
        <div class="text-sm text-muted-foreground">Total Flows</div>
      </div>
      <div class="border rounded-lg p-4 bg-green-50">
        <div class="text-2xl font-bold text-green-700">{data.stats.match}</div>
        <div class="text-sm text-green-600">In Sync</div>
      </div>
      <div class="border rounded-lg p-4 bg-yellow-50">
        <div class="text-2xl font-bold text-yellow-700">{data.stats.modified}</div>
        <div class="text-sm text-yellow-600">Modified</div>
      </div>
      <div class="border rounded-lg p-4 bg-blue-50">
        <div class="text-2xl font-bold text-blue-700">{data.stats.serverOnly}</div>
        <div class="text-sm text-blue-600">Server Only</div>
      </div>
      <div class="border rounded-lg p-4 bg-red-50">
        <div class="text-2xl font-bold text-red-700">{data.stats.error}</div>
        <div class="text-sm text-red-600">Errors</div>
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
        <option value="server_only">Server Only</option>
        <option value="error">Error</option>
      </select>
    </div>

    <!-- Results count -->
    <p class="text-sm text-muted-foreground">
      Showing {filteredFlows.length} of {data.flows.length} flows
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
            <TableHead>Connector</TableHead>
            <TableHead>Flow Name</TableHead>
            <TableHead>Sync Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each filteredFlows as flow (flow.flowId)}
            <TableRow>
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
                {@const config = syncStatusConfig[flow.syncStatus] || syncStatusConfig.error}
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border {config.class}">
                  {config.label}
                </span>
              </TableCell>
              <TableCell>
                <div class="flex gap-3">
                  <a
                    href={flow.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-blue-600 hover:underline text-sm"
                  >
                    Designer
                  </a>
                  {#if flow.githubUrl}
                    <a
                      href={flow.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-gray-600 hover:underline text-sm"
                    >
                      GitHub
                    </a>
                  {/if}
                </div>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  {/if}
</div>
