<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import { invalidateAll } from '$app/navigation';

  let { data } = $props();

  let searchQuery = $state('');
  let connectorFilter = $state('');
  let syncFilter = $state('');

  // GitHub settings dialog
  let showSettingsDialog = $state(false);
  let settingsOwner = $state('');
  let settingsRepo = $state('');
  let settingsBranch = $state('');
  let settingsToken = $state('');
  let clearCustomToken = $state(false);
  let isSavingSettings = $state(false);
  let settingsError = $state('');

  // Initialize settings form when dialog opens
  $effect(() => {
    if (showSettingsDialog && data.githubInfo) {
      settingsOwner = data.githubInfo.owner;
      settingsRepo = data.githubInfo.repo;
      settingsBranch = data.githubInfo.branch;
      settingsToken = '';
      clearCustomToken = false;
      settingsError = '';
    }
  });

  async function saveGitHubSettings() {
    if (!settingsOwner.trim() || !settingsRepo.trim() || !settingsBranch.trim()) {
      settingsError = 'All fields are required';
      return;
    }

    isSavingSettings = true;
    settingsError = '';

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
        settingsError = error.error || 'Failed to save settings';
        return;
      }

      showSettingsDialog = false;
      await invalidateAll();
    } catch (e) {
      settingsError = 'Failed to save settings';
    } finally {
      isSavingSettings = false;
    }
  }

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

  <!-- Source Info -->
  <div class="flex flex-wrap gap-4 text-sm">
    {#if data.appmixerInfo?.baseUrl}
      <div class="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-md">
        <span class="text-muted-foreground">Appmixer:</span>
        <a href={data.appmixerInfo.baseUrl} target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">
          {data.appmixerInfo.baseUrl}
        </a>
        {#if data.appmixerInfo.username}
          <span class="text-muted-foreground">({data.appmixerInfo.username})</span>
        {/if}
      </div>
    {/if}
    {#if data.githubInfo}
      <button
        type="button"
        onclick={() => showSettingsDialog = true}
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
    <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
      <button
        type="button"
        onclick={() => syncFilter = ''}
        class="border rounded-lg p-4 text-left hover:bg-muted/50 transition-colors cursor-pointer {syncFilter === '' ? 'ring-2 ring-primary' : ''}"
      >
        <div class="text-2xl font-bold">{data.stats.total}</div>
        <div class="text-sm text-muted-foreground">Total Flows</div>
      </button>
      <button
        type="button"
        onclick={() => syncFilter = syncFilter === 'match' ? '' : 'match'}
        class="border rounded-lg p-4 bg-green-50 text-left hover:bg-green-100 transition-colors cursor-pointer {syncFilter === 'match' ? 'ring-2 ring-green-500' : ''}"
      >
        <div class="text-2xl font-bold text-green-700">{data.stats.match}</div>
        <div class="text-sm text-green-600">In Sync</div>
      </button>
      <button
        type="button"
        onclick={() => syncFilter = syncFilter === 'modified' ? '' : 'modified'}
        class="border rounded-lg p-4 bg-yellow-50 text-left hover:bg-yellow-100 transition-colors cursor-pointer {syncFilter === 'modified' ? 'ring-2 ring-yellow-500' : ''}"
      >
        <div class="text-2xl font-bold text-yellow-700">{data.stats.modified}</div>
        <div class="text-sm text-yellow-600">Modified</div>
      </button>
      <button
        type="button"
        onclick={() => syncFilter = syncFilter === 'server_only' ? '' : 'server_only'}
        class="border rounded-lg p-4 bg-blue-50 text-left hover:bg-blue-100 transition-colors cursor-pointer {syncFilter === 'server_only' ? 'ring-2 ring-blue-500' : ''}"
      >
        <div class="text-2xl font-bold text-blue-700">{data.stats.serverOnly}</div>
        <div class="text-sm text-blue-600">Server Only</div>
      </button>
      <button
        type="button"
        onclick={() => syncFilter = syncFilter === 'error' ? '' : 'error'}
        class="border rounded-lg p-4 bg-red-50 text-left hover:bg-red-100 transition-colors cursor-pointer {syncFilter === 'error' ? 'ring-2 ring-red-500' : ''}"
      >
        <div class="text-2xl font-bold text-red-700">{data.stats.error}</div>
        <div class="text-sm text-red-600">Errors</div>
      </button>
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

<!-- GitHub Settings Dialog -->
<Dialog bind:open={showSettingsDialog}>
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
          disabled={isSavingSettings}
        />
      </div>

      <div class="space-y-2">
        <label for="repo" class="text-sm font-medium">Repository</label>
        <Input
          id="repo"
          placeholder="e.g., appmixer-connectors"
          bind:value={settingsRepo}
          disabled={isSavingSettings}
        />
      </div>

      <div class="space-y-2">
        <label for="branch" class="text-sm font-medium">Branch</label>
        <Input
          id="branch"
          placeholder="e.g., dev"
          bind:value={settingsBranch}
          disabled={isSavingSettings}
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
          disabled={isSavingSettings || clearCustomToken}
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

      {#if settingsError}
        <p class="text-sm text-destructive">{settingsError}</p>
      {/if}
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => showSettingsDialog = false} disabled={isSavingSettings}>
        Cancel
      </Button>
      <Button onclick={saveGitHubSettings} disabled={isSavingSettings}>
        {isSavingSettings ? 'Saving...' : 'Save'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
