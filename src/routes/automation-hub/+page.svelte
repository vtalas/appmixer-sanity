<script>
  import { onMount } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { ExternalLink, Pencil } from 'lucide-svelte';

  let { data } = $props();

  let status = $state('loading');
  let message = $state('');
  /** The template whose draft is open in the embedded Designer. */
  let editing = $state(/** @type {{name: string, draftId: string} | null} */ (null));

  /** The SDK instance, set once the script has loaded. */
  let appmixer = /** @type {any} */ (null);
  /** The embedded Designer, created on the first Edit and reused. */
  let designer = /** @type {any} */ (null);

  /**
   * The SDK script defines a global `Appmixer` constructor; it has no type declarations.
   * @returns {any}
   */
  const sdkGlobal = () => /** @type {any} */ (window).Appmixer;

  /**
   * Load the Appmixer SDK from the instance itself, once per page lifetime.
   * @param {string} src
   * @returns {Promise<void>}
   */
  function loadSdk(src) {
    return new Promise((resolve, reject) => {
      if (sdkGlobal()) return resolve(undefined);
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve(undefined);
      script.onerror = () => reject(new Error(`Could not load the Appmixer SDK from ${src}`));
      document.head.appendChild(script);
    });
  }

  /**
   * API overrides for the hub widget (widget option `api`: methods there replace
   * `appmixer.api`'s for that widget only). "My automations" lists every integration
   * instance of the configured Appmixer user, and that user is shared on the instance, so
   * other people's test instances showed up next to the CI responders. The widget cannot
   * narrow instances by category (its instance query knows only type, user, search and
   * running), so the queries it sends are narrowed here: an instance query (list and
   * count alike) gets a `templateId` clause per template in the hub category, which the
   * engine turns into `$in`. A category without templates hides every instance rather
   * than all of them. Template queries pass through untouched.
   * @param {any} api - the SDK's `appmixer.api`
   * @param {Array<{flowId: string}>} templates - templates in the hub category
   */
  function hubApi(api, templates) {
    const templateIds = templates.length
      ? templates.map((t) => `templateId:${t.flowId}`)
      : ['templateId:00000000-0000-0000-0000-000000000000'];
    /** @param {any} params */
    const narrow = (params) => {
      const filter = Array.isArray(params?.filter) ? params.filter : params?.filter ? [params.filter] : [];
      if (!filter.includes('type:integration-instance')) return params;
      return { ...params, filter: [...filter, ...templateIds] };
    };
    return {
      /** @param {any} params */
      getFlows: (params) => api.getFlows(narrow(params)),
      /** @param {any} params */
      getFlowsCount: (params) => api.getFlowsCount(narrow(params))
    };
  }

  /**
   * Widget options, deep-merged over the widget's defaults.
   * - "Browse available" is narrowed to one template category: the widget offers only
   *   that category next to "All".
   * - Customizing a template in the Designer is off. This app embeds no Designer, so
   *   "Customize in Editor" only left a stopped copy behind; with it off, those "Custom"
   *   copies also drop out of "My automations".
   * @param {{id: string, name: string} | null} category
   */
  function hubOptions(category) {
    const customization = { entryPoints: { templates: false, scratch: false } };
    if (!category) return { customization };
    return {
      customization,
      flows: {
        templates: {
          header: { categories: { visible: true, tabs: [{ category: category.id, label: category.name }] } }
        }
      }
    };
  }

  /**
   * What to refresh after the Wizard closes: "My automations" only. A full (hard) reload
   * also re-runs the templates query, and the SDK then pages through empty offsets without
   * end (it keeps loading while loaded < count) — "Browse available" stayed empty and a
   * /flows request went out every ~50 ms.
   */
  const RELOAD_INSTANCES = { mode: 'soft', scope: { flows: { instances: true } } };

  /**
   * Resolve once an unmounted Wizard has finished its teardown. Unmounting does not stop
   * work already under way: the Wizard still assigns the selected accounts to the
   * instance's components (`PUT /auth/account/<id>/components`) and re-fetches its
   * variables, for up to about a second, and nothing signals the end of it. So watch
   * finished requests that mention one of the instances or account assignment, and
   * resolve when none has finished for 600 ms — no sooner than 1 s, no later than 10 s.
   * @param {string[]} flowIds
   * @returns {Promise<void>}
   */
  function wizardSettled(flowIds) {
    const MIN_MS = 1000;
    const QUIET_MS = 600;
    const MAX_MS = 10000;
    return new Promise((resolve) => {
      const start = performance.now();
      let last = start;
      const observer = new PerformanceObserver((list) => {
        const relevant = list
          .getEntries()
          .some((e) => e.name.includes('/auth/account/') || flowIds.some((id) => e.name.includes(id)));
        if (relevant) last = performance.now();
      });
      observer.observe({ type: 'resource' });
      const timer = setInterval(() => {
        const now = performance.now();
        if ((now - start >= MIN_MS && now - last >= QUIET_MS) || now - start >= MAX_MS) {
          clearInterval(timer);
          observer.disconnect();
          resolve();
        }
      }, 100);
    });
  }

  /**
   * The hub has no built-in handler for "Start automation" or "Edit settings" — it emits
   * `flow:open-wizard` and the page has to open the Wizard. Given a template, the Wizard
   * clones it into a new integration instance as soon as it opens; its default
   * `flow:start` action starts that instance and emits `flow:start-after`, whose default
   * emits `close`. The × emits `cancel`, whose default deletes that instance if it was
   * never started and then emits `close`. `close`'s default unmounts the Wizard.
   *
   * Deleting the instance while the Wizard is mounted, or while its teardown is still
   * running, turns the Wizard's last requests for it into 404s. So the Wizard gets its own
   * `deleteFlow` (widget option `api` overrides methods of `appmixer.api` for that widget)
   * that only remembers the id. The page's `close` handler runs the default
   * (`event.next()`, unmount), waits for the teardown (`wizardSettled`), deletes what was
   * remembered and refreshes "My automations". `wizard.close()` is no substitute: it
   * neither unmounts the Wizard nor emits `close`.
   * @param {any} appmixer
   * @param {any} hub
   * @param {{flowId: string, type: string}} flow - the flow the hub asked to open
   */
  function openWizard(appmixer, hub, flow) {
    /** @type {Set<string>} */
    const deferredDeletes = new Set();
    const wizard = appmixer.ui.Wizard({
      flowId: flow.flowId,
      api: {
        deleteFlow(/** @type {string} */ flowId) {
          deferredDeletes.add(flowId);
          return Promise.resolve();
        }
      }
    });
    wizard.on('close', async (/** @type {any} */ event) => {
      event?.next?.();
      const flowIds = [...deferredDeletes];
      deferredDeletes.clear();
      if (flowIds.length) {
        // Leaving the page before this finishes leaves the stopped instance behind.
        await wizardSettled(flowIds);
        await Promise.all(
          flowIds.map((flowId) =>
            appmixer.api.deleteFlow(flowId).catch((/** @type {unknown} */ err) => {
              console.error(`Could not delete flow ${flowId}`, err);
            })
          )
        );
      }
      hub.reload(RELOAD_INSTANCES);
    });
    wizard.open();
  }

  /**
   * Designer options — Studio's integration designer (`integrationTemplateMode`: Wizard
   * Builder, Create/Edit Test and Publish instead of Start/Stop), trimmed to what the page
   * handles. `flow:clone`, `flow:insights` and `flow:turn-into-automation` have no default
   * action in the SDK and `flow:remove` would delete the draft the template is published
   * from, so the menu leaves them out. No `shareTypes`: the Publish dialog has its own.
   */
  const DESIGNER_OPTIONS = {
    integrationTemplateMode: true,
    menu: [
      { event: 'flow:rename', label: 'Rename' },
      { event: 'flow:change-description', label: 'Change description' },
      { event: 'flow:export-svg', label: 'Export SVG' },
      { event: 'flow:export-png', label: 'Export PNG' },
      { event: 'flow:print', label: 'Print' }
    ],
    showButtonClose: true,
    autoOpenLogs: true,
    toolbar: [
      ['undo', 'redo'],
      ['zoom-to-fit', 'zoom-in', 'zoom-out'],
      ['logs', 'integration-test-logs']
    ]
  };

  /**
   * Open the end-user Wizard on an integration test; `onClose` runs after it unmounts.
   * @param {string} flowId
   * @param {() => void} onClose
   */
  function openTestWizard(flowId, onClose) {
    const wizard = appmixer.ui.Wizard({ flowId });
    wizard.on('close', (/** @type {any} */ event) => {
      event?.next?.();
      onClose();
    });
    wizard.open();
  }

  /**
   * Create/Edit Test has no default action: like Studio, clone the draft into an
   * `integration-test` flow and open the Wizard on it, then let the Designer continue
   * (`next`) — it then lists the test and its logs.
   * @param {{data: {flowId: string}, next: () => void}} event
   */
  async function createIntegrationTest({ data: { flowId }, next }) {
    designer.state('integrationTest/error', null);
    designer.state('integrationTest/loader', true);
    try {
      const testFlowId = await appmixer.api.cloneFlow(flowId, {
        projection: '-sharedWith',
        connectAccounts: true,
        setOriginFlowId: true,
        additional: { type: 'integration-test' }
      });
      openTestWizard(testFlowId, next);
    } catch (err) {
      designer.state('integrationTest/error', err);
    } finally {
      designer.state('integrationTest/loader', false);
    }
  }

  /**
   * Edit a template: open its draft (`originFlowId`) in the embedded Designer. The draft
   * is what gets edited — Publish there updates the existing template (remapped component
   * IDs, `revision` + 1), the same as publish-integration.js. Opened on the template
   * itself, Publish would find no template published from it and clone a new one.
   *
   * The Designer covers the page (a fixed overlay under the SDK's own modals, z-index
   * 101+, so the test Wizard opens on top of it). Its × emits `close`: the default
   * unmounts it, then the page hides the overlay and reloads the template list (revision).
   * @param {{name: string, originFlowId?: string}} template
   */
  function editTemplate(template) {
    if (!appmixer || !template.originFlowId) return;
    editing = { name: template.name, draftId: template.originFlowId };
    document.body.style.overflow = 'hidden';
    if (designer) {
      designer.set('componentId', null);
      designer.set('flowId', template.originFlowId);
      designer.open();
      return;
    }
    designer = appmixer.ui.Designer({
      el: '#template-designer',
      flowId: template.originFlowId,
      options: DESIGNER_OPTIONS,
      state: { stencilLayout: 'collapsed' }
    });
    designer.on('close', (/** @type {any} */ event) => {
      event?.next?.();
      editing = null;
      document.body.style.overflow = '';
      invalidateAll();
    });
    designer.on('integration-test:create', createIntegrationTest);
    designer.on('integration-test:edit', (/** @type {any} */ event) =>
      openTestWizard(event.data.flowId, event.next)
    );
    designer.on('integration-test:insights', (/** @type {any} */ event) =>
      window.open(`${data.uiUrl}/insights/logs/${event.data.flowId}`, '_blank', 'noopener')
    );
    designer.open();
  }

  /**
   * Dev only: drop Svelte's `state_proxy_equality_mismatch` warnings while this page is
   * open. They are false positives. Svelte's dev build patches Array.prototype.includes /
   * indexOf and treats any object that answers `in` for its internal symbol as a $state
   * proxy; the SDK's Vue components with runtime-compiled templates answer `in` with true
   * for every symbol, so each hub re-render floods the console. Production has no patch.
   * @returns {() => void} restores console.warn
   */
  function muteProxyEqualityWarnings() {
    if (!import.meta.env.DEV) return () => {};
    const warn = console.warn;
    console.warn = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('state_proxy_equality_mismatch')) return;
      warn.apply(console, args);
    };
    return () => {
      console.warn = warn;
    };
  }

  $effect(() => muteProxyEqualityWarnings());

  onMount(async () => {
    if (data.error) {
      status = 'error';
      message = data.error;
      return;
    }
    try {
      await loadSdk(`${data.uiUrl}/appmixer/package/appmixer.js`);
      const Appmixer = sdkGlobal();
      appmixer = new Appmixer({ baseUrl: data.baseUrl });
      appmixer.set('accessToken', data.token);
      const hub = appmixer.ui.AutomationHub({
        el: '#automation-hub',
        options: hubOptions(data.category),
        // No category (another instance) means the unfiltered hub, instances included.
        ...(data.category ? { api: hubApi(appmixer.api, data.templates) } : {})
      });
      hub.on('flow:open-wizard', (/** @type {any} */ event) => openWizard(appmixer, hub, event.data.flow));
      // Preselect the category before the first load; without it the list starts on "All".
      if (data.category) hub.state('flows/query/templates/categoryIds', [data.category.id]);
      hub.open();
      status = 'ready';
    } catch (err) {
      status = 'error';
      message = err instanceof Error ? err.message : String(err);
    }
  });

  // Leaving the page with the Designer open: unmount it and give the page its scroll back.
  // An effect, not onDestroy — that also runs in SSR, where there is no document.
  $effect(() => () => {
    designer?.close();
    document.body.style.overflow = '';
  });
