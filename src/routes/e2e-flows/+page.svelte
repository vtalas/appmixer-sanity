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

  // Page loading state
  let isRefreshing = $state(false);

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
      isRefreshing = true;
      await invalidateAll();
      isRefreshing = false;
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
        isRefreshing = true;
        await invalidateAll();
        isRefreshing = false;
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
      isRefreshing = true;
      await invalidateAll();
      isRefreshing = false;
    } catch (e) {
      appmixerSettingsError = 'Failed to save settings';
    } finally {
      isSavingAppmixerSettings = false;
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
    match: { label: 'In Sync', class: 'bg-green-100 text-green-800 border-green-200', description: 'Flow matches the GitHub repository' },
    modified: { label: 'Modified', class: 'bg-yellow-100 text-yellow-800 border-yellow-200', description: 'Changes on instance, needs to be pushed to git' },
    server_only: { label: 'Server Only', class: 'bg-blue-100 text-blue-800 border-blue-200', description: 'Flow is not in the GitHub repository' },
    error: { label: 'Error', class: 'bg-red-100 text-red-800 border-red-200', description: 'Failed to compare flow' }
  };
</script>

<style>
  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(400%);
    }
  }
  .animate-indeterminate {
    animation: indeterminate 1.5s ease-in-out infinite;
  }
</style>

<svelte:head>
  <title>E2E Test Flows - Appmixer Sanity Check</title>
</svelte:head>

{#if isRefreshing}
  <!-- Loading indicator (same as layout navigation) -->
  <div class="flex flex-col items-center justify-center py-12 gap-4">
    <div class="w-64 h-2 bg-secondary rounded-full overflow-hidden">
      <div class="h-full w-1/4 bg-primary rounded-full animate-indeterminate"></div>
    </div>
    <span class="text-sm text-muted-foreground">Loading...</span>
  </div>
{:else}
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
        <div class="text-sm font-medium text-green-600">In Sync</div>
        <div class="text-xs text-green-600/80 mt-1">{syncStatusConfig.match.description}</div>
      </button>
      <button
        type="button"
        onclick={() => syncFilter = syncFilter === 'modified' ? '' : 'modified'}
        class="border rounded-lg p-4 bg-yellow-50 text-left hover:bg-yellow-100 transition-colors cursor-pointer {syncFilter === 'modified' ? 'ring-2 ring-yellow-500' : ''}"
      >
        <div class="text-2xl font-bold text-yellow-700">{data.stats.modified}</div>
        <div class="text-sm font-medium text-yellow-600">Modified</div>
        <div class="text-xs text-yellow-600/80 mt-1">{syncStatusConfig.modified.description}</div>
      </button>
      <button
        type="button"
        onclick={() => syncFilter = syncFilter === 'server_only' ? '' : 'server_only'}
        class="border rounded-lg p-4 bg-blue-50 text-left hover:bg-blue-100 transition-colors cursor-pointer {syncFilter === 'server_only' ? 'ring-2 ring-blue-500' : ''}"
      >
        <div class="text-2xl font-bold text-blue-700">{data.stats.serverOnly}</div>
        <div class="text-sm font-medium text-blue-600">Server Only</div>
        <div class="text-xs text-blue-600/80 mt-1">{syncStatusConfig.server_only.description}</div>
      </button>
      <button
        type="button"
        onclick={() => syncFilter = syncFilter === 'error' ? '' : 'error'}
        class="border rounded-lg p-4 bg-red-50 text-left hover:bg-red-100 transition-colors cursor-pointer {syncFilter === 'error' ? 'ring-2 ring-red-500' : ''}"
      >
        <div class="text-2xl font-bold text-red-700">{data.stats.error}</div>
        <div class="text-sm font-medium text-red-600">Errors</div>
        <div class="text-xs text-red-600/80 mt-1">{syncStatusConfig.error.description}</div>
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
{/if}

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
            class="px-3 py-1 text-xs rounded-full border transition-colors {appmixerBaseUrl === 'https://api-appmixer-dev-dev-automated-00001.tenants.infra.appmixer.ai' ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted hover:bg-muted/80 border-border'}"
            onclick={() => appmixerBaseUrl = 'https://api-appmixer-dev-dev-automated-00001.tenants.infra.appmixer.ai'}
            disabled={isSavingAppmixerSettings || clearAppmixerCredentials}
          >
            Dev Automated
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
