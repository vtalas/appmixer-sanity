<script>
  import '../app.css';
  import { signOut } from '@auth/sveltekit/client';
  import { Button } from '$lib/components/ui/button';

  let { children, data } = $props();
</script>

<div class="min-h-screen flex flex-col">
  <header class="border-b bg-background">
    <div class="container mx-auto px-4 py-4 flex items-center justify-between">
      <a href="/" class="text-xl font-bold">Appmixer Sanity Check</a>
      <nav class="flex items-center gap-4">
        <a href="/" class="text-sm text-muted-foreground hover:text-foreground">Dashboard</a>
        {#if data.session?.user}
          <span class="text-sm text-muted-foreground">{data.session.user.email}</span>
          <Button variant="outline" size="sm" onclick={() => signOut()}>Sign out</Button>
        {/if}
      </nav>
    </div>
  </header>

  <main class="flex-1 container mx-auto px-4 py-8">
    {@render children?.()}
  </main>

  <footer class="border-t py-4 text-center text-sm text-muted-foreground">
    Appmixer Sanity Check Tracker
  </footer>
</div>
