<script>
  import '../app.css';
  import { signOut } from '@auth/sveltekit/client';
  import { Button } from '$lib/components/ui/button';
  import { navigating, page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { ChevronDown } from 'lucide-svelte';
  import { SECTIONS, sectionOf } from '$lib/sections.js';

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
        {#if data.session?.user}
          <span class="text-muted-foreground" aria-hidden="true">/</span>
          <!-- The current section; pick another one to switch without going through the dashboard -->
          <span class="relative inline-flex min-w-0 items-center">
            <select
              aria-label="Section"
              value={section?.href ?? ''}
              onchange={(e) => e.currentTarget.value && goto(e.currentTarget.value)}
              class="min-w-0 cursor-pointer appearance-none [field-sizing:content] rounded-md border border-transparent bg-transparent py-0.5 pl-1 pr-7 text-xl text-muted-foreground hover:border-input hover:text-foreground focus:border-input focus:outline-none"
            >
              {#if !section}<option value="" disabled>Go to…</option>{/if}
              {#each SECTIONS as s (s.href)}
                <option value={s.href}>{s.label}</option>
              {/each}
            </select>
            <ChevronDown size={18} class="pointer-events-none absolute right-1.5 text-muted-foreground" />
          </span>
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
