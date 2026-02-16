<script>
  import { goto } from '$app/navigation';
  import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import { Progress } from '$lib/components/ui/progress';
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte';
  import { Loader2, BarChart3 } from 'lucide-svelte';

  let { testRun, onDelete } = $props();

  let isNavigating = $state(false);

  const testedCount = $derived(testRun.ok_count + testRun.fail_count + testRun.blocked_count);
  const progress = $derived(testRun.connector_count > 0 ? (testedCount / testRun.connector_count) * 100 : 0);

  function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  async function handleViewDetails() {
    isNavigating = true;
    await goto(`/test-runs/${testRun.id}`);
  }

  async function handleDelete() {
    if (confirm('Are you sure you want to delete this test run?')) {
      await onDelete?.(testRun.id);
    }
  }
</script>

<Card class="hover:shadow-md transition-shadow">
  <CardHeader>
    <div class="flex items-start justify-between">
      <div>
        <CardTitle class="text-lg">{testRun.name}</CardTitle>
        <CardDescription>{formatDate(testRun.created_at)}</CardDescription>
      </div>
      <StatusBadge status={testRun.status} />
    </div>
  </CardHeader>

  <CardContent>
    <div class="space-y-4">
      <div>
        <div class="flex justify-between text-sm mb-2">
          <span class="text-muted-foreground">Progress</span>
          <span>{testedCount} / {testRun.connector_count} connectors</span>
        </div>
        <Progress value={progress} />
      </div>

      <div class="grid grid-cols-4 gap-2 text-center text-sm">
        <div class="rounded-md bg-muted p-2">
          <div class="font-semibold">{testRun.connector_count}</div>
          <div class="text-xs text-muted-foreground">Total</div>
        </div>
        <div class="rounded-md bg-green-50 p-2 text-green-700">
          <div class="font-semibold">{testRun.ok_count}</div>
          <div class="text-xs">OK</div>
        </div>
        <div class="rounded-md bg-red-50 p-2 text-red-700">
          <div class="font-semibold">{testRun.fail_count}</div>
          <div class="text-xs">Fail</div>
        </div>
        <div class="rounded-md bg-yellow-50 p-2 text-yellow-700">
          <div class="font-semibold">{testRun.blocked_count}</div>
          <div class="text-xs">Blocked</div>
        </div>
      </div>
    </div>
  </CardContent>

  <CardFooter class="gap-2">
    <Button variant="default" class="flex-1" onclick={handleViewDetails} disabled={isNavigating}>
      {#if isNavigating}
        <Loader2 class="w-4 h-4 mr-2 animate-spin" />
        Loading...
      {:else}
        View Details
      {/if}
    </Button>
    <Button variant="outline" onclick={() => goto(`/test-runs/${testRun.id}/report`)} disabled={isNavigating}>
      <BarChart3 class="w-4 h-4 mr-1" />
      Report
    </Button>
    <Button variant="outline" onclick={handleDelete} disabled={isNavigating}>
      Delete
    </Button>
  </CardFooter>
</Card>
