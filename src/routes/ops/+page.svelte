<script>
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, tick, untrack } from 'svelte';
  import {
    Check,
    ChevronDown,
    ChevronRight,
    Copy,
    ExternalLink,
    Maximize2,
    Minimize2,
    RefreshCw,
    RotateCcw,
    ScrollText,
    X
  } from 'lucide-svelte';

  let { data } = $props();

  const appmixer = $derived(data.appmixer?.data);
  const workflows = $derived(data.workflows?.data);
  const openclaw = $derived(data.openclaw?.data);
  const watched = $derived(data.watched?.data);

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
  let showDeployLog = $state(false);

  // Runs of the pipeline stages on the OpenClaw host, newest first, running ones included. A
  // stage line of the pipeline comment on GitHub links here with ?run=<dir>: its card and the run
  // open and the page scrolls to it. Older cards past the first few stay behind "Show all".
  /** @type {any[]} */
  const pipelineRuns = $derived(openclaw?.pipelineRuns || []);
  const linkedRun = $derived(page.url.searchParams.get('run') || '');
  /** Pipeline runs expanded to their log, report and agent steps, by run directory. */
  /** @type {Record<string, boolean>} */
  let openPipelineRuns = $state({});
  let allPipelineRuns = $state(false);
  const pipelineRunning = $derived(pipelineRuns.filter((run) => run.result === 'running').length);

  // The runs grouped by the board card they worked on: one card per issue, with every stage run
  // for it (Build on the issue, Testing and Fix on its PR) and the @apx-vero mentions on that PR,
  // newest first. The card's place on the board comes from GitHub (data.cards).
  /** @type {Record<string, any>} */
  const boardCards = $derived(data.cards?.data || {});
  /** Statuses a card waits on a person in */
  const WAITING = ['Needs input', 'Review'];
  const cards = $derived.by(() => {
    /** @type {Map<string, any>} */
    const byKey = new Map();
    for (const run of pipelineRuns) {
      const key = run.itemNodeId || run.target || run.issue || (run.pr ? `pr:${run.pr}` : run.dir);
      if (!byKey.has(key)) {
        byKey.set(key, { key, itemNodeId: run.itemNodeId || null, runs: [], mentions: [] });
      }
      byKey.get(key).runs.push(run);
    }
    /** @param {any} run */
    const prOf = (run) => run.pr || Number(String(run.prUrl || '').split('/').pop()) || null;
    const list = [...byKey.values()].map((card) => {
      const board = card.itemNodeId ? boardCards[card.itemNodeId] || null : null;
      const prs = [...new Set(card.runs.map(prOf).filter(Boolean))];
      const target = card.runs.find((/** @type {any} */ r) => r.target)?.target || card.runs[0].issue;
      return {
        ...card,
        board,
        target,
        prs,
        last: card.runs[0],
        lastAt: card.runs[0].at,
        running: card.runs.some((/** @type {any} */ r) => r.result === 'running'),
        costUsd: card.runs.reduce(
          (/** @type {number} */ sum, /** @type {any} */ r) => sum + (r.agent?.costUsd || 0),
          0
        )
      };
    });
    // The mentions on a card's PR: the mention responder keeps the last few runs
    for (const mention of openclaw?.mentionResponder?.recent || []) {
      const card = list.find((c) => c.prs.includes(mention.pr));
      if (card) card.mentions.push(mention);
    }
    for (const card of list) {
      // One timeline: stage runs and mentions by time, newest first
      card.items = [
        ...card.runs.map((/** @type {any} */ run) => ({ kind: 'run', at: run.at, run })),
        ...card.mentions.map((/** @type {any} */ mention) => ({ kind: 'mention', at: mention.at, mention }))
      ].sort((a, b) => b.at.localeCompare(a.at));
      if (card.mentions.length && card.mentions[0].at > card.lastAt) card.lastAt = card.mentions[0].at;
    }
    // Work under way first, then cards waiting on a person, then the rest; newest first in each
    /** @param {any} c */
    const rank = (c) => (c.running ? 0 : WAITING.includes(c.board?.status) ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b) || b.lastAt.localeCompare(a.lastAt));
  });
  /** Mentions on PRs that belong to no card, shown under the OpenClaw host */
  const looseMentions = $derived(
    (openclaw?.mentionResponder?.recent || []).filter(
      (/** @type {any} */ m) => !cards.some((c) => c.prs.includes(m.pr))
    )
  );
  const CARDS_SHOWN = 10;
  /** Cards expanded to their runs, by key */
  /** @type {Record<string, boolean>} */
  let openCards = $state({});
  const shownCards = $derived(
    allPipelineRuns
      ? cards
      : cards.filter(
          (card, i) =>
            i < CARDS_SHOWN ||
            card.running ||
            card.runs.some((/** @type {any} */ r) => r.dir === linkedRun)
        )
  );
  $effect(() => {
    const dir = linkedRun;
    if (!dir || !pipelineRuns.some((run) => run.dir === dir)) return;
    const card = cards.find((c) => c.runs.some((/** @type {any} */ r) => r.dir === dir));
    if (card) untrack(() => (openCards[card.key] = true));
    openPipelineRuns[dir] = true;
    // Untracked: loadTrace reads the load state, and its changes must not run this effect again
    untrack(() => loadTrace(dir));
    tick().then(() =>
      document.getElementById(`run-${dir}`)?.scrollIntoView({ block: 'center' })
    );
  });
  // A run directory is named <issue or PR>-<yyyymmdd>-<hhmmss> (UTC), so a linked run that is not in
  // the host status yet can be told apart from one that is too old for it.
  const linkedRunAt = $derived.by(() => {
    const m = /^c?\d+-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(linkedRun);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : '';
  });
  const linkedRunMissing = $derived(
    !!linkedRun && !!openclaw?.pipelineRuns && !pipelineRuns.some((run) => run.dir === linkedRun)
  );
  // Started after the status was built: it shows up with the next build (every minute)
  const linkedRunPending = $derived(
    linkedRunMissing &&
      !!linkedRunAt &&
      !!openclaw?.generatedAt &&
      Date.parse(linkedRunAt) >= Date.parse(openclaw.generatedAt) - 60000
  );
  // While it is pending, reload the page data every 30 s for up to 10 minutes; the effect that
  // opens a linked run takes over once it is there
  $effect(() => {
    if (!linkedRunPending) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 10 * 60000) clearInterval(timer);
      else invalidateAll();
    }, 30000);
    return () => clearInterval(timer);
  });
  /** @param {number | null | undefined} sec */
  const seconds = (sec) => (sec == null ? '' : duration(sec * 1000));
  /** @param {string} value */
  const stamp = (value) => new Date(value).toLocaleString();

  // The trace of an expanded run, from /api/ops/pipeline-run: the card move, the Appmixer
  // integrations and the OpenClaw hook around it, in order. Loaded once per run.
  /** @type {Record<string, { loading: boolean, error: string | null, events: any[] }>} */
  let traces = $state({});
  /** @type {Record<string, boolean>} */
  let openTraceSteps = $state({});
  /** What is expanded in the run trees of the traces, as `panel` of the step snippet */
  let tracePanel = $state({ open: /** @type {Record<string, boolean>} */ ({}) });
  // Every step of a run's agent turn in full, from /api/ops/agent-steps; null steps = the host
  // keeps no detail file for the run, so only the titles from the status show
  /** @type {Record<string, { loading: boolean, error: string | null, steps: any[] | null }>} */
  let agentSteps = $state({});
  /** @type {Record<string, boolean>} */
  let openAgentSteps = $state({});
  /** Text blocks just copied, by key: the copy icon turns into a check for a moment */
  /** @type {Record<string, boolean>} */
  let copied = $state({});
  /** @param {string} key @param {string} text */
  async function copyText(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      copied[key] = true;
      setTimeout(() => delete copied[key], 1500);
    } catch {
      /* the browser refused the clipboard */
    }
  }
  /** Text blocks shown whole after a double click, by key */
  /** @type {Record<string, boolean>} */
  let wholeText = $state({});
  /** @param {string} dir @param {boolean} [retry] - load again after an error */
  async function loadAgentSteps(dir, retry = false) {
    if (agentSteps[dir] && !(retry && agentSteps[dir].error)) return;
    agentSteps[dir] = { loading: true, error: null, steps: null };
    try {
      const response = await fetch(`/api/ops/agent-steps?dir=${encodeURIComponent(dir)}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message || `HTTP ${response.status}`);
      agentSteps[dir] = { loading: false, error: null, steps: body.steps };
    } catch (err) {
      agentSteps[dir] = {
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        steps: null
      };
    }
  }

  /** @param {string} dir */
  async function loadTrace(dir) {
    loadAgentSteps(dir);
    if (traces[dir] && !traces[dir].error) return;
    traces[dir] = { loading: true, error: null, events: [] };
    try {
      const response = await fetch(`/api/ops/pipeline-run?dir=${encodeURIComponent(dir)}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message || `HTTP ${response.status}`);
      traces[dir] = { loading: false, error: null, events: body.events || [] };
    } catch (err) {
      traces[dir] = {
        loading: false,
        error: err instanceof Error ? err.message : String(err),
        events: []
      };
    }
  }
  /** Where an event of a trace happened, as a short tag and its colour */
  const SOURCES = /** @type {Record<string, { tag: string, cls: string }>} */ ({
    github: { tag: 'GitHub', cls: 'bg-slate-100 text-slate-700 border-slate-300' },
    appmixer: { tag: 'Appmixer', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
    openclaw: { tag: 'OpenClaw', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
    host: { tag: 'host', cls: 'bg-orange-50 text-orange-800 border-orange-200' }
  });
  /** @param {string} value */
  const clock = (value) =>
    new Date(value).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });

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

  /** The bar that ties an input to what came of it, by how the message ended */
  const messageBar = /** @type {Record<string, string>} */ ({
    ok: 'border-l-green-500/70',
    retried: 'border-l-amber-500/80',
    error: 'border-l-red-500/80',
    none: 'border-l-border'
  });

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

  // Watched flows: any flow added by its id or designer URL, kept in the viewer's settings
  let watchInput = $state('');
  let watchLabel = $state('');
  let watching = $state(false);
  /** @type {string | null} */
  let watchError = $state(null);
  /** @type {Record<string, boolean>} */
  let unwatching = $state({});

  async function watch(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (!watchInput.trim()) return;
    watching = true;
    watchError = null;
    try {
      const response = await fetch('/api/ops/watched', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: watchInput, label: watchLabel })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.message || `HTTP ${response.status}`);
      watchInput = '';
      watchLabel = '';
      await invalidateAll();
    } catch (e) {
      watchError = /** @type {Error} */ (e).message;
    } finally {
      watching = false;
    }
  }

  /** @param {string} flowId */
  async function unwatch(flowId) {
    unwatching[flowId] = true;
    try {
      const response = await fetch(`/api/ops/watched?flowId=${flowId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      delete logPanels[flowId];
      await invalidateAll();
    } catch (e) {
      watchError = /** @type {Error} */ (e).message;
    } finally {
      delete unwatching[flowId];
    }
  }

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

<!-- One flow on /ops — an integration instance or a watched flow: its state, errors, last
     activity, and the run tree loaded on demand. -->
{#snippet flowRow(/** @type {any} */ instance, isWatched = false)}
<div
  class="flex flex-wrap items-center gap-3 text-sm pl-3 border-l-2 {instance.stage === 'running' && !instance.unreachable
    ? 'border-green-400'
    : 'border-red-400'}"
>
  {#if isWatched}
    <span class="font-medium" title={instance.flowId}
      >{instance.label || instance.name || instance.flowId}</span
    >
    {#if instance.label && instance.name && instance.label !== instance.name}
      <span class="text-xs text-muted-foreground">{instance.name}</span>
    {/if}
  {/if}
  {#if instance.unreachable}
    <span class="text-xs text-red-700">{instance.unreachable}</span>
  {:else}
    <Badge
      variant="outline"
      class={instance.stage === 'running' ? 'text-green-700' : 'text-red-700'}
      >{instance.stage}</Badge
    >
  {/if}
  {#if isWatched}
    {#if instance.type === 'integration-instance'}
      <span class="text-xs text-muted-foreground">integration instance</span>
    {/if}
  {:else}
    <span class="text-xs text-muted-foreground">rev {instance.revision ?? '—'}</span>
  {/if}
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
  {#if instance.unreachable}
    <!-- the reason is shown next to the name -->
  {:else if instance.errors?.error}
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
          class="text-xs text-muted-foreground truncate {isWatched ? 'basis-0 grow min-w-0' : 'max-w-xl'}"
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
  {#if isWatched}
    <button
      type="button"
      class="text-xs text-muted-foreground hover:text-red-700"
      title="Stop watching this flow"
      disabled={unwatching[instance.flowId]}
      onclick={() => unwatch(instance.flowId)}><X size={12} /></button
    >
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
{/snippet}

<!-- The icons in the top right corner of a text block: show it whole (or cut it again), copy it -->
{#snippet blockTools(/** @type {string} */ key, /** @type {string} */ text)}
  <div
    class="absolute top-1 right-1 flex gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity"
  >
    <button
      type="button"
      class="p-1 rounded border bg-background text-muted-foreground hover:text-foreground"
      title={wholeText[key] ? 'Shorten (or double-click the text)' : 'Show all (or double-click the text)'}
      aria-label={wholeText[key] ? 'Shorten' : 'Show all'}
      onclick={() => (wholeText[key] = !wholeText[key])}
    >
      {#if wholeText[key]}<Minimize2 size={12} />{:else}<Maximize2 size={12} />{/if}
    </button>
    <button
      type="button"
      class="p-1 rounded border bg-background {copied[key]
        ? 'text-green-600'
        : 'text-muted-foreground hover:text-foreground'}"
      title={copied[key] ? 'Copied' : 'Copy'}
      aria-label="Copy"
      onclick={() => copyText(key, text)}
    >
      {#if copied[key]}<Check size={12} />{:else}<Copy size={12} />{/if}
    </button>
  </div>
{/snippet}

<!-- A block of text cut to a few lines; the icon in its corner or a double click (or double tap)
     shows it whole -->
{#snippet textBlock(/** @type {string} */ key, /** @type {string} */ text, /** @type {string} */ height)}
  <div class="relative group">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <pre
      title={wholeText[key] ? 'Double-click to shorten' : 'Double-click to show all'}
      ondblclick={() => (wholeText[key] = !wholeText[key])}
      class="p-2 pr-16 bg-muted/30 border rounded text-[11px] font-mono whitespace-pre-wrap break-all {wholeText[
        key
      ]
        ? ''
        : `${height} overflow-auto`}">{text}</pre>
    {@render blockTools(key, text)}
  </div>
{/snippet}

<!-- One step of an agent turn: a row with its outcome, title, tool and time; opened, the code it
     ran, the calls that code made with their output, and what it returned -->
{#snippet agentStep(/** @type {string} */ dir, /** @type {any} */ s, /** @type {number} */ i)}
  {@const key = `${dir}#${i}`}
  {@const failedCalls = (s.calls || []).filter((/** @type {any} */ c) => c.error).length}
  <li>
    <button
      type="button"
      class="w-full flex items-center gap-2 py-0.5 text-left"
      onclick={() => (openAgentSteps[key] = !openAgentSteps[key])}
    >
      {@render chevron(!!openAgentSteps[key])}
      <span class="text-muted-foreground w-6 text-right shrink-0">{i + 1}.</span>
      {#if s.error}
        <X size={14} strokeWidth={3} class="shrink-0 text-red-600" aria-label="error" />
      {:else if s.output === null}
        <span class="w-3.5 shrink-0 text-amber-600" title="no result recorded">…</span>
      {:else}
        <Check size={14} strokeWidth={3} class="shrink-0 text-green-600" aria-label="ok" />
      {/if}
      <span class="font-medium truncate">{s.title}</span>
      <code class="text-muted-foreground">{s.tool}</code>
      {#if s.calls?.length}
        <span class="text-muted-foreground whitespace-nowrap"
          >{s.calls.length} {s.calls.length === 1 ? 'call' : 'calls'}{#if failedCalls}<span
              class="text-red-700"> · {failedCalls} failed</span
            >{/if}</span
        >
      {/if}
      {#if s.durationMs != null}
        <span class="ml-auto text-muted-foreground whitespace-nowrap"
          >{duration(s.durationMs)}</span
        >
      {/if}
    </button>
    {#if openAgentSteps[key]}
      <div class="ml-12 my-1 space-y-1">
        {#if s.input}
          <div class="text-muted-foreground">code</div>
          {@render textBlock(`${key}:in`, s.input, 'max-h-48')}
        {/if}
        {#each s.calls || [] as call, j (j)}
          <div class="border-l-2 pl-2 space-y-1 {call.error ? 'border-red-300' : 'border-border'}">
            <div class="flex items-center gap-2">
              {#if call.error}
                <X size={12} strokeWidth={3} class="shrink-0 text-red-600" />
              {:else}
                <Check size={12} strokeWidth={3} class="shrink-0 text-green-600" />
              {/if}
              <code class="font-medium">{call.tool}</code>
              {#if call.exitCode != null}<span
                  class={call.exitCode ? 'text-red-700' : 'text-muted-foreground'}
                  >exit {call.exitCode}</span
                >{/if}
            </div>
            {@render textBlock(`${key}:c${j}:in`, call.input, 'max-h-32')}
            {#if call.output}
              {@render textBlock(`${key}:c${j}:out`, call.output, 'max-h-48')}
            {/if}
          </div>
        {/each}
        {#if s.output}
          <div class="text-muted-foreground">result</div>
          {@render textBlock(`${key}:out`, s.output, 'max-h-48')}
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

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
        <!-- The outcome as an icon: a green check, a red cross, amber for a retry that went through -->
        {#if status === 'ok'}
          <Check size={14} strokeWidth={3} class="shrink-0 text-green-600" aria-label="ok" />
        {:else if status === 'error'}
          <X size={14} strokeWidth={3} class="shrink-0 text-red-600" aria-label="error" />
        {:else if status === 'retried'}
          <RotateCcw size={13} strokeWidth={2.5} class="shrink-0 text-amber-600" aria-label="retried" />
        {:else}
          <span class="px-1.5 rounded border whitespace-nowrap {statusClass[status]}">{status}</span>
        {/if}
        <span class="font-medium whitespace-nowrap px-1.5 rounded border border-border/70" title={node.type}
          >{node.label}</span
        >
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
        {#if node.messages?.length > 1}
          <!-- Many messages: each input with what the component sent and logged handling it, tied
               together by a bar in the colour of how it ended -->
          {#each node.messages as message (message.id)}
            <div
              class="relative ml-1 my-0.5 border-l-2 {messageBar[message.status] || messageBar.none}"
              title={message.status === 'error'
                ? `${message.error}${message.retries > 1 ? ` · ${message.retries} failed attempts` : ''}`
                : message.retries
                  ? `succeeded after ${message.retries} failed attempt${message.retries === 1 ? '' : 's'}`
                  : ''}
            >
              {#each [message.input, ...message.entries].filter(Boolean) as entry, i (entry.id)}
                {@render entryRow(panel, key, entry, message.input ? i > 0 : false)}
              {/each}
            </div>
          {/each}
        {:else}
          {#each node.entries as entry (entry.id)}
            {@render entryRow(panel, key, entry)}
          {/each}
        {/if}
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

{#snippet entryRow(
  /** @type {any} */ panel,
  /** @type {string} */ key,
  /** @type {any} */ entry,
  /** @type {boolean} */ linked = false
)}
  {@const entryKey = `${key}#${entry.id}`}
  <div class="px-2 py-1">
    <button
      type="button"
      class="w-full flex items-center gap-2 text-left"
      onclick={() => (panel.open[entryKey] = !panel.open[entryKey])}
    >
      {#if linked}
        <!-- What came of the input on the row above -->
        <span class="text-muted-foreground/70 -mr-1" aria-hidden="true">↳</span>
      {/if}
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
      <!-- What the entry is: a message the component received (input), one it sent from
           a port (output), or a line it logged itself (context.log), shown quieter -->
      {#if entry.port}
        <span
          class="px-1.5 rounded border whitespace-nowrap {entry.direction === 'in'
            ? 'bg-sky-50 text-sky-700 border-sky-200'
            : 'bg-emerald-50 text-emerald-700 border-emerald-200'}"
          >{entry.direction === 'in' ? 'input' : 'output'}
          <code>{entry.port}</code></span
        >
      {:else if entry.severity === 'info'}
        <span class="px-1.5 rounded border border-dashed whitespace-nowrap text-muted-foreground/70"
          >log</span
        >
      {/if}
      <span
        class="truncate {entry.severity === 'error'
          ? 'text-red-700'
          : entry.port
            ? 'text-muted-foreground'
            : 'text-muted-foreground/60 italic'}">{entry.summary}</span
      >
    </button>
    {#if panel.open[entryKey]}
      <div class="relative group mt-1 ml-5">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <pre
          title={wholeText[entryKey] ? 'Double-click to shorten' : 'Double-click to show all'}
          ondblclick={() => (wholeText[entryKey] = !wholeText[entryKey])}
          class="p-2 pr-16 bg-muted/30 border rounded text-[11px] whitespace-pre-wrap break-all {wholeText[
            entryKey
          ]
            ? ''
            : 'max-h-80 overflow-auto'}">{#each jsonTokens(entry.detail) as token}{#if token.kind}<span
                class={tokenClass[token.kind]}>{token.text}</span
              >{:else}{token.text}{/if}{/each}</pre>
        {@render blockTools(entryKey, entry.detail)}
      </div>
    {/if}
  </div>
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
  <div class="grid grid-cols-2 md:grid-cols-7 gap-3">
    <a
      href="#pipeline"
      class="border rounded-lg p-3 hover:bg-muted/50 {pipelineRunning
        ? 'bg-amber-50 border-amber-200'
        : ''}"
    >
      <div class="text-2xl font-bold">{pipelineRunning}</div>
      <div class="text-xs text-muted-foreground">Pipeline stages running</div>
    </a>
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

  <!-- Pipeline runs -->
  <section id="pipeline" class="space-y-3">
    <div class="flex items-baseline gap-4">
      <h2 class="text-xl font-semibold">Pipeline runs</h2>
      <span class="text-xs text-muted-foreground">
        by board card: every stage run on the OpenClaw host and the mentions on its PR, last 14
        days{#if openclaw?.generatedAt}
          · host status {ago(openclaw.generatedAt)}, rebuilt every minute{/if}
      </span>
    </div>
    {#if data.openclaw?.error}
      <p class="text-sm text-red-700">{data.openclaw.error}</p>
    {:else if !openclaw?.configured}
      <p class="text-sm text-muted-foreground">OpenClaw status is not configured.</p>
    {:else if !pipelineRuns.length}
      <p class="text-sm text-muted-foreground">
        No stage ran in the last 14 days{#if openclaw && !openclaw.pipelineRuns}
          (the host status has no pipeline runs yet: its builder predates them){/if}.
      </p>
    {:else}
      {#if linkedRunPending}
        <p class="text-sm text-amber-800">
          Run {linkedRun} started at {stamp(linkedRunAt)}, after the host status was last built
          ({stamp(openclaw.generatedAt)}). The host rebuilds it every minute; this page checks
          every 30 seconds and opens the run as soon as it is there.
        </p>
      {:else if linkedRunMissing}
        <p class="text-sm text-amber-800">
          Run {linkedRun}{#if linkedRunAt}, started {stamp(linkedRunAt)},{/if} is not in the host status:
          it keeps the runs of the last 14 days.
        </p>
      {/if}
      <!-- One row per run of a stage (Build, Testing, Fix, Doc&Verification): what it ran on,
           its result and summary. A row expands to the stage report, the tail of the runner
           log, the agent's steps and the result callbacks to Appmixer. -->
      <!-- One row per board card: where it stands, its issue and PR, the last result, what it cost.
           Opened, its timeline: every stage run (as below) and the mentions on its PR. -->
      <div class="border rounded-lg divide-y">
        {#each shownCards as card (card.key)}
          {@const cardOpen = !!openCards[card.key]}
          {@const status = card.board?.status}
          <div class="text-xs">
            <button
              type="button"
              class="flex flex-wrap items-center gap-3 w-full text-left px-3 py-2 hover:bg-muted/30"
              onclick={() => (openCards[card.key] = !cardOpen)}
            >
              {@render chevron(cardOpen)}
              <span
                class="px-2 py-0.5 rounded border whitespace-nowrap {card.running
                  ? 'bg-sky-50 text-sky-800 border-sky-300 animate-pulse'
                  : WAITING.includes(status)
                    ? 'bg-amber-50 text-amber-800 border-amber-300'
                    : /done|released/i.test(status || '') || card.board?.state === 'CLOSED'
                      ? 'bg-green-50 text-green-700 border-green-200'
                      : 'bg-muted text-muted-foreground border-border'}"
                title={status
                  ? 'Status on the board now'
                  : 'The card is no longer on the board (removed, or its issue was moved)'}
                >{status || (card.running ? 'running' : 'off the board')}</span
              >
              {#if card.target}
                {@const [repo, number] = card.target.split('#')}
                <a
                  class="font-semibold hover:underline whitespace-nowrap"
                  href="https://github.com/{repo}/issues/{number}"
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}
                  >{repo.replace('Appmixer-ai/appmixer-', '')}#{number}</a
                >
              {/if}
              {#if card.board?.title}<span class="font-medium truncate max-w-xl" title={card.board.title}
                  >{card.board.title}</span
                >{/if}
              {#each card.prs as pr (pr)}
                <a
                  class="hover:underline whitespace-nowrap"
                  href="https://github.com/Appmixer-ai/appmixer-connectors/pull/{pr}"
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}>PR #{pr}</a
                >
              {/each}
              <span class="text-muted-foreground whitespace-nowrap"
                >last: {card.last.name}
                <span
                  class={card.last.result === 'passed'
                    ? 'text-green-700'
                    : card.last.result === 'running'
                      ? 'text-sky-700'
                      : card.last.result === 'blocked'
                        ? 'text-amber-800'
                        : 'text-red-700'}>{card.last.result}</span
                ></span
              >
              <span class="ml-auto text-muted-foreground whitespace-nowrap" title={stamp(card.lastAt)}
                >{ago(card.lastAt)} · {card.runs.length}
                {card.runs.length === 1 ? 'run' : 'runs'}{#if card.mentions.length}
                  · {card.mentions.length}
                  {card.mentions.length === 1 ? 'mention' : 'mentions'}{/if}{#if card.costUsd}
                  · ${card.costUsd.toFixed(2)}{/if}</span
              >
            </button>
            {#if cardOpen}
              <div class="ml-5 mb-2 mr-2 border-l pl-2 divide-y">
                {#each card.items as item (item.kind + item.at + (item.run?.dir || item.mention?.pr))}
                  {#if item.kind === 'mention'}
                    {@const m = item.mention}
                    <div class="px-3 py-2 flex flex-wrap items-center gap-3">
                      <span
                        class="px-2 py-0.5 rounded border {m.status === 'replied'
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : m.status === 'failed'
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-muted text-muted-foreground border-border'}">{m.status}</span
                      >
                      <span class="font-medium">@apx-vero mention</span>
                      <a class="hover:underline" href={m.url} target="_blank" rel="noreferrer"
                        >PR #{m.pr}</a
                      >
                      <span title={stamp(m.at)}>{ago(m.at)}</span>
                      <span class="text-muted-foreground"
                        >{m.mentions?.length || 0} asked · {m.replies?.length || 0} answered{#if m.code_changed}
                          · code changed{/if}{#if m.reason} · {m.reason}{/if}</span
                      >
                    </div>
                  {:else}
          {@const run = item.run}
          {@const open = openPipelineRuns[run.dir]}
          <div
            id="run-{run.dir}"
            class="px-3 py-2 text-xs space-y-1 {run.dir === linkedRun
              ? 'bg-amber-50 ring-1 ring-inset ring-amber-300'
              : ''}"
          >
            <button
              type="button"
              class="flex flex-wrap items-center gap-3 w-full text-left"
              onclick={() => {
                // `open` is derived from openPipelineRuns: read it before the toggle changes it
                const opening = !openPipelineRuns[run.dir];
                openPipelineRuns[run.dir] = opening;
                if (opening) loadTrace(run.dir);
              }}
            >
              {@render chevron(!!open)}
              <span
                class="px-2 py-0.5 rounded border {run.result === 'passed'
                  ? 'bg-green-50 text-green-700 border-green-200'
                  : run.result === 'running'
                    ? 'bg-amber-50 text-amber-800 border-amber-300 animate-pulse'
                    : run.result === 'blocked'
                      ? 'bg-amber-50 text-amber-800 border-amber-200'
                      : 'bg-red-50 text-red-700 border-red-200'}">{run.result}</span
              >
              <span class="font-medium">{run.name}</span>
              {#if run.issue}
                {@const [repo, number] = run.issue.split('#')}
                <a
                  class="hover:underline font-medium"
                  href="https://github.com/{repo}/issues/{number}"
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}
                  >{repo.replace('Appmixer-ai/appmixer-', '')}#{number}</a
                >
              {:else if run.pr}
                <a
                  class="hover:underline font-medium"
                  href="https://github.com/Appmixer-ai/appmixer-connectors/pull/{run.pr}"
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}>PR #{run.pr}</a
                >
              {/if}
              {#if run.target && run.target !== run.issue}
                {@const [repo, number] = run.target.split('#')}
                <a
                  class="hover:underline"
                  href="https://github.com/{repo}/issues/{number}"
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}
                  >card {repo.replace('Appmixer-ai/appmixer-', '')}#{number}</a
                >
              {/if}
              {#if run.prUrl && !run.pr}
                <a
                  class="hover:underline font-medium"
                  href={run.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  onclick={(e) => e.stopPropagation()}>→ PR #{run.prUrl.split('/').pop()}</a
                >
              {/if}
              <span title={stamp(run.at)}>{ago(run.at)}</span>
              <span class="text-muted-foreground">
                {#if run.result === 'running'}running for {seconds(
                    Math.round((Date.now() - new Date(run.at).getTime()) / 1000)
                  )}{:else}{seconds(run.durationSec)}{/if}
              </span>
              {#if run.agent?.costUsd}<span class="text-muted-foreground"
                  >${run.agent.costUsd.toFixed(2)}</span
                >{/if}
              {#if run.summary}<span
                  class="text-muted-foreground truncate max-w-2xl"
                  title={run.summary}>{run.summary}</span
                >{/if}
            </button>
            {#if open}
              <div class="pl-6 space-y-2">
                <div class="text-muted-foreground">
                  run <code>{run.dir}</code> · {run.hookId} · started {stamp(run.at)}{#if run.finishedAt}
                    · finished {stamp(run.finishedAt)}{/if}{#if run.agent}
                    · {run.agent.model}{/if}
                </div>
                <!-- The trace: card move → dispatcher integration → OpenClaw hook → host run →
                     results back → result integration (comment, card move) → next move -->
                <div class="border rounded p-2 space-y-1">
                  <div class="text-muted-foreground">Trace</div>
                  {#if !traces[run.dir] || traces[run.dir].loading}
                    <div class="text-muted-foreground">Searching the Appmixer log…</div>
                  {:else if traces[run.dir].error}
                    <div class="text-red-700">
                      {traces[run.dir].error}
                      <button
                        type="button"
                        class="underline ml-2"
                        onclick={() => loadTrace(run.dir)}>retry</button
                      >
                    </div>
                  {:else}
                    <ol class="space-y-1">
                      {#each traces[run.dir].events as event, i (i)}
                        {@const source = SOURCES[event.source] || SOURCES.host}
                        {@const key = `${run.dir}:${i}`}
                        <li class="flex flex-wrap items-baseline gap-2">
                          <span class="font-mono text-muted-foreground w-16 shrink-0"
                            >{clock(event.at)}</span
                          >
                          <span class="px-1.5 py-0.5 rounded border w-20 text-center shrink-0 {source.cls}"
                            >{source.tag}</span
                          >
                          <span
                            class={event.status === 'error'
                              ? 'text-red-700 font-medium'
                              : event.status === 'running'
                                ? 'text-amber-800 font-medium'
                                : event.status === 'info'
                                  ? 'text-muted-foreground italic'
                                  : 'font-medium'}
                            >{event.status === 'error' ? '✗ ' : ''}{event.title}</span
                          >
                          {#if event.detail}<span class="text-muted-foreground">{event.detail}</span
                            >{/if}
                          {#if event.steps?.length && !event.run}
                            <button
                              type="button"
                              class="text-muted-foreground underline"
                              onclick={() => (openTraceSteps[key] = !openTraceSteps[key])}
                              >{openTraceSteps[key] ? 'hide' : `${event.steps.length} steps`}</button
                            >
                          {/if}
                          {#if event.flowId}
                            <a
                              class="text-muted-foreground hover:underline inline-flex items-center gap-0.5"
                              href={event.flowId}
                              target="_blank"
                              rel="noreferrer">designer <ExternalLink class="h-3 w-3" /></a
                            >
                          {/if}
                        </li>
                        {#if event.run}
                          <!-- The run as the integration panels draw it: open it for every
                               component and what it received and sent -->
                          <li class="ml-40 border rounded bg-background px-2">
                            {@render step(tracePanel, key, event.run.root, event.run, true)}
                          </li>
                        {:else if openTraceSteps[key]}
                          <li class="pl-40">
                            <ol class="list-decimal pl-4 text-muted-foreground">
                              {#each event.steps as step}
                                <li class={step.error ? 'text-red-700' : ''}>
                                  {step.label}{step.port ? ` → ${step.port}` : ''}{step.text
                                    ? ` · ${step.text}`
                                    : ''}
                                </li>
                              {/each}
                            </ol>
                          </li>
                        {/if}
                      {/each}
                    </ol>
                  {/if}
                </div>
                {#if run.result === 'running'}
                  <div class="text-amber-800">
                    Still running. The agent's steps show here once its turn ends; the host status is
                    rebuilt every minute, so refresh for news.
                  </div>
                {:else if run.result === 'unfinished'}
                  <div class="text-red-700">
                    No result after 3 hours: the run died without reporting. Move the card again to
                    restart the stage.
                  </div>
                {/if}
                {#if run.summary}
                  <div class="whitespace-pre-wrap">{run.summary}</div>
                {/if}
                {#if run.report}
                  <div class="whitespace-pre-wrap border-l-2 border-amber-300 pl-2">
                    {run.report}
                  </div>
                {/if}
                {#if run.log?.length}
                  <div>
                    <div class="text-muted-foreground">Runner log (last {run.log.length} lines)</div>
                    <pre
                      class="whitespace-pre-wrap bg-muted/50 rounded p-2 font-mono text-[11px]">{run.log.join(
                        '\n'
                      )}</pre>
                  </div>
                {/if}
                {#if run.agent?.steps?.length}
                  {@const full = agentSteps[run.dir]}
                  <div>
                    <div class="text-muted-foreground">
                      Agent steps ({seconds(run.agent.durationSec)}{#if run.agent.toolCalls}, {run.agent
                          .toolCalls} calls{/if}){#if full?.loading}
                        · loading the details…{:else if full?.error}
                        · <span class="text-red-700">{full.error}</span>
                        <button
                          type="button"
                          class="underline"
                          onclick={() => loadAgentSteps(run.dir, true)}>retry</button
                        >{/if}
                    </div>
                    {#if full?.steps?.length}
                      <ol class="text-xs">
                        {#each full.steps as s, i (i)}
                          {@render agentStep(run.dir, s, i)}
                        {/each}
                      </ol>
                    {:else}
                      <ol class="list-decimal pl-4 text-muted-foreground">
                        {#each run.agent.steps as step}<li>{step}</li>{/each}
                      </ol>
                    {/if}
                  </div>
                {/if}
                {#if run.callback?.length}
                  <div>
                    <div class="text-muted-foreground">Results sent to Appmixer</div>
                    <pre
                      class="whitespace-pre-wrap bg-muted/50 rounded p-2 font-mono text-[11px]">{run.callback.join(
                        '\n'
                      )}</pre>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
      {#if cards.length > shownCards.length || allPipelineRuns}
        <button
          type="button"
          class="text-xs text-muted-foreground hover:underline"
          onclick={() => (allPipelineRuns = !allPipelineRuns)}
          >{allPipelineRuns
            ? 'Show fewer'
            : `Show all ${cards.length} cards (${pipelineRuns.length} runs)`}</button
        >
      {/if}
      {#if data.cards?.error}
        <p class="text-xs text-muted-foreground">
          Board status not loaded: {data.cards.error}
        </p>
      {/if}
    {/if}
  </section>

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
              {@render flowRow(instance)}
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Watched flows -->
  <section id="watched" class="space-y-3">
    <div class="flex items-baseline justify-between">
      <h2 class="text-xl font-semibold">Watched flows</h2>
      {#if watched}
        <span class="text-xs text-muted-foreground">
          {watched.instanceUrl} · your list{watched.elsewhere
            ? ` · ${watched.elsewhere} more on other instances`
            : ''}
        </span>
      {/if}
    </div>
    <form class="flex flex-wrap items-center gap-2" onsubmit={watch}>
      <input
        class="flex-1 min-w-72 h-8 px-2 text-sm border rounded-md bg-background"
        placeholder="Flow id or designer URL"
        bind:value={watchInput}
      />
      <input
        class="w-56 h-8 px-2 text-sm border rounded-md bg-background"
        placeholder="Label (optional)"
        bind:value={watchLabel}
      />
      <Button type="submit" size="sm" disabled={watching || !watchInput.trim()}>
        {watching ? 'Adding…' : 'Watch'}
      </Button>
    </form>
    {#if watchError}
      <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
        {watchError}
      </div>
    {/if}
    {#if data.watched?.error}
      <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
        {data.watched.error}
      </div>
    {:else if watched?.flows?.length}
      <div class="border rounded-lg divide-y">
        {#each watched.flows as flow (flow.flowId)}
          <div class="p-3 space-y-2">
            {@render flowRow(flow, true)}
          </div>
        {/each}
      </div>
    {:else}
      <div class="text-sm text-muted-foreground">
        No watched flows. Add any flow by its id to see its errors and runs here.
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

  <section id="openclaw" class="space-y-3">
    <h2 class="text-xl font-semibold">OpenClaw host</h2>
    {#if data.openclaw?.error}
      <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
        {data.openclaw.error}
      </div>
    {:else if !openclaw?.configured}
      <div class="bg-muted rounded-lg p-3 text-sm text-muted-foreground">
        Not configured: set <code>OPENCLAW_STATUS_URL</code> and <code>OPENCLAW_STATUS_TOKEN</code>.
      </div>
    {:else}
      <!-- The host in one box: the gateway, what of components dev it runs, the hooks it maps and
           the mentions that belong to no card above. The runs themselves are in Pipeline runs. -->
      {@const deploy = openclaw.deploy}
      <div class="border rounded-lg p-3 space-y-3 text-sm">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span class="font-medium"
            >{openclaw.gateway?.active ? '🟢 Gateway running' : '🔴 Gateway not running'}</span
          >
          <span class="text-xs text-muted-foreground"
            >OpenClaw {openclaw.version} · host {openclaw.host} · Node {openclaw.node} · disk {openclaw.disk}
            · status {ago(openclaw.generatedAt)}</span
          >
          {#if openclaw.update?.available}
            <Badge variant="outline" class="text-amber-800"
              >update available: {openclaw.update.latest}</Badge
            >
          {/if}
        </div>

        <!-- The OpenClaw cron job openclaw-deploy keeps the host on appmixer-components dev -->
        {#if deploy}
          <div class="space-y-0.5 text-xs">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-sm">Deploy from dev</span>
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
              {#if deploy.commit}
                <span class="text-muted-foreground"
                  >runs <a
                    class="hover:underline"
                    href="https://github.com/Appmixer-ai/appmixer-components/commit/{deploy.commit.sha}"
                    target="_blank"
                    rel="noreferrer"><code>{deploy.commit.sha.slice(0, 8)}</code></a
                  >
                  {deploy.commit.subject} · {ago(deploy.commit.at)}</span
                >
              {/if}
              {#if deploy.cron}
                <span class="text-muted-foreground"
                  >· checks every {deploy.cron.everyMin} min, last {ago(deploy.cron.lastRunAt)}</span
                >
              {/if}
            </div>
            {#each (deploy.log || []).slice(0, showDeployLog ? undefined : 3) as entry, i (i)}
              <div class={/FAILED|not deployed/.test(entry.text) ? 'text-red-700' : ''}>
                <span class="text-muted-foreground">{ago(entry.at)}</span>
                {entry.text}
              </div>
            {/each}
            {#if (deploy.log || []).length > 3}
              <button
                type="button"
                class="text-muted-foreground hover:underline"
                onclick={() => (showDeployLog = !showDeployLog)}
                >{showDeployLog ? 'less' : `${deploy.log.length - 3} more`}</button
              >
            {/if}
          </div>
        {/if}

        <!-- Every hook the gateway maps, one line each -->
        <div class="text-xs">
          <div class="font-medium text-sm mb-1">Hooks on {openclaw.publicHost || 'the gateway'}</div>
          <table class="w-full">
            <tbody class="divide-y">
              {#each openclaw.hooks || [] as hook (hook.id)}
                <tr title={hook.description || ''}>
                  <td class="py-1 pr-3 font-medium whitespace-nowrap">
                    {hook.id}
                    {#if hook.exposed === false}<Badge variant="outline" class="ml-1 text-red-700"
                        >not exposed by nginx</Badge
                      >{/if}
                  </td>
                  <td class="py-1 pr-3 whitespace-nowrap">{hook.agentId}</td>
                  <td class="py-1 pr-3 text-muted-foreground whitespace-nowrap"
                    >{String(hook.model || '').replace(/^anthropic\//, '')}</td
                  >
                  <td class="py-1 pr-3 text-muted-foreground whitespace-nowrap"
                    >{hook.sessionMode || '—'}{#if hook.sessionMode === 'persistent' && hook.sessionKey}
                      <code class="ml-1">{hook.sessionKey}</code>{/if}</td
                  >
                  <td class="py-1 text-muted-foreground whitespace-nowrap text-right"
                    >{#if hook.timeoutSeconds}{Math.round(hook.timeoutSeconds / 60)} min{/if}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        <!-- Mentions on PRs that belong to no card above: they would show nowhere else -->
        {#if looseMentions.length}
          <div class="text-xs space-y-1">
            <div class="font-medium text-sm">Mentions outside the pipeline cards</div>
            {#each looseMentions as m (m.at + m.pr)}
              <div class="flex flex-wrap items-center gap-3">
                <span
                  class="px-2 py-0.5 rounded border {m.status === 'replied'
                    ? 'bg-green-50 text-green-700 border-green-200'
                    : m.status === 'failed'
                      ? 'bg-red-50 text-red-700 border-red-200'
                      : 'bg-muted text-muted-foreground border-border'}">{m.status}</span
                >
                <a class="hover:underline font-medium" href={m.url} target="_blank" rel="noreferrer"
                  >PR #{m.pr}{#if m.title} · {m.title}{/if}</a
                >
                <span class="text-muted-foreground" title={stamp(m.at)}>{ago(m.at)}</span>
                <span class="text-muted-foreground"
                  >{m.mentions?.length || 0} asked · {m.replies?.length || 0} answered{#if m.reason}
                    · {m.reason}{/if}</span
                >
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>
