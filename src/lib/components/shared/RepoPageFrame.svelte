<script>
  import { ExternalLink, RefreshCw } from 'lucide-svelte';
  import { Button } from '$lib/components/ui/button';

  /** A page generated in a repository, shown in a frame: `src` is the route that serves it. */
  let { title, src, children } = $props();

  let bust = $state(0);
  let frameSrc = $derived(bust ? src + '?refresh=' + bust : src);
  let loading = $state(true);

  function refresh() {
    loading = true;
    bust = Date.now();
  }
</script>

<div class="space-y-4">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-3xl font-bold">{title}</h1>
      <p class="text-muted-foreground mt-1">{@render children?.()}</p>
    </div>
    <div class="flex gap-2 shrink-0">
      <Button variant="outline" onclick={refresh} disabled={loading}>
        <RefreshCw size={15} class="mr-2 {loading ? 'animate-spin' : ''}" />Refresh
      </Button>
      <a
        href={src}
        target="_blank"
        rel="noopener"
        class="inline-flex h-10 items-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
      >
        <ExternalLink size={15} class="mr-2" />Full screen
      </a>
    </div>
  </div>

  <iframe
    {title}
    src={frameSrc}
    onload={() => (loading = false)}
    class="w-full rounded-lg border bg-white"
    style="height: calc(100vh - 220px); min-height: 600px;"
  ></iframe>
</div>
