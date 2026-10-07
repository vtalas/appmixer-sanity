<script>
  import '../app.css';
  import { signOut } from '@auth/sveltekit/client';
  import { Button } from '$lib/components/ui/button';
  import { navigating, page } from '$app/stores';

  let { children, data } = $props();

  // /public/* pages are customer-facing: no app header, navigation or footer
  let bare = $derived($page.url.pathname.startsWith('/public/'));
</script>

<style>
  @keyframes indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(400%);
    }
  }
  .animate-indeterminate {
    animation: indeterminate 1.5s ease-in-out infinite;
  }
</style>

{#if bare}
  {@render children?.()}
{:else}
<div class="min-h-screen flex flex-col">
  <header class="border-b bg-background">
    <div class="container mx-auto px-4 py-4 flex items-center justify-between">
      <a href="/" class="text-xl font-bold">Appmixer Sanity Check</a>
      <!-- Every page but /login needs a session, so the menu is for signed-in users only -->
      {#if data.session?.user}
      <nav class="flex items-center gap-4">
        <a href="/" class="text-sm text-muted-foreground hover:text-foreground">Dashboard</a>
        <a href="/e2e-flows" class="text-sm text-muted-foreground hover:text-foreground">E2E Flows</a>
        <a href="/prs" class="text-sm text-muted-foreground hover:text-foreground">PRs</a>
        <a href="/releases" class="text-sm text-muted-foreground hover:text-foreground">Release</a>
        <a href="/statistics" class="text-sm text-muted-foreground hover:text-foreground">Statistics</a>
        <a href="/authub" class="text-sm text-muted-foreground hover:text-foreground">Auth Hub</a>
        <a href="/automation-hub" class="text-sm text-muted-foreground hover:text-foreground">Automation Hub</a>
        <a href="/ops" class="text-sm text-muted-foreground hover:text-foreground">Operations</a>
        <a href="/settings" class="text-sm text-muted-foreground hover:text-foreground">Settings</a>
        <span class="text-sm text-muted-foreground">{data.session.user.email}</span>
        <Button variant="outline" size="sm" onclick={() => signOut()}>Sign out</Button>
      </nav>
      {/if}
    </div>
  </header>

  <main class="flex-1 container mx-auto px-4 py-8">
    {#if $navigating}
      <div class="flex flex-col items-center justify-center py-12 gap-4">
        <div class="w-64 h-2 bg-secondary rounded-full overflow-hidden">
          <div class="h-full w-1/4 bg-primary rounded-full animate-indeterminate"></div>
        </div>
        <span class="text-sm text-muted-foreground">Loading...</span>
      </div>
    {:else}
      {@render children?.()}
    {/if}
  </main>

  <footer class="border-t py-4 text-center text-sm text-muted-foreground">
    Appmixer Sanity Check Tracker
  </footer>
</div>
{/if}
