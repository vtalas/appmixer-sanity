<script>
  import { Progress } from '$lib/components/ui/progress';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { ArrowLeft, ChevronRight, ChevronDown } from 'lucide-svelte';

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
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function formatDateShort(/** @type {string} */ dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /** Check if a date string (YYYY-MM-DD) falls on a weekend */
  function isWeekend(/** @type {string} */ dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  /**
   * Fill in missing dates between the first entry and today.
   * @param {any[]} rows - rows with a `date` field
   * @param {Record<string, any>} emptyRow - template for days with no data
   */
  function fillDateGaps(rows, emptyRow) {
    if (rows.length === 0) return [];
    const byDate = new Map(rows.map(r => [r.date, r]));
    const start = new Date(rows[0].date + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(rows[rows.length - 1].date + 'T00:00:00') > today
      ? new Date(rows[rows.length - 1].date + 'T00:00:00')
      : today;
    const filled = [];
    const current = new Date(start);
    while (current <= end) {
      const key = current.toISOString().slice(0, 10);
      filled.push(byDate.get(key) || { ...emptyRow, date: key });
      current.setDate(current.getDate() + 1);
    }
    return filled;
  }

  /**
   * Group consecutive zero-progress days into collapsible sections.
   * @param {any[]} days - flat array of day rows with cumulative
   * @param {(day: any) => boolean} isZero - predicate for zero-progress day
   * @returns {Array<{type: 'day', day: any} | {type: 'gap', days: any[], weekdays: number, id: string}>}
   */
  function groupZeroDays(days, isZero) {
    /** @type {Array<{type: 'day', day: any} | {type: 'gap', days: any[], weekdays: number, id: string}>} */
    const groups = [];
    let i = 0;
    while (i < days.length) {
      if (isZero(days[i])) {
        const gapDays = [];
        while (i < days.length && isZero(days[i])) {
          gapDays.push(days[i]);
          i++;
        }
        const weekdays = gapDays.filter(d => !isWeekend(d.date)).length;
        groups.push({ type: 'gap', days: gapDays, weekdays, id: gapDays[0].date });
      } else {
        groups.push({ type: 'day', day: days[i] });
        i++;
      }
    }
    return groups;
  }

  // Calculate cumulative totals for the daily tables (with gaps filled)
  const cumulativeComponents = $derived(() => {
    const filled = fillDateGaps(data.report.dailyComponents, {
      components_tested: 0, components_ok: 0, components_fail: 0
    });
    let cumulative = 0;
    return filled.map((/** @type {any} */ day) => {
      cumulative += Number(day.components_tested);
      return { ...day, cumulative };
    });
  });

  const cumulativeConnectors = $derived(() => {
    const filled = fillDateGaps(data.report.dailyConnectors, {
      connectors_completed: 0, connectors_ok: 0, connectors_fail: 0, connectors_blocked: 0
    });
    let cumulative = 0;
    return filled.map((/** @type {any} */ day) => {
      cumulative += Number(day.connectors_completed);
      return { ...day, cumulative };
    });
  });

  const groupedComponents = $derived(
    groupZeroDays(cumulativeComponents(), (d) => Number(d.components_tested) === 0)
  );

  const groupedConnectors = $derived(
    groupZeroDays(cumulativeConnectors(), (d) => Number(d.connectors_completed) === 0)
  );

  /** @type {Set<string>} */
  let expandedGaps = $state(new Set());

  /** @param {string} id */
  function toggleGap(id) {
    if (expandedGaps.has(id)) {
      expandedGaps.delete(id);
    } else {
      expandedGaps.add(id);
    }
    expandedGaps = new Set(expandedGaps);
  }
</script>

<svelte:head>
  <title>Report - {data.testRun.name} - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <!-- Breadcrumb -->
  <nav class="text-sm text-muted-foreground">
    <a href="/test-runs" class="hover:text-foreground">Test Runs</a>
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
          {#each groupedComponents as group}
            {#if group.type === 'day'}
              <TableRow class={isWeekend(group.day.date) ? 'bg-muted/50' : ''}>
                <TableCell class="font-medium">{formatDate(group.day.date)}</TableCell>
                <TableCell class="text-right">{group.day.components_tested}</TableCell>
                <TableCell class="text-right text-green-600">{group.day.components_ok}</TableCell>
                <TableCell class="text-right text-red-600">{group.day.components_fail}</TableCell>
                <TableCell class="text-right">{group.day.cumulative}</TableCell>
                <TableCell class="text-right text-muted-foreground">
                  {((group.day.cumulative / data.report.totals.total_components) * 100).toFixed(1)}%
                </TableCell>
              </TableRow>
            {:else}
              <TableRow
                class="cursor-pointer hover:bg-muted/30"
                onclick={() => toggleGap('comp-' + group.id)}
              >
                <TableCell colspan={6} class="text-muted-foreground text-sm py-1.5">
                  <span class="inline-flex items-center gap-1">
                    {#if expandedGaps.has('comp-' + group.id)}
                      <ChevronDown class="w-3.5 h-3.5" />
                    {:else}
                      <ChevronRight class="w-3.5 h-3.5" />
                    {/if}
                    {group.weekdays} {group.weekdays === 1 ? 'day' : 'days'} with no progress
                    <span class="text-xs">({formatDateShort(group.days[0].date)} &ndash; {formatDateShort(group.days[group.days.length - 1].date)})</span>
                  </span>
                </TableCell>
              </TableRow>
              {#if expandedGaps.has('comp-' + group.id)}
                {#each group.days as day}
                  <TableRow class="{isWeekend(day.date) ? 'bg-muted/50' : ''} opacity-60">
                    <TableCell class="font-medium">{formatDate(day.date)}</TableCell>
                    <TableCell class="text-right text-muted-foreground">0</TableCell>
                    <TableCell class="text-right text-muted-foreground">0</TableCell>
                    <TableCell class="text-right text-muted-foreground">0</TableCell>
                    <TableCell class="text-right">{day.cumulative}</TableCell>
                    <TableCell class="text-right text-muted-foreground">
                      {((day.cumulative / data.report.totals.total_components) * 100).toFixed(1)}%
                    </TableCell>
                  </TableRow>
                {/each}
              {/if}
            {/if}
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
          {#each groupedConnectors as group}
            {#if group.type === 'day'}
              <TableRow class={isWeekend(group.day.date) ? 'bg-muted/50' : ''}>
                <TableCell class="font-medium">{formatDate(group.day.date)}</TableCell>
                <TableCell class="text-right">{group.day.connectors_completed}</TableCell>
                <TableCell class="text-right text-green-600">{group.day.connectors_ok}</TableCell>
                <TableCell class="text-right text-red-600">{group.day.connectors_fail}</TableCell>
                <TableCell class="text-right text-yellow-600">{group.day.connectors_blocked}</TableCell>
                <TableCell class="text-right">{group.day.cumulative}</TableCell>
                <TableCell class="text-right text-muted-foreground">
                  {((group.day.cumulative / data.report.totals.total_connectors) * 100).toFixed(1)}%
                </TableCell>
              </TableRow>
            {:else}
              <TableRow
                class="cursor-pointer hover:bg-muted/30"
                onclick={() => toggleGap('conn-' + group.id)}
              >
                <TableCell colspan={7} class="text-muted-foreground text-sm py-1.5">
                  <span class="inline-flex items-center gap-1">
                    {#if expandedGaps.has('conn-' + group.id)}
                      <ChevronDown class="w-3.5 h-3.5" />
                    {:else}
                      <ChevronRight class="w-3.5 h-3.5" />
                    {/if}
                    {group.weekdays} {group.weekdays === 1 ? 'day' : 'days'} with no progress
                    <span class="text-xs">({formatDateShort(group.days[0].date)} &ndash; {formatDateShort(group.days[group.days.length - 1].date)})</span>
                  </span>
                </TableCell>
              </TableRow>
              {#if expandedGaps.has('conn-' + group.id)}
                {#each group.days as day}
                  <TableRow class="{isWeekend(day.date) ? 'bg-muted/50' : ''} opacity-60">
                    <TableCell class="font-medium">{formatDate(day.date)}</TableCell>
                    <TableCell class="text-right text-muted-foreground">0</TableCell>
                    <TableCell class="text-right text-muted-foreground">0</TableCell>
                    <TableCell class="text-right text-muted-foreground">0</TableCell>
                    <TableCell class="text-right text-muted-foreground">0</TableCell>
                    <TableCell class="text-right">{day.cumulative}</TableCell>
                    <TableCell class="text-right text-muted-foreground">
                      {((day.cumulative / data.report.totals.total_connectors) * 100).toFixed(1)}%
                    </TableCell>
                  </TableRow>
                {/each}
              {/if}
            {/if}
          {/each}
        </TableBody>
      </Table>
    {/if}
  </div>
</div>
