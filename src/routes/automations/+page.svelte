<script>
  import { ExternalLink, RefreshCw } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';

  const SOURCE = 'https://github.com/Appmixer-ai/appmixer-components/pull/3034';
  let src = $state('/automations/map');
  let loading = $state(true);

  function refresh() {
    loading = true;
    src = '/automations/map?refresh=' + Date.now();
  }
</script>

<svelte:head>
  <title>Automations - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-3xl font-bold">Automations</h1>
      <p class="text-muted-foreground mt-1">
        What each automation around appmixer-connectors does: what starts it, what it does, what comes out.
        Generated in appmixer-components (<code>docs/automations</code>); read from
        <a href={SOURCE} target="_blank" rel="noopener" class="underline">PR #3034</a> until it is merged.
      </p>
    </div>
    <div class="flex gap-2 shrink-0">
      <Button variant="outline" onclick={refresh} disabled={loading}>
        <RefreshCw size={15} class="mr-2 {loading ? 'animate-spin' : ''}" />Refresh
      </Button>
      <a
        href="/automations/map"
        target="_blank"
        rel="noopener"
        class="inline-flex h-10 items-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
      >
        <ExternalLink size={15} class="mr-2" />Full screen
      </a>
    </div>
  </div>

  <iframe
    title="Automation map"
    {src}
    onload={() => (loading = false)}
    class="w-full rounded-lg border bg-white"
    style="height: calc(100vh - 220px); min-height: 600px;"
  ></iframe>
</div>
