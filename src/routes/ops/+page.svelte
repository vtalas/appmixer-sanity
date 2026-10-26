<script>
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ChevronDown, ChevronRight, ExternalLink, RefreshCw, ScrollText } from 'lucide-svelte';

  let { data } = $props();

  const appmixer = $derived(data.appmixer?.data);
  const workflows = $derived(data.workflows?.data);
  const openclaw = $derived(data.openclaw?.data);

  const instances = $derived((appmixer?.templates || []).flatMap((t) => t.instances));

  // Errors count, and show in red, only within the window picked here; older ones fade out.
  // The pick is the viewer's own and is remembered in the browser.
  const ERROR_WINDOWS = [
    { key: '1h', label: '1 h', ms: 3600e3 },
    { key: '24h', label: '24 h', ms: 24 * 3600e3 },
    { key: '3d', label: '3 d', ms: 3 * 24 * 3600e3 },
    { key: '7d', label: '7 d', ms: 7 * 24 * 3600e3 }
  ];
  /** An error newer than this is marked new */
  const NEW_MS = 3600e3;
  const ERROR_WINDOW_KEY = 'ops.errorWindow';
  let errorWindowKey = $state('24h');
  onMount(() => {
    try {
      const saved = localStorage.getItem(ERROR_WINDOW_KEY);
      if (ERROR_WINDOWS.some((w) => w.key === saved)) errorWindowKey = /** @type {string} */ (saved);
    } catch {
      // Storage blocked: the default window
    }
  });
  const errorWindow = $derived(
    ERROR_WINDOWS.find((w) => w.key === errorWindowKey) || ERROR_WINDOWS[1]
  );
  /** @param {string} key */
  function pickErrorWindow(key) {
    errorWindowKey = key;
    try {
      localStorage.setItem(ERROR_WINDOW_KEY, key);
    } catch {
      // Not remembered, still applied
    }
  }
  /**
   * Errors of an instance within the picked window.
   * @param {any} instance
   * @returns {number}
   */
  const recentErrors = (instance) =>
    instance.errors?.byWindow?.[errorWindow.key] ?? instance.errors?.total ?? 0;
  /** @param {string | null | undefined} at */
  const withinWindow = (at) => !!at && Date.now() - new Date(at).getTime() <= errorWindow.ms;
  /** @param {string | null | undefined} at */
  const isNew = (at) => !!at && Date.now() - new Date(at).getTime() <= NEW_MS;
  /**
   * Whether a day of the error histogram reaches into the picked window.
   * @param {string} day - YYYY-MM-DD
   */
  const dayInWindow = (day) =>
    new Date(`${day}T00:00`).getTime() + 24 * 3600e3 > Date.now() - errorWindow.ms;
  /** One group per repository, each with its active and inactive workflows. */
  const workflowRepos = $derived(
    (workflows?.repos || []).map((/** @type {any} */ group) => ({
      ...group,
      active: group.workflows.filter((/** @type {any} */ w) => !w.inactive),
      inactive: group.workflows.filter((/** @type {any} */ w) => w.inactive)
    }))
  );
  const activeWorkflows = $derived(workflowRepos.flatMap((group) => group.active));
  const stats = $derived({
    templates: appmixer?.templates?.length ?? 0,
    running: instances.filter((i) => i.stage === 'running').length,
    instances: instances.length,
    withErrors: instances.filter((i) => recentErrors(i) > 0).length,
    outdated: instances.filter((i) => i.outdated).length,
    missing: (appmixer?.templates || []).filter(
      (t) => !t.instances.some((i) => i.stage === 'running')
    ).length,
    workflowsFailing: activeWorkflows.filter((w) => w.last?.conclusion === 'failure').length,
    workflowsWaiting: activeWorkflows.reduce((n, w) => n + (w.recent?.waiting || 0), 0)
  });

  // Run panels, one per instance, loaded a page at a time from /api/ops/runs. `next` is
  // where the page after the runs shown starts (null: there is none), `more` whether that
  // page is the one being loaded. `open` holds what is expanded in the tree, by path: a run,
  // a component, one of its ports, its data, an entry.
  /** @type {Record<string, { errorsOnly: boolean, loading: boolean, more: boolean, error: string | null, runs: any[], next: string | null, open: Record<string, boolean> }>} */
  let logPanels = $state({});
  /** Hook runs expanded to their steps and closing text, by the run's timestamp. */
  /** @type {Record<string, boolean>} */
  let openHookRuns = $state({});
  /** Hook runs that started from one hook, newest first; the builder stamps each run's hookId. */
  const runsOfHook = (/** @type {string} */ id) =>
    (openclaw?.hookRuns || []).filter((/** @type {any} */ run) => run.hookId === id);
  const strayResponderRuns = $derived(
    (openclaw?.mentionResponder?.recent || []).filter((/** @type {any} */ r) => !r.hookRunAt)
  );
  const unmatchedRuns = $derived(
    (openclaw?.hookRuns || []).filter((/** @type {any} */ run) => !run.hookId)
  );

  /**
   * Loads the newest runs of an instance, or with `more` the page after the ones shown.
   * @param {string} flowId @param {boolean} errorsOnly @param {boolean} [more]
   */
  async function loadLogs(flowId, errorsOnly, more = false) {
    const shown = logPanels[flowId];
    const before = more && shown?.next ? `&before=${encodeURIComponent(shown.next)}` : '';
    logPanels[flowId] = {
      errorsOnly,
      loading: true,
      more,
      error: null,
      runs: shown?.runs || [],
      next: more ? (shown?.next ?? null) : null,
      open: shown?.open || {}
    };
    try {
      const response = await fetch(
        `/api/ops/runs?flowId=${flowId}${errorsOnly ? '&errors=1' : ''}${before}`
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message || `HTTP ${response.status}`);
      const panel = logPanels[flowId];
      if (panel) {
        // A run with errors on both sides of a page boundary comes with both pages
        const known = new Set(more ? panel.runs.map((run) => run.id) : []);
        panel.runs = more
          ? [...panel.runs, ...body.runs.filter((/** @type {any} */ run) => !known.has(run.id))]
          : body.runs;
        panel.next = body.next;
      }
    } catch (e) {
      if (logPanels[flowId]) logPanels[flowId].error = /** @type {Error} */ (e).message;
    } finally {
      if (logPanels[flowId]) logPanels[flowId].loading = false;
    }
  }

  /** @param {string} flowId @param {boolean} [errorsOnly] */
  function toggleLogs(flowId, errorsOnly = false) {
    if (logPanels[flowId] && logPanels[flowId].errorsOnly === errorsOnly) {
      delete logPanels[flowId];
    } else {
      loadLogs(flowId, errorsOnly);
    }
  }

  /** @type {Record<string, string>} */
  const severityClass = {
    error: 'bg-red-50 text-red-700 border-red-200',
    warn: 'bg-amber-50 text-amber-800 border-amber-200',
    info: 'bg-muted text-muted-foreground border-border'
  };

  /** @type {Record<string, string>} */
  const statusClass = {
    ok: 'bg-green-50 text-green-700 border-green-200',
    error: severityClass.error,
    retried: severityClass.warn,
    info: severityClass.info
  };

  /**
   * When a run started, the way one would say it: "Today 14:40" with "10 minutes ago" while
   * it is less than an hour old, "Yesterday 14:40", then "3 days ago" with the date.
   * @param {string} value
   */
  function when(value) {
    const date = new Date(value);
    /** @param {Date} d */
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((midnight(new Date()) - midnight(date)) / 86400000);
    const time = date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    if (days > 1) {
      return { day: `${days} days ago`, more: `${date.toLocaleDateString()} ${time}` };
    }
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    return {
      day: `${days === 1 ? 'Yesterday' : 'Today'} ${time}`,
      more:
        minutes >= 60
          ? ''
          : minutes < 1
            ? 'just now'
            : `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    };
  }

  /** @param {number} ms */
  function duration(ms) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  }

  /**
   * The components a component's output went to, whichever port they hang on.
   * @param {any} node
   * @returns {any[]}
   */
  const below = (node) => [
    ...(node.ports || []).flatMap((/** @type {any} */ port) => port.children),
    ...node.children
  ];

  /**
   * What a component of a run has to say for itself on its row.
   * @param {any} node
   */
  function outcome(node) {
    if (node.error) return node.error;
    if (node.retries) {
      return `succeeded after ${node.retries} failed attempt${node.retries === 1 ? '' : 's'}`;
    }
    const output = node.entries.findLast((/** @type {any} */ e) => e.direction === 'out');
    return output && output.summary !== '{}' ? output.summary : '';
  }

  /**
   * A component's type without the vendor prefix: its connector, module and component, e.g.
   * `github.project.StatusChanged`.
   * @param {string | null | undefined} type
   */
  const componentType = (type) => (type ? type.replace(/^appmixer\./, '') : '');

  /**
   * An entry's detail cut into tokens to colour, when it is JSON; anything else stays one
   * plain token.
   * @param {string} text
   * @returns {Array<{ text: string, kind: string }>}
   */
  function jsonTokens(text) {
    if (!/^\s*[[{]/.test(text)) return [{ text, kind: '' }];
    /** @type {Array<{ text: string, kind: string }>} */
    const tokens = [];
    const pattern =
      /("(?:[^"\\\n]|\\.)*")(\s*:)?|(?<=(?::|^\s*|\[)\s?)(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=,?$)/gm;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      if (at > last) tokens.push({ text: text.slice(last, at), kind: '' });
      if (match[2]) {
        tokens.push({ text: match[1], kind: 'key' }, { text: match[2], kind: '' });
      } else {
        tokens.push({ text: match[0], kind: match[1] ? 'string' : 'literal' });
      }
      last = at + match[0].length;
    }
    if (last < text.length) tokens.push({ text: text.slice(last), kind: '' });
    return tokens;
  }

  /** @type {Record<string, string>} */
  const tokenClass = {
    key: 'text-sky-800',
    string: 'text-emerald-800',
    literal: 'text-amber-700'
  };

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

  const maxBucket = (buckets) =>
    Math.max(1, ...(buckets || []).map((/** @type {{count: number}} */ b) => b.count));
</script>

<svelte:head>
  <title>Operations - Appmixer Sanity Check</title>
</svelte:head>

{#snippet chevron(/** @type {boolean} */ open)}
  {#if open}
    <ChevronDown size={12} class="shrink-0" />
  {:else}
    <ChevronRight size={12} class="shrink-0" />
  {/if}
{/snippet}

<!-- One component of a run on its row. The trigger is the run's own row and carries `run`.
     A component that set off exactly one other is followed by it on the same level, so a
     chain reads top to bottom; only a component that set off several opens into branches.
     That holds only for a component `alone` where it hangs: of several side by side, each
     opens onto what it set off, so one chain does not run on into the next. -->
{#snippet step(
  /** @type {any} */ panel,
  /** @type {string} */ path,
  /** @type {any} */ node,
  /** @type {any} */ run,
  /** @type {boolean} */ alone
)}
  {@const key = `${path}/${node.id}`}
  {@const dataKey = `${key}:data`}
  {@const next = below(node)}
  {@const expandable = run || !alone ? next.length > 0 : next.length > 1}
  <!-- A run opens on a click; below it, the way to a failure is already open, and so is a
       chain that would have followed on the same level -->
  {@const expanded =
    expandable && (panel.open[key] ?? (!run && (node.failing || next.length === 1)))}
  {@const status = run ? run.status : node.retries ? 'retried' : node.status}
  {@const text = run ? run.summary : outcome(node)}
  <div>
    <div class="flex items-center gap-2 py-1">
      <button
        type="button"
        class="flex-1 min-w-0 flex items-center gap-2 text-left"
        onclick={() =>
          expandable ? (panel.open[key] = !expanded) : (panel.open[dataKey] = !panel.open[dataKey])}
      >
        {@render chevron(expandable ? expanded : !!panel.open[dataKey])}
        {#if run}
          {@const started = when(run.at)}
          <span
            class="text-muted-foreground whitespace-nowrap"
            title={new Date(run.at).toLocaleString()}
          >
            <span class="text-foreground">{started.day}</span>{started.more
              ? ` · ${started.more}`
              : ''}
          </span>
        {/if}
        <span class="px-1.5 rounded border whitespace-nowrap {statusClass[status]}">{status}</span>
        <span class="font-medium whitespace-nowrap" title={node.type}>{node.label}</span>
        {#if node.type}
          <code class="text-muted-foreground whitespace-nowrap">{componentType(node.type)}</code>
        {/if}
        {#if run || !expanded || next.length === 1}
          <!-- Which way it went, where the branches themselves are not on show -->
          {#each (node.ports || []).filter((/** @type {any} */ p) => p.fired) as port (port.name)}
            <code class="px-1.5 rounded border bg-background whitespace-nowrap">{port.name}</code>
          {/each}
        {/if}
        <span
          class="truncate {status === 'error' ? 'text-red-700' : 'text-muted-foreground'}"
          title={text}>{text}</span
        >
      </button>
      {#if run && node.id !== 'flow'}
        <span class="text-muted-foreground whitespace-nowrap">
          {run.steps}
          {run.steps === 1 ? 'step' : 'steps'} · {duration(run.durationMs)}
        </span>
      {/if}
      {#if expandable}
        <button
          type="button"
          class="px-1.5 rounded border whitespace-nowrap {panel.open[dataKey]
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          title="What this component received and sent"
          onclick={() => (panel.open[dataKey] = !panel.open[dataKey])}>data</button
        >
      {/if}
    </div>
    {#if panel.open[dataKey]}
      <div class="ml-5 mb-1 border rounded bg-background divide-y">
        {#each node.entries as entry (entry.id)}
          {@const entryKey = `${key}#${entry.id}`}
          <div class="px-2 py-1">
            <button
              type="button"
              class="w-full flex items-center gap-2 text-left"
              onclick={() => (panel.open[entryKey] = !panel.open[entryKey])}
            >
              {@render chevron(!!panel.open[entryKey])}
              <span class="text-muted-foreground whitespace-nowrap" title={entry.at}
                >{new Date(entry.at).toLocaleTimeString([], { hourCycle: 'h23' })}</span
              >
              {#if entry.severity !== 'info'}
                <span
                  class="px-1.5 rounded border {severityClass[entry.severity] ||
                    severityClass.info}">{entry.severity}</span
                >
              {/if}
              {#if entry.port}
                <span class="text-muted-foreground whitespace-nowrap"
                  >{entry.direction === 'in' ? 'input' : 'output'}
                  <code>{entry.port}</code></span
                >
              {/if}
              <span
                class="truncate {entry.severity === 'error'
                  ? 'text-red-700'
                  : 'text-muted-foreground'}">{entry.summary}</span
              >
            </button>
            {#if panel.open[entryKey]}
              <pre
                class="mt-1 ml-5 p-2 bg-muted/30 border rounded text-[11px] whitespace-pre-wrap break-all max-h-80 overflow-auto">{#each jsonTokens(entry.detail) as token}{#if token.kind}<span
                      class={tokenClass[token.kind]}>{token.text}</span
                    >{:else}{token.text}{/if}{/each}</pre>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if expanded}
      <div class="ml-[5px] pl-4 border-l">
        {#if next.length === 1}
          {@render step(panel, key, next[0], null, true)}
        {:else}
          {@render branches(panel, key, node)}
        {/if}
      </div>
    {/if}
  </div>
  {#if !run && alone && next.length === 1}
    {@render step(panel, key, next[0], null, true)}
  {/if}
{/snippet}

<!-- The out ports of a component that set off several others, each with what hangs on it -->
{#snippet branches(/** @type {any} */ panel, /** @type {string} */ key, /** @type {any} */ node)}
  {#each node.ports || [] as port (port.name)}
    {@const portKey = `${key}>${port.name}`}
    {@const portOpen = port.children.length > 0 && (panel.open[portKey] ?? true)}
    <div>
      <button
        type="button"
        class="flex items-center gap-2 py-1 text-left"
        disabled={!port.children.length}
        onclick={() => (panel.open[portKey] = !portOpen)}
      >
        {#if port.children.length}
          {@render chevron(portOpen)}
        {:else}
          <span class="w-3 shrink-0"></span>
        {/if}
        <code class="px-1.5 rounded border {port.fired ? 'bg-background' : 'text-muted-foreground'}"
          >{port.name}</code
        >
        <span class="text-muted-foreground">
          {#if port.children.length}
            {port.children.length} {port.children.length === 1 ? 'item' : 'items'}
          {:else}
            {port.fired ? 'nothing connected' : 'nothing'}
          {/if}
        </span>
      </button>
      {#if portOpen}
        <div class="ml-[5px] pl-4 border-l">
          {#each port.children as child (child.id)}
            {@render step(panel, portKey, child, null, port.children.length === 1)}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
  {#each node.children as child (child.id)}
    {@render step(panel, key, child, null, node.children.length === 1)}
  {/each}
{/snippet}

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
      <div class="text-xs text-muted-foreground">
        Instances with errors ({errorWindow.label})
      </div>
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
      <div class="flex items-baseline gap-4">
        <h2 class="text-xl font-semibold">Appmixer integrations</h2>
        {#if appmixer}
          <span class="flex items-center gap-1 text-xs text-muted-foreground">
            errors in
            {#each ERROR_WINDOWS as w (w.key)}
              <button
                type="button"
                class="px-2 py-0.5 rounded border {w.key === errorWindow.key
                  ? 'bg-foreground text-background border-foreground'
                  : 'hover:text-foreground'}"
                onclick={() => pickErrorWindow(w.key)}>{w.label}</button
              >
            {/each}
          </span>
        {/if}
      </div>
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
                {#each instance.hooks || [] as hookId}
                  <a class="text-xs hover:underline" href="#openclaw">→ OpenClaw hook {hookId}</a>
                {/each}
                {#if instance.errors?.error}
                  <span class="text-xs text-red-700">errors: {instance.errors.error}</span>
                {:else if instance.errors?.total}
                  {@const recent = recentErrors(instance)}
                  {@const last = instance.errors.last}
                  <span
                    class="inline-flex items-end gap-0.5 h-4"
                    title="errors per day, last 7 days; grey: before the last {errorWindow.label}"
                  >
                    {#each instance.errors.buckets as bucket}
                      <span
                        class="w-1.5 rounded-sm {dayInWindow(bucket.day)
                          ? 'bg-red-400'
                          : 'bg-muted-foreground/25'}"
                        style="height: {Math.max(
                          2,
                          Math.round((bucket.count / maxBucket(instance.errors.buckets)) * 16)
                        )}px"
                        title="{bucket.day}: {bucket.count}"
                      ></span>
                    {/each}
                  </span>
                  {#if recent}
                    {#if isNew(last?.at)}
                      <span
                        class="px-1.5 rounded bg-red-600 text-white text-[10px] font-semibold uppercase"
                        title="an error in the last hour">new</span
                      >
                    {/if}
                    <button
                      type="button"
                      class="text-xs text-red-700 underline decoration-dotted hover:decoration-solid"
                      onclick={() => toggleLogs(instance.flowId, true)}
                      >{recent} error{recent === 1 ? '' : 's'} / {errorWindow.label}</button
                    >
                    {#if last}
                      <span
                        class="text-xs text-muted-foreground truncate max-w-xl"
                        title={last.message}
                      >
                        last {ago(last.at)} in {last.component}: {last.message}
                      </span>
                    {/if}
                  {:else}
                    <span class="text-xs text-green-700">no errors / {errorWindow.label}</span>
                    <!-- Older ones stay reachable, without drawing the eye -->
                    <button
                      type="button"
                      class="text-xs text-muted-foreground/70 underline decoration-dotted hover:text-foreground"
                      title={last
                        ? `last ${ago(last.at)} in ${last.component}: ${last.message}`
                        : ''}
                      onclick={() => toggleLogs(instance.flowId, true)}
                      >{instance.errors.total} older, last {ago(last?.at)}</button
                    >
                  {/if}
                {:else}
                  <span class="text-xs text-green-700">no errors / {errorWindow.label}</span>
                {/if}
                <button
                  type="button"
                  class="ml-auto inline-flex items-center gap-1 text-xs hover:text-foreground {logPanels[
                    instance.flowId
                  ]
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'}"
                  onclick={() => toggleLogs(instance.flowId)}
                >
                  <ScrollText size={12} /> runs
                </button>
                {#if designer(instance.flowId)}
                  <a
                    class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    href={designer(instance.flowId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    designer <ExternalLink size={12} />
                  </a>
                {/if}
              </div>
              {#if logPanels[instance.flowId]}
                {@const panel = logPanels[instance.flowId]}
                <div class="ml-3 border rounded-md bg-muted/30">
                  <div class="flex items-center gap-2 px-3 py-2 border-b text-xs">
                    <span class="font-medium"
                      >{panel.loading && !panel.more
                        ? 'Loading…'
                        : `Last ${panel.runs.length} runs${panel.errorsOnly ? ' with errors' : ''}`}</span
                    >
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded border {!panel.errorsOnly
                        ? 'bg-background font-medium'
                        : 'text-muted-foreground'}"
                      onclick={() => loadLogs(instance.flowId, false)}>All</button
                    >
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded border {panel.errorsOnly
                        ? 'bg-background font-medium'
                        : 'text-muted-foreground'}"
                      onclick={() => loadLogs(instance.flowId, true)}>Errors only</button
                    >
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      onclick={() => loadLogs(instance.flowId, panel.errorsOnly)}
                      disabled={panel.loading}
                    >
                      <RefreshCw size={12} class={panel.loading ? 'animate-spin' : ''} /> reload
                    </button>
                    <button
                      type="button"
                      class="ml-auto text-muted-foreground hover:text-foreground"
                      onclick={() => delete logPanels[instance.flowId]}>✕</button
                    >
                  </div>
                  {#if panel.error}
                    <div class="px-3 py-2 text-xs text-red-700">{panel.error}</div>
                  {:else if panel.loading && !panel.runs.length}
                    <div class="px-3 py-2 text-xs text-muted-foreground">Loading…</div>
                  {:else if !panel.runs.length}
                    <div class="px-3 py-2 text-xs text-muted-foreground">
                      {panel.errorsOnly ? 'No runs with errors.' : 'No runs.'}
                    </div>
                  {:else}
                    <div
                      class="max-h-[70vh] overflow-auto divide-y text-xs {panel.loading &&
                      !panel.more
                        ? 'opacity-50'
                        : ''}"
                    >
                      {#each panel.runs as run (run.id)}
                        <!-- Runs before the error window are there for reference only -->
                        <div
                          class="px-3 py-0.5 {withinWindow(run.at) ? '' : 'opacity-50'}"
                          title={withinWindow(run.at) ? '' : `before the last ${errorWindow.label}`}
                        >
                          {@render step(panel, run.id, run.root, run, true)}
                        </div>
                      {/each}
                      {#if panel.next}
                        <button
                          type="button"
                          class="w-full px-3 py-2 text-left text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          disabled={panel.loading}
                          onclick={() => loadLogs(instance.flowId, panel.errorsOnly, true)}
                        >
                          {panel.loading && panel.more ? 'Loading…' : 'Load next…'}
                        </button>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
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
      {#if workflows}<span class="text-xs text-muted-foreground"
          >{workflowRepos.map((group) => group.repo).join(' · ')}</span
        >{/if}
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
      {#each workflowRepos as group (group.repo)}
        <div class="space-y-2">
          <a
            class="text-sm font-medium hover:underline"
            href="https://github.com/{group.repo}/actions"
            target="_blank"
            rel="noreferrer">{group.repo}</a
          >
          {#if group.error}
            <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {group.error}
            </div>
          {:else}
            <div class="border rounded-lg divide-y">
              {#each group.active as workflow (workflow.id)}
                {@render workflowRow(workflow)}
              {/each}
              {#if !group.active.length}
                <div class="p-3 text-sm text-muted-foreground">no active workflow</div>
              {/if}
            </div>
            {#if group.inactive.length}
              <details class="border rounded-lg">
                <summary class="px-3 py-2 text-sm text-muted-foreground cursor-pointer">
                  {group.inactive.length} inactive (no run in 30 days — removed files or GitHub-managed)
                </summary>
                <div class="divide-y border-t opacity-70">
                  {#each group.inactive as workflow (workflow.id)}
                    {@render workflowRow(workflow)}
                  {/each}
                </div>
              </details>
            {/if}
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  <!-- OpenClaw -->
  {#snippet hookRunRows(/** @type {any[]} */ runs)}
    <!-- One row per hook call (a gateway journal line), with what the agent's session
         transcript says about it: the PR, how long it took, model calls and cost. A row
         expands to the exec steps by title and the agent's closing text. -->
    <div class="border rounded-lg divide-y">
      {#each runs as run (run.at)}
        {@const details = run.steps?.length || run.result || run.stage?.report}
        <div class="px-3 py-2 text-xs space-y-1">
          <button
            type="button"
            class="flex flex-wrap items-center gap-3 w-full text-left {details
              ? ''
              : 'cursor-default'}"
            onclick={() => {
              if (details) openHookRuns[run.at] = !openHookRuns[run.at];
            }}
          >
            {#if details}
              {#if openHookRuns[run.at]}<ChevronDown class="h-3 w-3" />{:else}<ChevronRight
                  class="h-3 w-3"
                />{/if}
            {/if}
            <span
              class="px-2 py-0.5 rounded border {run.status === 'ok'
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-red-50 text-red-700 border-red-200'}">{run.status}</span
            >
            <span>{ago(run.at)}</span>
            {#if run.pr}
              <a
                class="hover:underline font-medium"
                href="https://github.com/Appmixer-ai/appmixer-connectors/pull/{run.pr}"
                target="_blank"
                rel="noreferrer"
                onclick={(e) => e.stopPropagation()}>PR #{run.pr}</a
              >
            {/if}
            <!-- The pipeline stage this hook call started (Build of an issue, Testing, Fix,
                 Doc&Verification of a PR) and what it decided -->
            {#if run.stage}
              <span
                class="px-1.5 py-0.5 rounded border {run.stage.result === 'passed'
                  ? 'border-green-400 text-green-700'
                  : run.stage.result === 'running'
                    ? 'border-amber-400 text-amber-800'
                    : 'border-red-400 text-red-700'}"
                >{run.stage.name}: {run.stage.result}{#if run.stage.durationSec != null}{` · ${
                    run.stage.durationSec < 120
                      ? `${run.stage.durationSec} s`
                      : `${Math.round(run.stage.durationSec / 60)} min`
                  }`}{/if}</span
              >
              {#if run.stage.issue}
                {@const [repo, number] = run.stage.issue.split('#')}
                <a
                  class="hover:underline font-medium"
                  href="https://github.com/{repo}/issues/{number}"
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}
                  >{repo.replace('Appmixer-ai/appmixer-', '')}#{number}</a
                >
              {/if}
              {#if run.stage.prUrl && !run.pr}
                <a
                  class="hover:underline font-medium"
                  href={run.stage.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}
                  >→ PR #{run.stage.prUrl.split('/').pop()}</a
                >
              {/if}
            {/if}
            {#if run.durationSec != null}<span class="text-muted-foreground"
                >{run.durationSec} s</span
              >{/if}
            {#if run.modelCalls}<span class="text-muted-foreground"
                >{run.modelCalls} model calls · {run.toolCalls} steps</span
              >{/if}
            {#if run.costUsd}<span class="text-muted-foreground"
                >${run.costUsd.toFixed(3)}</span
              >{/if}
            <span class="text-muted-foreground">{run.model}</span>
            {#each run.responder || [] as r (r.at)}
              <span
                class="px-1.5 py-0.5 rounded border border-dashed {r.status === 'replied'
                  ? 'border-green-400 text-green-700'
                  : r.status === 'failed'
                    ? 'border-red-400 text-red-700'
                    : r.status === 'skipped'
                      ? 'border-muted-foreground/40 text-muted-foreground'
                      : 'border-amber-400 text-amber-800'}"
                title="resolve.sh run {r.at}{r.reason ? ' — ' + r.reason : ''}"
                >resolve.sh: {r.status}{#if r.reason}
                  · {r.reason}{/if}{#if r.code_changed}
                  · pushed{/if}</span
              >
            {/each}
            {#if run.summary || run.stage?.summary}<span
                class="text-muted-foreground truncate max-w-2xl"
                title={run.summary || run.stage.summary}>{run.summary || run.stage.summary}</span
              >{/if}
          </button>
          {#if details && openHookRuns[run.at]}
            <div class="pl-6 space-y-1">
              {#if run.stage?.report}
                <div class="whitespace-pre-wrap border-l-2 border-amber-300 pl-2">
                  {run.stage.name} report: {run.stage.report}
                </div>
              {/if}
              {#if run.steps?.length}
                <ol class="list-decimal pl-4 text-muted-foreground">
                  {#each run.steps as step}<li>{step}</li>{/each}
                </ol>
              {/if}
              {#if run.result}
                <div class="whitespace-pre-wrap border-l-2 pl-2">{run.result}</div>
              {/if}
              {#if run.commentUrl}
                <a class="hover:underline" href={run.commentUrl} target="_blank" rel="noreferrer"
                  >the reply on GitHub</a
                >
              {/if}
              {#each run.responder || [] as r (r.at)}
                {#if r.replies?.length || r.mentions}
                  <div class="border border-dashed rounded px-2 py-1 space-y-1">
                    <div class="text-muted-foreground">
                      resolve.sh {when(r.at)}: {r.mentions} mention{r.mentions === 1 ? '' : 's'}
                      {#if r.durationMs != null}· replied after {Math.round(r.durationMs / 1000)} s{/if}
                    </div>
                    {#each r.replies || [] as reply}
                      <div class="whitespace-pre-wrap">{reply.body}</div>
                    {/each}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/snippet}

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
          <div class="text-xs">agents {(openclaw.agents || []).join(', ')}</div>
          <div class="text-xs text-muted-foreground">
            {(openclaw.hooks || []).length} hook{(openclaw.hooks || []).length === 1 ? '' : 's'} on
            {openclaw.publicHost || 'the gateway'}
          </div>
        </div>
        <div class="border rounded-lg p-3 space-y-1 text-sm">
          <div class="font-medium">
            Mention responder {#if openclaw.mentionResponder?.shadow}<Badge
                variant="outline"
                class="ml-1 text-amber-800">shadow</Badge
              >{/if}
          </div>
          <div class="text-xs text-muted-foreground">
            {(openclaw.mentionResponder?.recent || []).filter(
              (/** @type {any} */ r) => r.status === 'replied'
            ).length} replied of the last {openclaw.mentionResponder?.recent?.length ?? 0} ·
            {openclaw.mentionResponder?.runs ?? 0} runs on disk
          </div>
        </div>
      </div>
      <!-- The OpenClaw cron job openclaw-deploy keeps the host on appmixer-components dev:
           its last run, the dev commit it deployed, and deploy.log (newest first). -->
      {#if openclaw.deploy}
        {@const deploy = openclaw.deploy}
        <div class="border rounded-lg p-3 space-y-1 text-sm">
          <div class="flex flex-wrap items-center gap-3">
            <span class="font-medium">Deploy from dev</span>
            {#if !deploy.cron}
              <Badge variant="outline" class="text-red-700">cron job missing</Badge>
            {:else if !deploy.cron.enabled}
              <Badge variant="outline" class="text-amber-800">disabled</Badge>
            {:else if deploy.cron.lastStatus && deploy.cron.lastStatus !== 'ok'}
              <Badge variant="outline" class="text-red-700">last run {deploy.cron.lastStatus}</Badge>
            {/if}
            {#if deploy.restartPending}
              <Badge variant="outline" class="text-amber-800">gateway restart pending</Badge>
            {/if}
          </div>
          {#if deploy.cron}
            <div class="text-xs text-muted-foreground">
              cron <code>openclaw-deploy</code> every {deploy.cron.everyMin} min · last run
              {ago(deploy.cron.lastRunAt)}
              {#if deploy.cron.lastStatus}({deploy.cron.lastStatus}){/if}
            </div>
          {/if}
          {#if deploy.commit}
            <div class="text-xs text-muted-foreground">
              dev <a
                class="hover:underline"
                href="https://github.com/Appmixer-ai/appmixer-components/commit/{deploy.commit
                  .sha}"
                target="_blank"
                rel="noreferrer"><code>{deploy.commit.sha.slice(0, 8)}</code></a
              >
              {deploy.commit.subject} · {ago(deploy.commit.at)}
            </div>
          {/if}
          {#if deploy.log?.length}
            <div class="text-xs space-y-0.5 pt-1">
              {#each deploy.log as entry, i (i)}
                <div class={/FAILED|not deployed/.test(entry.text) ? 'text-red-700' : ''}>
                  <span class="text-muted-foreground">{ago(entry.at)}</span>
                  {entry.text}
                </div>
              {/each}
            </div>
          {:else}
            <div class="text-xs text-muted-foreground">deploy.log is empty</div>
          {/if}
        </div>
      {/if}
      <!-- Every hook the gateway maps: what it is (URL, agent, model, how the transform runs the
           agent) and which Appmixer integration instance calls it. A hook nothing calls, or a
           hook that nginx does not expose, is flagged. -->
      {#each openclaw.hooks || [] as hook (hook.id)}
        {@const runs = runsOfHook(hook.id)}
        <div class="border rounded-lg p-3 space-y-1 text-sm">
          <div class="flex flex-wrap items-center gap-3">
            <span class="font-medium">{hook.id}</span>
            <code class="text-xs">{hook.url}</code>
            {#if hook.exposed === false}
              <Badge variant="outline" class="text-red-700">not exposed by nginx</Badge>
            {/if}
          </div>
          <div class="text-xs text-muted-foreground">
            POST → agent <span class="text-foreground">{hook.agentId}</span> · {hook.model}
            {#if hook.transform}· transform <code>{hook.transform}</code>{/if}
            {#if hook.sessionMode}· {hook.sessionMode} session{/if}
            {#if hook.sessionKey}<code class="ml-1">{hook.sessionKey}</code>{/if}
            {#if hook.timeoutSeconds}· timeout {Math.round(hook.timeoutSeconds / 60)} min{/if}
          </div>
          {#if hook.description}
            <div class="text-xs text-muted-foreground">{hook.description}</div>
          {/if}
          <div class="text-xs flex flex-wrap items-center gap-2">
            <span class="text-muted-foreground">called by</span>
            {#if hook.callers?.length}
              {#each hook.callers as caller (caller.flowId)}
                <Badge
                  variant="outline"
                  class={caller.stage === 'running' ? 'text-green-700' : 'text-red-700'}
                  >{caller.stage}</Badge
                >
                {#if designer(caller.flowId)}
                  <a
                    class="hover:underline"
                    href={designer(caller.flowId)}
                    target="_blank"
                    rel="noreferrer">{caller.name}</a
                  >
                {:else}
                  <span>{caller.name}</span>
                {/if}
                <span class="text-muted-foreground">({caller.component})</span>
              {/each}
            {:else if data.appmixer?.error}
              <span class="text-muted-foreground">unknown — Appmixer: {data.appmixer.error}</span>
            {:else}
              <span class="text-red-700">no Appmixer integration instance posts to this URL</span>
            {/if}
          </div>
          {#if runs.length}
            <div class="text-xs text-muted-foreground pt-1">
              {runs.length} run{runs.length === 1 ? '' : 's'} in the last 7 days
            </div>
            {@render hookRunRows(runs)}
          {:else}
            <div class="text-xs text-muted-foreground pt-1">no run in the last 7 days</div>
          {/if}
        </div>
      {/each}
      {#if unmatchedRuns.length}
        <div class="space-y-1">
          <div class="text-sm font-medium">Hook runs matched to no hook</div>
          {@render hookRunRows(unmatchedRuns)}
        </div>
      {/if}
      {#if strayResponderRuns.length}
        <!-- Runs of the mention responder (one per resolve.sh call) that fall into no hook run
             above — normally none: a run started by hand on the host, or one whose hook run is
             older than the transcripts kept. skipped = resolve.sh found nothing to do (PR closed,
             not by apx-vero, or every mention answered), pending = the agent is still working,
             failed = it never wrote its replies, shadow = answered into the shadow log only. -->
        <div class="text-sm font-medium">Responder runs outside any hook call</div>
        <div class="border rounded-lg divide-y">
          {#each strayResponderRuns as entry}
            <div class="px-3 py-2 text-xs space-y-1">
              <div class="flex flex-wrap items-center gap-3">
                <span
                  class="px-2 py-0.5 rounded border {entry.status === 'replied'
                    ? 'bg-green-50 text-green-700 border-green-200'
                    : entry.status === 'failed'
                      ? 'bg-red-50 text-red-700 border-red-200'
                      : entry.status === 'skipped'
                        ? 'bg-muted text-muted-foreground'
                        : 'bg-amber-50 text-amber-800 border-amber-200'}">{entry.status}</span
                >
                <a
                  class="hover:underline font-medium"
                  href={entry.url}
                  target="_blank"
                  rel="noreferrer"
                  >PR #{entry.pr}{#if entry.title}
                    · {entry.title}{/if}</a
                >
                <span class="text-muted-foreground">{ago(entry.at)}</span>
                {#if entry.reason}<span class="text-muted-foreground">{entry.reason}</span>{/if}
                {#if entry.mentions?.length}
                  <span class="text-muted-foreground">
                    {entry.mentions.length} mention{entry.mentions.length === 1 ? '' : 's'} by
                    {[...new Set(entry.mentions.map((/** @type {any} */ m) => m.author))].join(
                      ', '
                    )}
                  </span>
                {/if}
                {#if entry.durationMs != null}
                  <span class="text-muted-foreground">{Math.round(entry.durationMs / 1000)} s</span>
                {/if}
                {#if entry.code_changed}<span class="text-amber-800">pushed a change</span>{/if}
              </div>
              {#each entry.replies || [] as reply}
                <div class="whitespace-pre-wrap pl-2 border-l-2">{reply.body}</div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </section>
</div>
