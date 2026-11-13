<script>
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Input } from '$lib/components/ui/input';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
  } from '$lib/components/ui/dialog';
  import { RefreshCw } from 'lucide-svelte';

  /**
   * Accounts the E2E flows need, one row per (service, scope set), each connectable
   * from here — no need to open a flow in the designer.
   * @type {{ open: boolean, onchanged?: () => void }}
   */
  let { open = $bindable(false), onchanged } = $props();

  const POLL_INTERVAL_MS = 2000;
  const CHECK_CONCURRENCY = 5;
  // After the popup is closed the callback may still be settling on the instance
  const POLLS_AFTER_POPUP_CLOSED = 3;

  /** @type {Array<any>} */
  let rows = $state([]);
  /** @type {Array<string>} */
  let loadErrors = $state([]);
  let loading = $state(false);
  let loadError = $state('');
  let loaded = $state(false);

  let search = $state('');
  let attentionOnly = $state(false);

  /**
   * Per-row activity, keyed by row key.
   * @type {Record<string, {state: 'connecting'|'binding'|'done'|'error', message: string}>}
   */
  let activity = $state({});
  /** Bumped on close so in-flight polls of a previous session stop */
  let session = 0;

  const STATUS_ORDER = { error: 0, missing: 1, reauth: 2, unchecked: 3, connected: 4 };

  const counts = $derived({
    total: rows.length,
    connected: rows.filter((r) => r.status === 'connected').length,
    checking: rows.filter((r) => r.status === 'unchecked').length
  });

  const visibleRows = $derived(
    rows
      .filter((r) => !attentionOnly || r.status !== 'connected')
      .filter((r) => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return (
          r.service.toLowerCase().includes(q) ||
          r.connectors.some((/** @type {string} */ c) => c.toLowerCase().includes(q))
        );
      })
      .sort(
        (a, b) =>
          (STATUS_ORDER[/** @type {keyof typeof STATUS_ORDER} */ (a.status)] ?? 9) -
            (STATUS_ORDER[/** @type {keyof typeof STATUS_ORDER} */ (b.status)] ?? 9) ||
          a.key.localeCompare(b.key)
      )
  );

  $effect(() => {
    if (open && !loaded && !loading) {
      load();
    }
    if (!open) {
      session++;
      loaded = false;
      activity = {};
    }
  });

  /** @param {Response} response */
  async function errorMessage(response) {
    const body = await response.json().catch(() => null);
    return body?.message || `HTTP ${response.status}`;
  }

  async function load() {
    loading = true;
    loadError = '';
    try {
      const response = await fetch('/api/e2e-flows/accounts');
      if (!response.ok) throw new Error(await errorMessage(response));
      const data = await response.json();
      rows = data.rows || [];
      loadErrors = data.errors || [];
    } catch (e) {
      loadError = /** @type {any} */ (e)?.message || 'Failed to load accounts';
    } finally {
      loading = false;
      loaded = true;
    }
    if (!loadError) checkAll();
  }

  /**
   * Validate the rows that have accounts, a few at a time — the instance checks the
   * tokens live, which takes too long to do for the whole list in one request.
   */
  async function checkAll() {
    const mySession = session;
    const queue = rows.filter((r) => r.status === 'unchecked').map((r) => r.key);
    const worker = async () => {
      while (queue.length > 0 && mySession === session) {
        const key = /** @type {string} */ (queue.shift());
        const row = rows.find((r) => r.key === key);
        if (row) await checkRow(row, mySession);
      }
    };
    await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  }

  /**
   * @param {any} row
   * @param {number} mySession
   */
  async function checkRow(row, mySession) {
    let result;
    try {
      const response = await fetch(
        `/api/e2e-flows/accounts/check?authType=${encodeURIComponent(row.authType)}`
      );
      if (!response.ok) throw new Error(await errorMessage(response));
      result = await response.json();
    } catch (e) {
      result = {
        status: 'error',
        validAccounts: [],
        error: /** @type {any} */ (e)?.message || 'Check failed'
      };
    }
    if (mySession !== session) return;
    rows = rows.map((r) => (r.key === row.key ? { ...r, ...result } : r));
  }

  /**
   * @param {string} key
   * @param {'connecting'|'binding'|'done'|'error'} state
   * @param {string} message
   */
  function setActivity(key, state, message) {
    activity = { ...activity, [key]: { state, message } };
  }

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** @param {any} row */
  async function connect(row) {
    const mySession = session;
    // Opened synchronously in the click handler — a window opened after an await is
    // treated as a popup and blocked.
    const popup = window.open('', `appmixer-auth-${Date.now()}`, 'width=600,height=760');
    if (!popup) {
      setActivity(row.key, 'error', 'The browser blocked the popup — allow popups for this site.');
      return;
    }
    popup.document.title = 'Connecting…';
    popup.document.body.textContent = 'Preparing authentication…';
    setActivity(row.key, 'connecting', 'Waiting for authentication in the popup…');

    try {
      const response = await fetch('/api/e2e-flows/accounts/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authType: row.authType })
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const { ticket, authUrl } = await response.json();
      popup.location.href = authUrl;

      const accountId = await waitForTicket(ticket, popup, mySession);
      if (mySession !== session) return;
      if (!accountId) {
        setActivity(row.key, 'error', 'Authentication was not completed.');
        return;
      }

      if (row.deployedFlowCount > 0) {
        setActivity(row.key, 'binding', 'Account connected — binding to flows…');
        const summary = await bind(row, accountId);
        setActivity(row.key, summary.failed ? 'error' : 'done', `Account connected. ${summary.text}`);
      } else {
        setActivity(row.key, 'done', 'Account connected. No deployed flows to bind yet.');
      }
      await checkRow(row, mySession);
      onchanged?.();
    } catch (e) {
      if (mySession !== session) return;
      setActivity(row.key, 'error', /** @type {any} */ (e)?.message || 'Authentication failed');
    } finally {
      if (!popup.closed) popup.close();
    }
  }

  /**
   * Poll the ticket until the instance finishes it. Resolves the new account id, or
   * null when the popup was closed without finishing.
   * @param {string} ticket
   * @param {Window} popup
   * @param {number} mySession
   * @returns {Promise<string|null>}
   */
  async function waitForTicket(ticket, popup, mySession) {
    let pollsAfterClose = 0;
    while (mySession === session) {
      await sleep(POLL_INTERVAL_MS);
      const response = await fetch(
        `/api/e2e-flows/accounts/status?ticket=${encodeURIComponent(ticket)}`
      );
      if (response.ok) {
        const status = await response.json();
        if (status.finished) {
          if (status.error) throw new Error(status.error);
          return status.accountId || null;
        }
        if (status.expired) throw new Error('The authentication ticket expired — try again.');
      }
      if (popup.closed && ++pollsAfterClose > POLLS_AFTER_POPUP_CLOSED) return null;
    }
    return null;
  }

  /**
   * @param {any} row
   * @param {string} accountId
   * @returns {Promise<{text: string, failed: boolean}>}
   */
  async function bind(row, accountId) {
    const response = await fetch('/api/e2e-flows/accounts/bind', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, connectors: row.connectors })
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    const result = await response.json();
    const failed = result.errors?.length > 0;
    return {
      failed,
      text:
        `Bound to ${result.components} component${result.components !== 1 ? 's' : ''} in ${result.flows} flow${result.flows !== 1 ? 's' : ''}.` +
        (failed ? ` ${result.errors.length} flow(s) failed: ${result.errors[0]}` : '')
    };
  }

  /** @param {any} row */
  async function bindExisting(row) {
    const mySession = session;
    setActivity(row.key, 'binding', 'Binding to flows…');
    try {
      const summary = await bind(row, row.validAccounts[0].accountId);
      if (mySession !== session) return;
      setActivity(row.key, summary.failed ? 'error' : 'done', summary.text);
      onchanged?.();
    } catch (e) {
      if (mySession !== session) return;
      setActivity(row.key, 'error', /** @type {any} */ (e)?.message || 'Bind failed');
    }
  }

  /** @param {any} row */
  function isBusy(row) {
    const state = activity[row.key]?.state;
    return state === 'connecting' || state === 'binding';
  }

  /** @param {any} row */
  function accountsLabel(row) {
    const list = row.status === 'connected' ? row.validAccounts : row.serviceAccounts;
    return list.map((/** @type {any} */ a) => a.name).join(', ');
  }
