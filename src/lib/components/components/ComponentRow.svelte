<script>
  import { TableRow, TableCell } from '$lib/components/ui/table';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte';
  import { ExternalLink, Plus, X } from 'lucide-svelte';

  let { component, onStatusChange, onSaving, onSaved } = $props();

  let githubIssues = $state([]);
  let newIssueUrl = $state('');
  let isUpdating = $state(false);
  let showAddInput = $state(false);

  $effect(() => {
    try {
      githubIssues = component.github_issues ? JSON.parse(component.github_issues) : [];
    } catch {
      githubIssues = [];
    }
  });

  // Extract issue number from GitHub URL
  function getIssueNumber(url) {
    const match = url?.match(/\/issues\/(\d+)/);
    return match ? `#${match[1]}` : null;
  }

  async function setStatus(/** @type {string} */ status, /** @type {string[] | undefined} */ issues = undefined, /** @type {string | undefined} */ savingMessage = undefined) {
    isUpdating = true;
    const componentLabel = component.label || component.component_name.split('.').pop();
    const defaultMessage = issues !== undefined ? 'Updating GitHub issues...' : `Setting ${componentLabel} to ${status}...`;
    onSaving?.(savingMessage || defaultMessage);
    try {
      /** @type {{ status: string, githubIssues?: string[] }} */
      const body = { status };
      if (issues !== undefined) {
        body.githubIssues = issues;
      }

      const response = await fetch(`/api/components/${component.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        const savedMessage = issues !== undefined ? 'GitHub issues updated' : `${componentLabel} marked as ${status}`;
        onSaved?.(savedMessage);
        onStatusChange?.();
      } else {
        const error = await response.json();
        onSaved?.('');
        alert(error.error || 'Failed to update status');
      }
    } catch (error) {
      console.error('Error updating component:', error);
      onSaved?.('');
      alert('Failed to update status');
    } finally {
      isUpdating = false;
    }
  }

  async function addIssue() {
    if (!newIssueUrl.trim()) return;
    const updatedIssues = [...githubIssues, newIssueUrl.trim()];
    await setStatus(component.status || 'fail', updatedIssues, 'Adding GitHub issue...');
    newIssueUrl = '';
    showAddInput = false;
  }

  async function removeIssue(/** @type {number} */ index) {
    const updatedIssues = githubIssues.filter((/** @type {string} */ _, /** @type {number} */ i) => i !== index);
    await setStatus(component.status, updatedIssues, 'Removing GitHub issue...');
  }
</script>

<TableRow>
  <TableCell>
    <div class="flex items-center gap-2">
      {#if component.icon}
        <img src={component.icon} alt="" class="w-6 h-6 rounded" />
      {/if}
      <div>
        <div class="font-medium">{component.label || component.component_name.split('.').pop()}</div>
        <div class="text-xs text-muted-foreground truncate max-w-xs">{component.component_name}</div>
      </div>
    </div>
  </TableCell>

  <TableCell>
    {#if component.description}
      <span
        class="text-xs text-muted-foreground truncate block max-w-[200px] cursor-help"
        title={component.description}
      >
        {component.description}
      </span>
    {:else}
      <span class="text-xs text-muted-foreground">-</span>
    {/if}
  </TableCell>

  <TableCell>
    <StatusBadge status={component.status} />
  </TableCell>

  <TableCell>
    <div class="flex items-center gap-2">
      <Button
        size="sm"
        variant={component.status === 'ok' ? 'default' : 'outline'}
        disabled={isUpdating}
        onclick={() => setStatus('ok')}
      >
        OK
      </Button>
      <Button
        size="sm"
        variant={component.status === 'fail' ? 'destructive' : 'outline'}
        disabled={isUpdating}
        onclick={() => setStatus('fail')}
      >
        Fail
      </Button>
    </div>
  </TableCell>

  <TableCell class="min-w-[280px]">
    <div class="flex flex-col gap-1">
      {#if githubIssues.length > 0}
        <div class="flex flex-wrap gap-1">
          {#each githubIssues as issue, index}
            <span class="inline-flex items-center gap-1 bg-muted rounded px-1.5 py-0.5">
              <a
                href={issue}
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs text-blue-600 hover:underline"
                title={issue}
              >
                {getIssueNumber(issue) || issue}
                <ExternalLink class="w-3 h-3 inline" />
              </a>
              <button
                type="button"
                onclick={() => removeIssue(index)}
                class="text-muted-foreground hover:text-destructive ml-0.5"
                disabled={isUpdating}
                title="Remove issue"
              >
                <X class="w-3 h-3" />
              </button>
            </span>
          {/each}
        </div>
      {/if}

      {#if showAddInput}
        <div class="flex gap-1">
          <Input
            type="url"
            placeholder="GitHub issue URL"
            bind:value={newIssueUrl}
            class="text-xs h-7 flex-1"
            onkeydown={(/** @type {KeyboardEvent} */ e) => e.key === 'Enter' && addIssue()}
          />
          <Button size="sm" variant="ghost" class="h-7 px-2" onclick={addIssue} disabled={isUpdating}>
            Add
          </Button>
          <Button size="sm" variant="ghost" class="h-7 px-1" onclick={() => { showAddInput = false; newIssueUrl = ''; }}>
            <X class="w-4 h-4" />
          </Button>
        </div>
      {:else}
        <button
          type="button"
          onclick={() => (showAddInput = true)}
          class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Plus class="w-3 h-3" />
          Add issue
        </button>
      {/if}
    </div>
  </TableCell>
</TableRow>
