<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { invalidateAll } from '$app/navigation';

  let { data } = $props();

  // GitHub settings
  let settingsOwner = $state(data.githubInfo?.owner || '');
  let settingsRepo = $state(data.githubInfo?.repo || '');
  let settingsBranch = $state(data.githubInfo?.branch || '');
  let settingsToken = $state('');
  let clearCustomToken = $state(false);
  let isSavingGithub = $state(false);
  let githubMessage = $state('');

  // Appmixer settings
  let appmixerBaseUrl = $state(data.appmixerInfo?.baseUrl || '');
  let appmixerUsername = $state(data.appmixerInfo?.username || '');
  let appmixerPassword = $state('');
  let clearAppmixerCredentials = $state(false);
  let isSavingAppmixer = $state(false);
  let appmixerMessage = $state('');

  const repoOptions = [
    { value: 'appmixer-connectors', label: 'appmixer-connectors' },
    { value: 'appmixer-components', label: 'appmixer-components' }
  ];

  const branchOptions = [
    { value: 'dev', label: 'dev' },
    { value: 'master', label: 'master' }
  ];

  async function saveGithubSettings() {
    if (!settingsOwner.trim() || !settingsRepo.trim() || !settingsBranch.trim()) {
      githubMessage = 'error:All fields are required';
      return;
    }

    isSavingGithub = true;
    githubMessage = '';

    try {
      const res = await fetch('/api/settings/github', {
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

      if (!res.ok) {
        const error = await res.json();
        githubMessage = `error:${error.error || 'Failed to save'}`;
      } else {
        githubMessage = 'ok:GitHub settings saved';
        settingsToken = '';
        clearCustomToken = false;
        await invalidateAll();
      }
    } catch {
      githubMessage = 'error:Failed to save settings';
    } finally {
      isSavingGithub = false;
    }
  }

  async function saveAppmixerSettings() {
    if (clearAppmixerCredentials) {
      isSavingAppmixer = true;
      appmixerMessage = '';
      try {
        const res = await fetch('/api/settings/appmixer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearCredentials: true })
        });
        if (!res.ok) {
          const error = await res.json();
          appmixerMessage = `error:${error.error || 'Failed to clear'}`;
        } else {
          appmixerMessage = 'ok:Credentials cleared, using environment defaults';
          clearAppmixerCredentials = false;
          await invalidateAll();
        }
      } catch {
        appmixerMessage = 'error:Failed to clear credentials';
      } finally {
        isSavingAppmixer = false;
      }
      return;
    }

    if (!appmixerBaseUrl.trim() || !appmixerUsername.trim()) {
      appmixerMessage = 'error:Base URL and username are required';
      return;
    }

    isSavingAppmixer = true;
    appmixerMessage = '';

    try {
      const res = await fetch('/api/settings/appmixer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: appmixerBaseUrl.trim(),
          username: appmixerUsername.trim(),
          password: appmixerPassword.trim()
        })
      });

      if (!res.ok) {
        const error = await res.json();
        appmixerMessage = `error:${error.error || 'Failed to save'}`;
      } else {
        appmixerMessage = 'ok:Appmixer settings saved';
        appmixerPassword = '';
        await invalidateAll();
      }
    } catch {
      appmixerMessage = 'error:Failed to save settings';
    } finally {
      isSavingAppmixer = false;
    }
  }
</script>

