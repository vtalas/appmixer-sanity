<script>
  import { Button } from '$lib/components/ui/button';

  let { data } = $props();

  /** @param {string} value */
  function csvCell(value) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  function downloadCsv() {
    const rows = [
      ['Service', 'Service ID', 'Status'],
      ...data.services.map((s) => [s.label, s.serviceId, 'Verified'])
    ];
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'appmixer-auth-hub-verified-services.csv';
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head>
  <title>Appmixer Auth Hub — Verified Services</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="report mx-auto max-w-4xl px-6 py-10 print:max-w-none print:p-0">
  <header class="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
    <div>
      <p class="text-sm font-medium uppercase tracking-wide text-muted-foreground">Appmixer Auth Hub</p>
      <h1 class="mt-1 text-3xl font-bold">Verified Services</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        {data.failed ? '' : `${data.services.length} ${data.services.length === 1 ? 'service' : 'services'} · `}{data.generatedAt}
      </p>
    </div>
    {#if data.services.length > 0}
      <div class="flex gap-2 print:hidden">
        <Button variant="outline" size="sm" onclick={downloadCsv}>Download CSV</Button>
        <Button size="sm" onclick={() => window.print()}>Print / Save as PDF</Button>
      </div>
    {/if}
  </header>

  {#if data.failed}
    <p class="mt-8 text-muted-foreground">The report is temporarily unavailable. Please try again later.</p>
  {:else if data.services.length === 0}
    <p class="mt-8 text-muted-foreground">No verified services yet.</p>
  {:else}
    <ul class="mt-6 grid grid-cols-1 gap-x-8 sm:grid-cols-2 print:grid-cols-2">
      {#each data.services as service (service.serviceId)}
        <li class="service flex items-center gap-3 border-b py-2.5">
          {#if service.icon}
            <img src={service.icon} alt="" class="h-6 w-6 shrink-0 object-contain" />
          {:else}
            <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">
              {service.label[0]?.toUpperCase() || '?'}
            </div>
          {/if}
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-medium">{service.label}</div>
            <div class="truncate font-mono text-xs text-muted-foreground">{service.serviceId}</div>
          </div>
          <span class="verified shrink-0 rounded-full border border-green-600/30 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
            ✓ Verified
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  @media print {
    @page {
      margin: 15mm;
    }
    .report {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .service {
      break-inside: avoid;
    }
  }
</style>
