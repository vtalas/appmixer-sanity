<script>
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Progress } from '$lib/components/ui/progress';
  import { Select } from '$lib/components/ui/select';
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte';
  import ConnectorCard from '$lib/components/connectors/ConnectorCard.svelte';
  import { invalidateAll } from '$app/navigation';
  import { BarChart3 } from 'lucide-svelte';

  let { data } = $props();

  let searchQuery = $state('');
  let statusFilter = $state('all');

  const statusOptions = [
    { value: 'all', label: 'All Statuses' },
    { value: 'pending', label: 'Pending' },
    { value: 'ok', label: 'OK' },
    { value: 'fail', label: 'Fail' },
    { value: 'blocked', label: 'Blocked' }
  ];

  const filteredConnectors = $derived(
    data.connectors.filter((connector) => {
      const matchesSearch =
        searchQuery === '' ||
        connector.connector_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        connector.label?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus = statusFilter === 'all' || connector.status === statusFilter;

      return matchesSearch && matchesStatus;
    })
  );

  const testedCount = $derived(
    data.connectors.filter((c) => c.status !== 'pending').length
  );
  const progress = $derived(
    data.connectors.length > 0 ? (testedCount / data.connectors.length) * 100 : 0
  );

  async function markAsCompleted() {
    try {
      const response = await fetch(`/api/test-runs/${data.testRun.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'completed' })
      });

      if (response.ok) {
        await invalidateAll();
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to update test run');
      }
    } catch (error) {
      console.error('Error updating test run:', error);
      alert('Failed to update test run');
    }
  }
</script>

<svelte:head>
  <title>{data.testRun.name} - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <!-- Breadcrumb -->
  <nav class="text-sm text-muted-foreground">
    <a href="/" class="hover:text-foreground">Dashboard</a>
    <span class="mx-2">/</span>
    <span class="text-foreground">{data.testRun.name}</span>
  </nav>

  <!-- Header -->
  <div class="flex items-start justify-between">
    <div>
      <div class="flex items-center gap-3">
        <h1 class="text-3xl font-bold">{data.testRun.name}</h1>
        <StatusBadge status={data.testRun.status} />
      </div>
      <p class="text-muted-foreground mt-1">
        {data.connectors.length} connectors
      </p>
    </div>

    <div class="flex gap-2">
      <a
        href="/test-runs/{data.testRun.id}/report"
        class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-10 px-4 py-2"
      >
        <BarChart3 class="w-4 h-4 mr-2" />
        View Report
      </a>
      {#if data.testRun.status === 'in_progress'}
        <Button onclick={markAsCompleted}>
          Mark as Completed
        </Button>
      {/if}
    </div>
  </div>

  <!-- Progress -->
  <div class="border rounded-lg p-4 space-y-3">
    <div class="flex justify-between text-sm">
      <span class="text-muted-foreground">Testing Progress</span>
      <span>{testedCount} / {data.connectors.length} connectors tested</span>
    </div>
    <Progress value={progress} />
    <div class="grid grid-cols-4 gap-4 text-center text-sm">
      <button
        type="button"
        onclick={() => (statusFilter = 'all')}
        class="rounded-md bg-muted p-3 cursor-pointer hover:ring-2 hover:ring-ring transition-all {statusFilter === 'all' ? 'ring-2 ring-ring' : ''}"
      >
        <div class="text-2xl font-bold">{data.connectors.length}</div>
        <div class="text-xs text-muted-foreground">Total</div>
      </button>
      <button
        type="button"
        onclick={() => (statusFilter = 'ok')}
        class="rounded-md bg-green-50 p-3 text-green-700 cursor-pointer hover:ring-2 hover:ring-green-500 transition-all {statusFilter === 'ok' ? 'ring-2 ring-green-500' : ''}"
      >
        <div class="text-2xl font-bold">{data.testRun.ok_count}</div>
        <div class="text-xs">OK</div>
      </button>
      <button
        type="button"
        onclick={() => (statusFilter = 'fail')}
        class="rounded-md bg-red-50 p-3 text-red-700 cursor-pointer hover:ring-2 hover:ring-red-500 transition-all {statusFilter === 'fail' ? 'ring-2 ring-red-500' : ''}"
      >
        <div class="text-2xl font-bold">{data.testRun.fail_count}</div>
        <div class="text-xs">Fail</div>
      </button>
      <button
        type="button"
        onclick={() => (statusFilter = 'blocked')}
        class="rounded-md bg-yellow-50 p-3 text-yellow-700 cursor-pointer hover:ring-2 hover:ring-yellow-500 transition-all {statusFilter === 'blocked' ? 'ring-2 ring-yellow-500' : ''}"
      >
        <div class="text-2xl font-bold">{data.testRun.blocked_count}</div>
        <div class="text-xs">Blocked</div>
      </button>
    </div>
  </div>

  <!-- Filters -->
  <div class="flex gap-4">
    <Input
      placeholder="Search connectors..."
      bind:value={searchQuery}
      class="max-w-sm"
    />
    <Select options={statusOptions} bind:value={statusFilter} class="w-40" />
  </div>

  <!-- Connectors Grid -->
  {#if filteredConnectors.length === 0}
    <div class="text-center py-12 border rounded-lg bg-muted/50">
      <p class="text-muted-foreground">No connectors match your filters</p>
    </div>
  {:else}
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {#each filteredConnectors as connector (connector.id)}
        <ConnectorCard {connector} testRunId={data.testRun.id} />
      {/each}
    </div>
  {/if}
</div>