<div class="space-y-8 max-w-2xl">
  <div>
    <h1 class="text-2xl font-bold">Settings</h1>
    <p class="text-muted-foreground">Configure GitHub and Appmixer connections</p>
  </div>

  <!-- GitHub Settings -->
  <div class="rounded-lg border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">GitHub Repository</h2>
      <p class="text-sm text-muted-foreground">Repository and branch used for version comparison and E2E flow sync</p>
    </div>

    <div class="space-y-2">
      <label for="owner" class="text-sm font-medium">Owner</label>
      <Input
        id="owner"
        placeholder="e.g., Appmixer-ai"
        bind:value={settingsOwner}
        disabled={isSavingGithub}
      />
    </div>

    <div class="space-y-2">
      <label for="repo" class="text-sm font-medium">Repository</label>
      <div class="flex gap-2 mb-2">
        {#each repoOptions as opt}
          <button
            type="button"
            class="px-3 py-1 text-xs rounded-full border transition-colors {settingsRepo === opt.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted hover:bg-muted/80 border-border'}"
            onclick={() => settingsRepo = opt.value}
            disabled={isSavingGithub}
          >
            {opt.label}
          </button>
        {/each}
      </div>
      <Input
        id="repo"
        placeholder="Or enter custom repo name..."
        bind:value={settingsRepo}
        disabled={isSavingGithub}
      />
    </div>

    <div class="space-y-2">
      <label for="branch" class="text-sm font-medium">Branch</label>
      <div class="flex gap-2 mb-2">
        {#each branchOptions as opt}
          <button
            type="button"
            class="px-3 py-1 text-xs rounded-full border transition-colors {settingsBranch === opt.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted hover:bg-muted/80 border-border'}"
            onclick={() => settingsBranch = opt.value}
            disabled={isSavingGithub}
          >
            {opt.label}
          </button>
        {/each}
      </div>
      <Input
        id="branch"
        placeholder="Or enter custom branch..."
        bind:value={settingsBranch}
        disabled={isSavingGithub}
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
        disabled={isSavingGithub || clearCustomToken}
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
          Using token from environment variable. Enter a new token to override.
        {:else}
          No token configured. Create one at <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">github.com/settings/tokens</a>
        {/if}
      </p>
      {#if clearCustomToken}
        <p class="text-xs text-amber-600">Custom token will be cleared on save.</p>
      {/if}
    </div>

    {#if githubMessage}
      <p class="text-sm {githubMessage.startsWith('error:') ? 'text-destructive' : 'text-green-600'}">
        {githubMessage.replace(/^(error:|ok:)/, '')}
      </p>
    {/if}

    <Button onclick={saveGithubSettings} disabled={isSavingGithub}>
      {isSavingGithub ? 'Saving...' : 'Save GitHub Settings'}
    </Button>
  </div>

  <!-- Appmixer Settings -->
  <div class="rounded-lg border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">Appmixer Instance</h2>
      <p class="text-sm text-muted-foreground">Appmixer instance used for fetching E2E test flows</p>
    </div>

    <div class="space-y-2">
      <label for="appmixer-url" class="text-sm font-medium">Base URL</label>
      <div class="flex flex-wrap gap-2 mb-2">
        <button
          type="button"
          class="px-3 py-1 text-xs rounded-full border transition-colors {appmixerBaseUrl === 'https://api-dev-automated-00001.dev.appmixer.ai' ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted hover:bg-muted/80 border-border'}"
          onclick={() => appmixerBaseUrl = 'https://api-dev-automated-00001.dev.appmixer.ai'}
          disabled={isSavingAppmixer || clearAppmixerCredentials}
        >
          QA
        </button>
        <button
          type="button"
          class="px-3 py-1 text-xs rounded-full border transition-colors {appmixerBaseUrl === 'https://api.clientio.appmixer.cloud' ? 'bg-primary text-primary-foreground border-primary' : 'bg-muted hover:bg-muted/80 border-border'}"
          onclick={() => appmixerBaseUrl = 'https://api.clientio.appmixer.cloud'}
          disabled={isSavingAppmixer || clearAppmixerCredentials}
        >
          ClientIO Cloud
        </button>
      </div>
      <Input
        id="appmixer-url"
        placeholder="Or enter custom URL..."
        bind:value={appmixerBaseUrl}
        disabled={isSavingAppmixer || clearAppmixerCredentials}
      />
    </div>

    <div class="space-y-2">
      <label for="appmixer-username" class="text-sm font-medium">Username</label>
      <Input
        id="appmixer-username"
        placeholder="e.g., user@example.com"
        bind:value={appmixerUsername}
        disabled={isSavingAppmixer || clearAppmixerCredentials}
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
        disabled={isSavingAppmixer || clearAppmixerCredentials}
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
          No credentials configured.
        {/if}
      </p>
      {#if clearAppmixerCredentials}
        <p class="text-xs text-amber-600">Custom credentials will be cleared on save.</p>
      {/if}
    </div>

    {#if appmixerMessage}
      <p class="text-sm {appmixerMessage.startsWith('error:') ? 'text-destructive' : 'text-green-600'}">
        {appmixerMessage.replace(/^(error:|ok:)/, '')}
      </p>
    {/if}

    <Button onclick={saveAppmixerSettings} disabled={isSavingAppmixer}>
      {isSavingAppmixer ? 'Saving...' : 'Save Appmixer Settings'}
    </Button>
  </div>
</div>
