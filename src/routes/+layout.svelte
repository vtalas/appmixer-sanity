<script>
  import '../app.css';
  import { signOut } from '@auth/sveltekit/client';
  import { Button } from '$lib/components/ui/button';
  import { navigating, page } from '$app/stores';
  import { sectionOf } from '$lib/sections.js';

  let { children, data } = $props();

  // /public/* pages are customer-facing: no app header, navigation or footer
  let bare = $derived($page.url.pathname.startsWith('/public/'));

  // The sections are cards on the dashboard (/); the header names the one you are in
  let section = $derived(sectionOf($page.url.pathname));
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
    <div class="container mx-auto px-4 py-4 flex items-center justify-between gap-4">
      <nav aria-label="Breadcrumb" class="flex items-baseline gap-2 min-w-0 text-xl">
        <a href="/" class="font-bold shrink-0" title="Dashboard">
          <span class="hidden sm:inline">Appmixer Sanity Check</span>
          <span class="sm:hidden">Sanity Check</span>
        </a>
        {#if section}
          <span class="text-muted-foreground" aria-hidden="true">/</span>
          <a href={section.href} class="truncate text-muted-foreground hover:text-foreground">{section.label}</a>
        {/if}
      </nav>
      <!-- Every page but /login needs a session; the sections are cards on the dashboard -->
      {#if data.session?.user}
      <div class="flex items-center gap-4 shrink-0">
        <span class="hidden md:inline text-sm text-muted-foreground">{data.session.user.email}</span>
        <Button variant="outline" size="sm" onclick={() => signOut()} title={data.session.user.email}>Sign out</Button>
      </div>
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