</script>

<Dialog bind:open>
  <DialogContent class="max-w-5xl max-h-[85vh] flex flex-col">
    <DialogHeader>
      <DialogTitle>E2E Accounts</DialogTitle>
      <DialogDescription>
        Accounts the test flows need, one row per service and scope set. Connect opens the
        service's own sign-in; the account is created on the instance and bound to the deployed
        flows of the listed connectors. The same service on several rows means its connectors ask
        for different scopes.
      </DialogDescription>
    </DialogHeader>

    <div class="flex items-center gap-3">
      <Input class="max-w-xs" placeholder="Filter by service or connector…" bind:value={search} />
      <div class="flex items-center gap-2 text-sm">
        <Checkbox
          checked={attentionOnly}
          onCheckedChange={(/** @type {boolean} */ value) => (attentionOnly = value)}
          aria-label="Needs attention only"
        />
        Needs attention only
      </div>
      <span class="text-sm text-muted-foreground ml-auto">
        {#if loaded && !loadError}
          {counts.connected} of {counts.total} connected{counts.checking > 0
            ? ` · checking ${counts.checking}…`
            : ''}
        {/if}
      </span>
      <Button variant="outline" size="sm" onclick={load} disabled={loading}>
        <RefreshCw size={14} class="mr-2 {loading ? 'animate-spin' : ''}" />
        Refresh
      </Button>
    </div>

    <div class="overflow-auto flex-1 min-h-0">
      {#if loadError}
        <p class="text-sm text-red-600 py-6 text-center">{loadError}</p>
      {:else if loading && rows.length === 0}
        <p class="text-sm text-muted-foreground py-6 text-center">
          Reading connectors and account status from the instance…
        </p>
      {:else if rows.length === 0}
        <p class="text-sm text-muted-foreground py-6 text-center">
          No connectors with authentication in the flow cache — run a Scan first.
        </p>
      {:else}
        {#each loadErrors as message}
          <p class="text-sm text-amber-700 mb-2">{message}</p>
        {/each}
        <div class="border rounded-lg divide-y">
          {#each visibleRows as row (row.key)}
            <div class="px-3 py-2.5 text-sm">
              <div class="flex items-center gap-3">
                <div class="w-24 shrink-0">
                  {#if row.status === 'connected'}
                    <Badge variant="success">Connected</Badge>
                  {:else if row.status === 'reauth'}
                    <Badge
                      variant="warning"
                      title="The service has an account, but none with a valid token covering these scopes"
                    >
                      Re-auth
                    </Badge>
                  {:else if row.status === 'missing'}
                    <Badge variant="destructive">Missing</Badge>
                  {:else if row.status === 'unchecked'}
                    <Badge variant="secondary" class="font-normal">Checking…</Badge>
                  {:else}
                    <Badge variant="outline" title={row.error}>Unknown</Badge>
                  {/if}
                </div>

                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-medium truncate">{row.service}</span>
                    {#if row.authMechanism}
                      <Badge variant="outline" class="font-normal">{row.authMechanism}</Badge>
                    {/if}
                    {#if row.scopes.length > 0}
                      <span
                        class="text-xs text-muted-foreground cursor-help underline decoration-dotted"
                        title={row.scopes.join('\n')}
                      >
                        {row.scopes.length} scope{row.scopes.length !== 1 ? 's' : ''}
                      </span>
                    {/if}
                  </div>
                  <div class="text-xs text-muted-foreground truncate" title={row.connectors.join(', ')}>
                    {row.connectors.join(', ')}
                    · {row.deployedFlowCount}/{row.flowCount} flow{row.flowCount !== 1 ? 's' : ''} deployed
                  </div>
                </div>

                <div
                  class="w-48 shrink-0 text-xs truncate {row.status === 'connected' ? '' : 'text-muted-foreground'}"
                  title={accountsLabel(row)}
                >
                  {#if row.status === 'reauth'}
                    not valid: {accountsLabel(row)}
                  {:else}
                    {accountsLabel(row) || '—'}
                  {/if}
                </div>

                <div class="flex items-center gap-2 shrink-0">
                  {#if row.status === 'connected' && row.deployedFlowCount > 0}
                    <Button
                      variant="ghost"
                      size="sm"
                      onclick={() => bindExisting(row)}
                      disabled={isBusy(row)}
                      title="Bind {row.validAccounts[0].name} to the deployed flows of these connectors"
                    >
                      Bind
                    </Button>
                  {/if}
                  <Button
                    variant={row.status === 'connected' ? 'outline' : 'default'}
                    size="sm"
                    class="w-24"
                    onclick={() => connect(row)}
                    disabled={isBusy(row)}
                  >
                    {#if isBusy(row)}
                      Working…
                    {:else if row.status === 'connected'}
                      Add account
                    {:else if row.status === 'reauth'}
                      Re-auth
                    {:else}
                      Connect
                    {/if}
                  </Button>
                </div>
              </div>

              {#if activity[row.key]}
                <p
                  class="mt-1.5 ml-[6.75rem] text-xs {activity[row.key].state === 'error'
                    ? 'text-red-600'
                    : activity[row.key].state === 'done'
                      ? 'text-green-700'
                      : 'text-muted-foreground'}"
                >
                  {activity[row.key].message}
                </p>
              {:else if row.status === 'error' && row.error}
                <p class="mt-1.5 ml-[6.75rem] text-xs text-red-600">{row.error}</p>
              {/if}
            </div>
          {/each}
          {#if visibleRows.length === 0}
            <p class="text-sm text-muted-foreground py-6 text-center">Nothing matches the filter.</p>
          {/if}
        </div>
      {/if}
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => (open = false)}>Close</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
