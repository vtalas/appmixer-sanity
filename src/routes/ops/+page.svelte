<script>
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll } from '$app/navigation';
  import { ExternalLink, RefreshCw } from 'lucide-svelte';

  let { data } = $props();

  const appmixer = $derived(data.appmixer?.data);
  const workflows = $derived(data.workflows?.data);
  const openclaw = $derived(data.openclaw?.data);

  const instances = $derived((appmixer?.templates || []).flatMap((t) => t.instances));
  const activeWorkflows = $derived((workflows?.workflows || []).filter((w) => !w.inactive));
  const inactiveWorkflows = $derived((workflows?.workflows || []).filter((w) => w.inactive));
  const stats = $derived({
    templates: appmixer?.templates?.length ?? 0,
    running: instances.filter((i) => i.stage === 'running').length,
    instances: instances.length,
    withErrors: instances.filter((i) => (i.errors?.total ?? 0) > 0).length,
    outdated: instances.filter((i) => i.outdated).length,
    missing: (appmixer?.templates || []).filter(
      (t) => !t.instances.some((i) => i.stage === 'running')
    ).length,
    workflowsFailing: activeWorkflows.filter((w) => w.last?.conclusion === 'failure').length,
    workflowsWaiting: activeWorkflows.reduce((n, w) => n + (w.recent?.waiting || 0), 0)
  });

  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    try {
      await invalidateAll();
    } finally {
      refreshing = false;
    }
  }

  /** @param {string | null | undefined} value */

  function ago(value) {
    if (!value) return '—';
    const diff = Date.now() - new Date(value).getTime();
    if (isNaN(diff)) return '—';
    const minutes = Math.round(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  /** @param {string | null | undefined} flowId */

  const designer = (flowId) =>
    appmixer?.uiUrl && flowId ? `${appmixer.uiUrl}/designer/${flowId}` : null;

  /** @param {any} run */

  const runClass = (run) => {
    if (!run) return 'bg-muted text-muted-foreground border-border';
    if (run.status !== 'completed') return 'bg-blue-50 text-blue-700 border-blue-200';
    if (run.conclusion === 'success') return 'bg-green-50 text-green-700 border-green-200';
    if (run.conclusion === 'failure') return 'bg-red-50 text-red-700 border-red-200';
    return 'bg-amber-50 text-amber-800 border-amber-200';
  };

  /** @param {Array<{count: number}>} buckets */

  const maxBucket = (buckets) => Math.max(1, ...(buckets || []).map((/** @type {{count: number}} */ b) => b.count));
</script>

<svelte:head>
  <title>Operations - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-8">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-3xl font-bold">Operations</h1>
      <p class="text-muted-foreground">
        Everything that runs the connector CI: Appmixer integrations, GitHub workflows and the
        OpenClaw agents
      </p>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-xs text-muted-foreground">Loaded {ago(data.generatedAt)}</span>
      <Button variant="outline" onclick={refresh} disabled={refreshing}>
        <RefreshCw size={15} class="mr-2 {refreshing ? 'animate-spin' : ''}" />
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </Button>
    </div>
  </div>

  <!-- Summary -->
  <div class="grid grid-cols-2 md:grid-cols-6 gap-3">
    <a href="#appmixer" class="border rounded-lg p-3 hover:bg-muted/50">
      <div class="text-2xl font-bold">{stats.running}/{stats.instances}</div>
      <div class="text-xs text-muted-foreground">Integrations running</div>
    </a>
    <a
      href="#appmixer"
      class="border rounded-lg p-3 {stats.missing ? 'bg-red-50 border-red-200' : ''}"
    >
      <div class="text-2xl font-bold">{stats.missing}</div>
      <div class="text-xs text-muted-foreground">Templates with no running instance</div>
    </a>
    <a
      href="#appmixer"
      class="border rounded-lg p-3 {stats.withErrors ? 'bg-amber-50 border-amber-200' : ''}"
    >
      <div class="text-2xl font-bold">{stats.withErrors}</div>
      <div class="text-xs text-muted-foreground">Instances with errors (7 days)</div>
    </a>
    <a
      href="#appmixer"
      class="border rounded-lg p-3 {stats.outdated ? 'bg-amber-50 border-amber-200' : ''}"
    >
      <div class="text-2xl font-bold">{stats.outdated}</div>
      <div class="text-xs text-muted-foreground">Instances behind their template</div>
    </a>
    <a
      href="#workflows"
      class="border rounded-lg p-3 {stats.workflowsFailing ? 'bg-red-50 border-red-200' : ''}"
    >
      <div class="text-2xl font-bold">{stats.workflowsFailing}</div>
      <div class="text-xs text-muted-foreground">Workflows whose last run failed</div>
    </a>
    <a
      href="#openclaw"
      class="border rounded-lg p-3 {openclaw?.gateway?.active === false || data.openclaw?.error
        ? 'bg-red-50 border-red-200'
        : ''}"
    >
      <div class="text-2xl font-bold">
        {#if data.openclaw?.error}error{:else if !openclaw?.configured}—{:else}{openclaw.gateway
            ?.active
            ? 'up'
            : 'down'}{/if}
      </div>
      <div class="text-xs text-muted-foreground">OpenClaw gateway</div>
    </a>
  </div>

  <!-- Appmixer -->
  <section id="appmixer" class="space-y-3">
    <div class="flex items-baseline justify-between">
      <h2 class="text-xl font-semibold">Appmixer integrations</h2>
      {#if appmixer}
        <span class="text-xs text-muted-foreground">
          {appmixer.instanceUrl} · category <code>{appmixer.category?.name || 'missing'}</code> ·
          <a class="underline" href="/automation-hub">Automation Hub</a>
        </span>
      {/if}
    </div>
    {#if data.appmixer?.error}
      <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
        {data.appmixer.error}
      </div>
    {:else if appmixer}
      <div class="border rounded-lg divide-y">
        {#each appmixer.templates as template (template.flowId)}
          <div class="p-3 space-y-2">
            <div class="flex items-center justify-between gap-3">
              <div class="font-medium">{template.name}</div>
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <span>template rev {template.revision ?? '—'}</span>
                {#if designer(template.originFlowId)}
                  <a
                    class="inline-flex items-center gap-1 hover:text-foreground"
                    href={designer(template.originFlowId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    draft <ExternalLink size={12} />
                  </a>
                {/if}
              </div>
            </div>
            {#if template.instances.length === 0}
              <div class="text-sm text-red-700">No instance — nothing runs this integration.</div>
            {/if}
            {#each template.instances as instance (instance.flowId)}
              <div
                class="flex flex-wrap items-center gap-3 text-sm pl-3 border-l-2 {instance.stage ===
                'running'
                  ? 'border-green-400'
                  : 'border-red-400'}"
              >
                <Badge
                  variant="outline"
                  class={instance.stage === 'running' ? 'text-green-700' : 'text-red-700'}
                  >{instance.stage}</Badge
                >
                <span class="text-xs text-muted-foreground">rev {instance.revision ?? '—'}</span>
                {#if instance.outdated}
                  <Badge variant="outline" class="text-amber-800 bg-amber-50"
                    >behind template — recreate</Badge
                  >
                {/if}
                <span class="text-xs text-muted-foreground"
                  >last activity {ago(instance.lastActivity)}</span
                >
                {#if instance.errors?.error}
                  <span class="text-xs text-red-700">errors: {instance.errors.error}</span>
                {:else if instance.errors?.total}
                  <span
                    class="inline-flex items-end gap-0.5 h-4"
                    title="errors per day, last 7 days"
                  >
                    {#each instance.errors.buckets as bucket}
                      <span
                        class="w-1.5 bg-red-400 rounded-sm"
                        style="height: {Math.max(
                          2,
                          Math.round((bucket.count / maxBucket(instance.errors.buckets)) * 16)
                        )}px"
                        title="{bucket.day}: {bucket.count}"
                      ></span>
                    {/each}
                  </span>
                  <span class="text-xs text-red-700">{instance.errors.total} errors / 7 d</span>
                  {#if instance.errors.last}
                    <span
                      class="text-xs text-muted-foreground truncate max-w-xl"
                      title={instance.errors.last.message}
                    >
                      last {ago(instance.errors.last.at)} in {instance.errors.last.component}: {instance
                        .errors.last.message}
                    </span>
                  {/if}
                {:else}
                  <span class="text-xs text-green-700">no errors / 7 d</span>
                {/if}
                {#if designer(instance.flowId)}
                  <a
                    class="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    href={designer(instance.flowId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    designer <ExternalLink size={12} />
                  </a>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- GitHub Actions -->
  <section id="workflows" class="space-y-3">
    <div class="flex items-baseline justify-between">
      <h2 class="text-xl font-semibold">GitHub Actions</h2>
      {#if workflows}<span class="text-xs text-muted-foreground">{workflows.repo}</span>{/if}
    </div>
    {#if data.workflows?.error}
      <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
        {data.workflows.error}
      </div>
    {:else if workflows}
      {#snippet workflowRow(/** @type {any} */ workflow)}
        <div class="p-3 flex flex-wrap items-center gap-3 text-sm">
          <a
            class="font-medium hover:underline min-w-56"
            href={workflow.url}
            target="_blank"
            rel="noreferrer">{workflow.name}</a
          >
          <span class="text-xs px-2 py-0.5 rounded border {runClass(workflow.last)}">
            {workflow.last
              ? workflow.last.status === 'completed'
                ? workflow.last.conclusion
                : workflow.last.status
              : 'never ran'}
          </span>
          {#if workflow.last}
            <a
              class="text-xs text-muted-foreground hover:text-foreground"
              href={workflow.last.url}
              target="_blank"
              rel="noreferrer"
            >
              {ago(workflow.last.at)} · {workflow.last.event}{workflow.last.branch
                ? ` · ${workflow.last.branch}`
                : ''}
            </a>
          {/if}
          <span class="text-xs text-muted-foreground ml-auto">
            7 d: {workflow.recent.total} runs{#if workflow.recent.failed}, <span
                class="text-red-700">{workflow.recent.failed} failed</span
              >{/if}{#if workflow.recent.waiting}, <span class="text-amber-800"
                >{workflow.recent.waiting} waiting for approval</span
              >{/if}
          </span>
        </div>
      {/snippet}
      <div class="border rounded-lg divide-y">
        {#each activeWorkflows as workflow (workflow.id)}
          {@render workflowRow(workflow)}
        {/each}
      </div>
      {#if inactiveWorkflows.length}
        <details class="border rounded-lg">
          <summary class="px-3 py-2 text-sm text-muted-foreground cursor-pointer">
            {inactiveWorkflows.length} inactive (no run in 30 days — removed files or GitHub-managed)
          </summary>
          <div class="divide-y border-t opacity-70">
            {#each inactiveWorkflows as workflow (workflow.id)}
              {@render workflowRow(workflow)}
            {/each}
          </div>
        </details>
      {/if}
    {/if}
  </section>

  <!-- OpenClaw -->
  <section id="openclaw" class="space-y-3">
    <h2 class="text-xl font-semibold">OpenClaw agents</h2>
    {#if data.openclaw?.error}
      <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
        {data.openclaw.error}
      </div>
    {:else if !openclaw?.configured}
      <div class="bg-muted rounded-lg p-3 text-sm text-muted-foreground">
        Not configured: set <code>OPENCLAW_STATUS_URL</code> and <code>OPENCLAW_STATUS_TOKEN</code>.
      </div>
    {:else}
      <div class="grid md:grid-cols-3 gap-3">
        <div class="border rounded-lg p-3 space-y-1 text-sm">
          <div class="font-medium">Gateway</div>
          <div>
            {openclaw.gateway?.active ? '🟢 running' : '🔴 not running'} · {openclaw.version}
          </div>
          <div class="text-xs text-muted-foreground">
            host {openclaw.host} · status {ago(openclaw.generatedAt)}
          </div>
          <div class="text-xs text-muted-foreground">
            Node {openclaw.node} · disk {openclaw.disk}
          </div>
          {#if openclaw.update}
            <div
              class="text-xs {openclaw.update.available
                ? 'text-amber-800'
                : 'text-muted-foreground'}"
            >
              {openclaw.update.available
                ? `update available: ${openclaw.update.latest}`
                : 'up to date'}
            </div>
          {/if}
        </div>
        <div class="border rounded-lg p-3 space-y-1 text-sm">
          <div class="font-medium">Agents & hooks</div>
          <div class="text-xs">{(openclaw.agents || []).join(', ')}</div>
          {#each openclaw.hooks || [] as hook}
            <div class="text-xs text-muted-foreground">
              <code>/hooks/{hook.path}</code> → {hook.agentId} · {hook.model}
            </div>
          {/each}
        </div>
        <div class="border rounded-lg p-3 space-y-1 text-sm">
          <div class="font-medium">
            Mention responder {#if openclaw.mentionResponder?.shadow}<Badge
                variant="outline"
                class="ml-1 text-amber-800">shadow</Badge
              >{/if}
          </div>
          <div class="text-xs text-muted-foreground">
            {openclaw.mentionResponder?.shadowEntries ?? 0} logged replies · {openclaw
              .mentionResponder?.runs ?? 0} runs on disk
          </div>
        </div>
      </div>
      {#if openclaw.hookRuns?.length}
        <div class="border rounded-lg divide-y">
          {#each openclaw.hookRuns as run}
            <div class="px-3 py-2 flex flex-wrap items-center gap-3 text-xs">
              <span
                class="px-2 py-0.5 rounded border {run.status === 'ok'
                  ? 'bg-green-50 text-green-700 border-green-200'
                  : 'bg-red-50 text-red-700 border-red-200'}">{run.status}</span
              >
              <span>{ago(run.at)}</span>
              <span class="text-muted-foreground">{run.model}</span>
              {#if run.summary}<span
                  class="text-muted-foreground truncate max-w-2xl"
                  title={run.summary}>{run.summary}</span
                >{/if}
            </div>
          {/each}
        </div>
      {/if}
      {#if openclaw.mentionResponder?.recent?.length}
        <div class="border rounded-lg divide-y">
          {#each openclaw.mentionResponder.recent as entry}
            <div class="px-3 py-2 text-xs space-y-1">
              <div class="flex gap-3 text-muted-foreground">
                <a
                  class="hover:underline"
                  href="https://github.com/Appmixer-ai/appmixer-connectors/pull/{entry.pr}"
                  target="_blank"
                  rel="noreferrer">PR #{entry.pr}</a
                >
                <span>{entry.kind} {entry.id}</span>
                <span>{ago(entry.at)}</span>
                {#if entry.code_changed}<span class="text-amber-800">would push a change</span>{/if}
              </div>
              <div class="whitespace-pre-wrap">{entry.body}</div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </section>
</div>
