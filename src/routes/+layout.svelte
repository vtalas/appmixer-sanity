<script>
  import '../app.css';
  import { signOut } from '@auth/sveltekit/client';
  import { Button } from '$lib/components/ui/button';
  import { navigating, page } from '$app/stores';
  import { goto } from '$app/navigation';

  let { children, data } = $props();

  // /public/* pages are customer-facing: no app header, navigation or footer
  let bare = $derived($page.url.pathname.startsWith('/public/'));

  const navItems = [
    { href: '/', label: 'Dashboard' },
    { href: '/e2e-flows', label: 'E2E Flows' },
    { href: '/prs', label: 'PRs' },
    { href: '/releases', label: 'Release' },
    { href: '/statistics', label: 'Statistics' },
    { href: '/authub', label: 'Auth Hub' },
    { href: '/automation-hub', label: 'Automation Hub' },
    { href: '/ops', label: 'Operations' },
    { href: '/settings', label: 'Settings' }
  ];

  // The page the mobile select shows: the item whose path the URL starts with;
  // everything else (test runs and their connectors) belongs to the Dashboard
  let currentNav = $derived(
    navItems.find((item) => item.href !== '/' && $page.url.pathname.startsWith(item.href))?.href ?? '/'
  );
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
      <a href="/" class="text-xl font-bold shrink-0">
        <span class="hidden sm:inline">Appmixer Sanity Check</span>
        <span class="sm:hidden">Sanity Check</span>
      </a>
      <!-- Every page but /login needs a session, so the menu is for signed-in users only -->
      {#if data.session?.user}
      <!-- Narrow screens: the pages in a select (native picker on phones) -->
      <nav class="flex items-center gap-2 min-w-0 xl:hidden">
        <select
          aria-label="Page"
          value={currentNav}
          onchange={(e) => goto(e.currentTarget.value)}
          class="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
        >
          {#each navItems as item (item.href)}
            <option value={item.href}>{item.label}</option>
          {/each}
        </select>
        <Button variant="outline" size="sm" onclick={() => signOut()} title={data.session.user.email}>Sign out</Button>
      </nav>
      <nav class="hidden xl:flex items-center gap-4">
        {#each navItems as item (item.href)}
          <a
            href={item.href}
            class="text-sm hover:text-foreground {currentNav === item.href ? 'text-foreground font-medium' : 'text-muted-foreground'}"
          >{item.label}</a>
        {/each}
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
