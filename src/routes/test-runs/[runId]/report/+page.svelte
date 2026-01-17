<script>
  import { Progress } from '$lib/components/ui/progress';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { ArrowLeft } from 'lucide-svelte';

  let { data } = $props();

  const componentProgress = $derived(
    data.report.totals.total_components > 0
      ? (data.report.totals.tested_components / data.report.totals.total_components) * 100
      : 0
  );

  const connectorProgress = $derived(
    data.report.totals.total_connectors > 0
      ? (data.report.totals.tested_connectors / data.report.totals.total_connectors) * 100
      : 0
  );

  function formatDate(/** @type {string} */ dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  // Calculate cumulative totals for the daily tables
  const cumulativeComponents = $derived(() => {
    let cumulative = 0;
    return data.report.dailyComponents.map((/** @type {any} */ day) => {
      cumulative += Number(day.components_tested);
      return { ...day, cumulative };
    });
  });

  const cumulativeConnectors = $derived(() => {
    let cumulative = 0;
    return data.report.dailyConnectors.map((/** @type {any} */ day) => {
      cumulative += Number(day.connectors_completed);
      return { ...day, cumulative };
    });
  });
</script>

<svelte:head>
  <title>Report - {data.testRun.name} - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <!-- Breadcrumb -->
  <nav class="text-sm text-muted-foreground">
    <a href="/" class="hover:text-foreground">Dashboard</a>
    <span class="mx-2">/</span>
    <a href="/test-runs/{data.testRun.id}" class="hover:text-foreground">{data.testRun.name}</a>
    <span class="mx-2">/</span>
    <span class="text-foreground">Report</span>
  </nav>

  <!-- Header -->
  <div class="flex items-center gap-4">
    <a
      href="/test-runs/{data.testRun.id}"
      class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 rounded-md px-3"
    >
      <ArrowLeft class="w-4 h-4 mr-2" />
      Back
    </a>
    <div>
      <h1 class="text-3xl font-bold">Daily Report</h1>
      <p class="text-muted-foreground">{data.testRun.name}</p>
    </div>
  </div>

  <!-- Overall Progress -->
  <div class="grid gap-4 md:grid-cols-2">
    <div class="border rounded-lg p-4 space-y-3">
      <h2 class="font-semibold">Components Progress</h2>
      <div class="flex justify-between text-sm">
        <span class="text-muted-foreground">Tested</span>
        <span>{data.report.totals.tested_components} / {data.report.totals.total_components}</span>
      </div>
      <Progress value={componentProgress} />
      <p class="text-xs text-muted-foreground">{componentProgress.toFixed(1)}% complete</p>
    </div>

    <div class="border rounded-lg p-4 space-y-3">
      <h2 class="font-semibold">Connectors Progress</h2>
      <div class="flex justify-between text-sm">
        <span class="text-muted-foreground">Completed</span>
        <span>{data.report.totals.tested_connectors} / {data.report.totals.total_connectors}</span>
      </div>
      <Progress value={connectorProgress} />
      <p class="text-xs text-muted-foreground">{connectorProgress.toFixed(1)}% complete</p>
    </div>
  </div>

  <!-- Daily Components Table -->
  <div class="border rounded-lg p-4 space-y-4">
    <h2 class="font-semibold text-lg">Daily Component Testing</h2>
    {#if data.report.dailyComponents.length === 0}
      <p class="text-muted-foreground text-sm">No components have been tested yet.</p>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead class="text-right">Tested</TableHead>
            <TableHead class="text-right text-green-600">OK</TableHead>
            <TableHead class="text-right text-red-600">Fail</TableHead>
            <TableHead class="text-right">Cumulative</TableHead>
            <TableHead class="text-right">Progress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each cumulativeComponents() as day}
            <TableRow>
              <TableCell class="font-medium">{formatDate(day.date)}</TableCell>
              <TableCell class="text-right">{day.components_tested}</TableCell>
              <TableCell class="text-right text-green-600">{day.components_ok}</TableCell>
              <TableCell class="text-right text-red-600">{day.components_fail}</TableCell>
              <TableCell class="text-right">{day.cumulative}</TableCell>
              <TableCell class="text-right text-muted-foreground">
                {((day.cumulative / data.report.totals.total_components) * 100).toFixed(1)}%
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  </div>

  <!-- Daily Connectors Table -->
  <div class="border rounded-lg p-4 space-y-4">
    <h2 class="font-semibold text-lg">Daily Connector Completion</h2>
    {#if data.report.dailyConnectors.length === 0}
      <p class="text-muted-foreground text-sm">No connectors have been fully tested yet.</p>
    {:else}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead class="text-right">Completed</TableHead>
            <TableHead class="text-right text-green-600">OK</TableHead>
            <TableHead class="text-right text-red-600">Fail</TableHead>
            <TableHead class="text-right text-yellow-600">Blocked</TableHead>
            <TableHead class="text-right">Cumulative</TableHead>
            <TableHead class="text-right">Progress</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each cumulativeConnectors() as day}
            <TableRow>
              <TableCell class="font-medium">{formatDate(day.date)}</TableCell>
              <TableCell class="text-right">{day.connectors_completed}</TableCell>
              <TableCell class="text-right text-green-600">{day.connectors_ok}</TableCell>
              <TableCell class="text-right text-red-600">{day.connectors_fail}</TableCell>
              <TableCell class="text-right text-yellow-600">{day.connectors_blocked}</TableCell>
              <TableCell class="text-right">{day.cumulative}</TableCell>
              <TableCell class="text-right text-muted-foreground">
                {((day.cumulative / data.report.totals.total_connectors) * 100).toFixed(1)}%
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    {/if}
  </div>
</div>
