<script>
  import { FlaskConical, Workflow, GitPullRequest, Rocket, ChartColumn, KeyRound, LayoutGrid, Map, Activity, Settings } from 'lucide-svelte';
  import { SECTIONS } from '$lib/sections.js';

  /** @type {Record<string, any>} */
  const ICONS = {
    '/test-runs': FlaskConical,
    '/e2e-flows': Workflow,
    '/prs': GitPullRequest,
    '/releases': Rocket,
    '/statistics': ChartColumn,
    '/authub': KeyRound,
    '/automation-hub': LayoutGrid,
    '/automations': Map,
    '/ops': Activity,
    '/settings': Settings
  };
</script>

<svelte:head>
  <title>Dashboard - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-6">
  <div>
    <h1 class="text-3xl font-bold">Dashboard</h1>
    <p class="text-muted-foreground mt-1">Connector testing, release and the CI around appmixer-connectors</p>
  </div>

  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each SECTIONS as section (section.href)}
      {@const Icon = ICONS[section.href]}
      <a
        href={section.href}
        class="group flex gap-4 rounded-lg border bg-card p-5 transition-colors hover:border-foreground/30 hover:bg-muted/40"
      >
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:text-foreground">
          {#if Icon}<Icon size={20} />{/if}
        </div>
        <div class="min-w-0">
          <h2 class="font-semibold">{section.label}</h2>
          <p class="mt-1 text-sm text-muted-foreground">{section.description}</p>
        </div>
      </a>
    {/each}
  </div>
</div>
