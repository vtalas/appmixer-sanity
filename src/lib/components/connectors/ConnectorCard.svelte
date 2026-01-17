<script>
  import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '$lib/components/ui/card';
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte';

  let { connector, testRunId } = $props();

  const testedCount = $derived(connector.ok_count + connector.fail_count);
</script>

<a href="/test-runs/{testRunId}/{connector.id}" class="block">
  <Card class="hover:shadow-md transition-shadow cursor-pointer h-full">
    <CardHeader class="pb-3">
      <div class="flex items-start gap-3">
        {#if connector.icon}
          <img src={connector.icon} alt="" class="w-10 h-10 rounded" />
        {:else}
          <div class="w-10 h-10 rounded bg-muted flex items-center justify-center text-xs font-bold">
            {connector.label?.charAt(0) || '?'}
          </div>
        {/if}
        <div class="flex-1 min-w-0">
          <CardTitle class="text-base truncate">{connector.label || connector.connector_name}</CardTitle>
          <CardDescription class="text-xs truncate">{connector.connector_name}</CardDescription>
        </div>
        <StatusBadge status={connector.status} />
      </div>
    </CardHeader>

    <CardContent class="pt-0">
      <div class="flex items-center justify-between text-sm text-muted-foreground">
        <span>v{connector.version}</span>
        <span>{testedCount} / {connector.component_count} tested</span>
      </div>

      {#if connector.status === 'blocked' && connector.blocked_reason}
        <div class="mt-2 text-xs text-yellow-700 bg-yellow-50 rounded p-2 truncate">
          {connector.blocked_reason}
        </div>
      {/if}
    </CardContent>
  </Card>
</a>
