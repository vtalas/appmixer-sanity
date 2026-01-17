<script>
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Progress } from '$lib/components/ui/progress';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte';
  import ComponentRow from '$lib/components/components/ComponentRow.svelte';
  import { invalidateAll } from '$app/navigation';

  let { data } = $props();

  let showBlockedDialog = $state(false);
  let blockedReason = $state('');
  let isUpdating = $state(false);

  $effect(() => {
    blockedReason = data.connector.blocked_reason || '';
  });

  const testedCount = $derived(
    data.components.filter((c) => c.status !== 'pending').length
  );
  const progress = $derived(
    data.components.length > 0 ? (testedCount / data.components.length) * 100 : 0
  );
  const okCount = $derived(data.components.filter((c) => c.status === 'ok').length);
  const failCount = $derived(data.components.filter((c) => c.status === 'fail').length);

  async function updateConnectorStatus(status, reason = null) {
    isUpdating = true;
    try {
      const body = { status };
      if (status === 'blocked' && reason) {
        body.blockedReason = reason;
      }

      const response = await fetch(`/api/connectors/${data.connector.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (response.ok) {
        showBlockedDialog = false;
        await invalidateAll();
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to update connector');
      }
    } catch (error) {
      console.error('Error updating connector:', error);
      alert('Failed to update connector');
    } finally {
      isUpdating = false;
    }
  }

  function handleSetBlocked() {
    if (!blockedReason.trim()) {
      alert('Please enter a reason for blocking');
      return;
    }
    updateConnectorStatus('blocked', blockedReason.trim());
  }
</script>

<svelte:head>
  <title>{data.connector.label || data.connector.connector_name} - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <!-- Breadcrumb -->
  <nav class="text-sm text-muted-foreground">
    <a href="/" class="hover:text-foreground">Dashboard</a>
    <span class="mx-2">/</span>
    <a href="/test-runs/{data.testRun.id}" class="hover:text-foreground">{data.testRun.name}</a>
    <span class="mx-2">/</span>
    <span class="text-foreground">{data.connector.label || data.connector.connector_name}</span>
  </nav>

  <!-- Header -->
  <div class="flex items-start justify-between">
    <div class="flex items-start gap-4">
      {#if data.connector.icon}
        <img src={data.connector.icon} alt="" class="w-16 h-16 rounded-lg" />
      {:else}
        <div class="w-16 h-16 rounded-lg bg-muted flex items-center justify-center text-2xl font-bold">
          {data.connector.label?.charAt(0) || '?'}
        </div>
      {/if}
      <div>
        <div class="flex items-center gap-3">
          <h1 class="text-3xl font-bold">{data.connector.label || data.connector.connector_name}</h1>
          <StatusBadge status={data.connector.status} />
        </div>
        <p class="text-muted-foreground">{data.connector.connector_name}</p>
        <p class="text-sm text-muted-foreground">Version {data.connector.version}</p>
      </div>
    </div>

    <div class="flex gap-2">
      {#if data.connector.status === 'blocked'}
        <Button variant="outline" onclick={() => updateConnectorStatus('pending')}>
          Unblock
        </Button>
      {:else}
        <Button variant="outline" onclick={() => (showBlockedDialog = true)}>
          Set as Blocked
        </Button>
      {/if}
    </div>
  </div>

  <!-- Blocked Reason -->
  {#if data.connector.status === 'blocked' && data.connector.blocked_reason}
    <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
      <p class="text-sm font-medium text-yellow-800">Blocked Reason:</p>
      <p class="text-yellow-700">{data.connector.blocked_reason}</p>
    </div>
  {/if}

  <!-- Progress -->
  <div class="border rounded-lg p-4 space-y-3">
    <div class="flex justify-between text-sm">
      <span class="text-muted-foreground">Component Testing Progress</span>
      <span>{testedCount} / {data.components.length} components tested</span>
    </div>
    <Progress value={progress} />
    <div class="flex gap-4 text-sm">
      <span class="text-green-600">{okCount} OK</span>
      <span class="text-red-600">{failCount} Fail</span>
      <span class="text-muted-foreground">{data.components.length - testedCount} Pending</span>
    </div>
  </div>

  <!-- Components Table -->
  {#if data.components.length === 0}
    <div class="text-center py-12 border rounded-lg bg-muted/50">
      <p class="text-muted-foreground">No components found for this connector</p>
    </div>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Component</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Actions</TableHead>
          <TableHead>GitHub Issue</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.components as component (component.id)}
          <ComponentRow {component} onStatusChange={invalidateAll} />
        {/each}
      </TableBody>
    </Table>
  {/if}
</div>

<!-- Blocked Dialog -->
<Dialog bind:open={showBlockedDialog}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Set Connector as Blocked</DialogTitle>
      <DialogDescription>
        Mark this connector as blocked when it cannot be tested due to configuration or other issues.
      </DialogDescription>
    </DialogHeader>

    <div class="py-4">
      <Input
        placeholder="Reason for blocking (e.g., Missing API credentials)"
        bind:value={blockedReason}
        disabled={isUpdating}
      />
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => (showBlockedDialog = false)} disabled={isUpdating}>
        Cancel
      </Button>
      <Button onclick={handleSetBlocked} disabled={isUpdating}>
        {isUpdating ? 'Saving...' : 'Set as Blocked'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
