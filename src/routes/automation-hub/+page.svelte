<script>
  import { onMount } from 'svelte';

  let { data } = $props();

  let status = $state('loading');
  let message = $state('');

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

  onMount(async () => {
    if (data.error) {
      status = 'error';
      message = data.error;
      return;
    }
    try {
      await loadSdk(`${data.uiUrl}/appmixer/package/appmixer.js`);
      const Appmixer = sdkGlobal();
      const appmixer = new Appmixer({ baseUrl: data.baseUrl });
      appmixer.set('accessToken', data.token);
      appmixer.ui.AutomationHub({ el: '#automation-hub' }).open();
      status = 'ready';
    } catch (err) {
      status = 'error';
      message = err instanceof Error ? err.message : String(err);
    }
  });
</script>

<svelte:head>
  <title>Automation Hub</title>
</svelte:head>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-bold">Automation Hub</h1>
    <p class="text-sm text-muted-foreground">
      Integrations published on the configured Appmixer instance. The <strong>GitHub / CI</strong> tab holds the
      Copilot review and <code>@apx-vero</code> mention responders — activate one per repository.
    </p>
  </div>

  {#if status === 'error'}
    <div class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm">
      {message}. Check the Appmixer credentials in <a href="/settings" class="underline">Settings</a>.
    </div>
  {:else if status === 'loading'}
    <p class="text-sm text-muted-foreground">Loading the Automation Hub…</p>
  {/if}

  <div id="automation-hub" class="min-h-[75vh] rounded-lg border"></div>
</div>
