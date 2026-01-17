<script>
  import { TableRow, TableCell } from '$lib/components/ui/table';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte';

  let { component, onStatusChange } = $props();

  let githubIssue = $state('');
  let isUpdating = $state(false);

  $effect(() => {
    githubIssue = component.github_issue || '';
  });

  async function setStatus(status) {
    isUpdating = true;
    try {
      const body = { status };
      if (status === 'fail' && githubIssue) {
        body.githubIssue = githubIssue;
      }

      const response = await fetch(`/api/components/${component.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        onStatusChange?.();
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to update status');
      }
    } catch (error) {
      console.error('Error updating component:', error);
      alert('Failed to update status');
    } finally {
      isUpdating = false;
    }
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
    <span class="text-xs text-muted-foreground">{component.description || '-'}</span>
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

  <TableCell>
    {#if component.status === 'fail'}
      <Input
        type="url"
        placeholder="GitHub issue URL"
        bind:value={githubIssue}
        class="text-xs h-8"
        onblur={() => githubIssue && setStatus('fail')}
      />
    {:else if component.github_issue}
      <a href={component.github_issue} target="_blank" rel="noopener noreferrer" class="text-xs text-blue-600 hover:underline truncate block max-w-[200px]">
        {component.github_issue}
      </a>
    {:else}
      <span class="text-xs text-muted-foreground">-</span>
    {/if}
  </TableCell>
</TableRow>