</script>

<svelte:head>
  <title>Automation Hub</title>
</svelte:head>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-bold">Automation Hub</h1>
    <p class="text-sm text-muted-foreground">
      Integrations published on the configured Appmixer instance. It opens on <strong>appmixer-sanity-hub</strong> — the
      Copilot review and <code>@apx-vero</code> mention responders, activate one per repository; <em>All</em> lists
      every template shared on the instance. <strong>My automations</strong> shows only instances of this category's
      templates; the configured Appmixer user is shared, and its other instances are left out.
    </p>
  </div>

  {#if status === 'error'}
    <div class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm">
      {message}. Check the Appmixer credentials in <a href="/settings" class="underline">Settings</a>.
    </div>
  {:else if status === 'loading'}
    <p class="text-sm text-muted-foreground">Loading the Automation Hub…</p>
  {/if}

  {#if !data.error}
    <div class="rounded-lg border text-sm">
      <div class="border-b px-4 py-2 font-medium">Templates in appmixer-sanity-hub</div>
      {#if !data.category}
        <p class="px-4 py-2 text-muted-foreground">
          The <code>appmixer-sanity-hub</code> category does not exist on {data.baseUrl}.
        </p>
      {:else if data.templatesError}
        <p class="px-4 py-2 text-destructive">Could not list the templates: {data.templatesError}</p>
      {:else if !data.templates.length}
        <p class="px-4 py-2 text-muted-foreground">No templates published in this category yet.</p>
      {:else}
      <ul class="divide-y">
        {#each data.templates as template (template.flowId)}
          <li class="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span>
              {template.name}
              {#if template.revision}
                <span class="text-xs text-muted-foreground">rev {template.revision}</span>
              {/if}
            </span>
            <div class="flex items-center gap-3 text-xs">
              {#if template.originFlowId}
                <button
                  type="button"
                  onclick={() => editTemplate(template)}
                  disabled={status !== 'ready'}
                  class="inline-flex items-center gap-1 text-blue-600 hover:underline disabled:opacity-50 disabled:no-underline"
                  title="Edit the draft here in the SDK Designer; Publish updates this template"
                >
                  Edit <Pencil size={13} />
                </button>
                <a
                  href={`${data.uiUrl}/integration-designer/${template.originFlowId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-1 text-blue-600 hover:underline"
                  title="Editable source; publish-integration.js re-publishes the template from it"
                >
                  Draft <ExternalLink size={13} />
                </a>
              {/if}
              <a
                href={`${data.uiUrl}/integration-designer/${template.flowId}`}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1 text-blue-600 hover:underline"
                title="The published template the hub lists"
              >
                Template <ExternalLink size={13} />
              </a>
            </div>
          </li>
        {/each}
      </ul>
      {/if}
    </div>
  {/if}

  <div id="automation-hub" class="rounded-lg border"></div>
</div>

<!-- The embedded Designer (editTemplate). Always in the DOM so the widget keeps its element. -->
<div
  class="fixed inset-0 z-[100] bg-background"
  class:hidden={!editing}
  aria-label={editing ? `Designer: ${editing.name}` : undefined}
>
  <div id="template-designer" class="relative h-full w-full"></div>
</div>

<style>
  /* The SDK's widget root (.am-widget) is position: absolute; inset: 0; overflow: auto —
     it fills its container and scrolls inside it. Put it back into the normal flow so
     the hub takes its natural height and only the page scrolls; its sticky headers then
     stick to the viewport. min-height keeps the flex: 1 panels (Logs) from collapsing. */
  #automation-hub:global(.am-widget),
  #automation-hub :global(.am-widget) {
    position: relative;
    inset: auto;
    overflow: visible;
    min-height: 75vh;
  }
</style>
