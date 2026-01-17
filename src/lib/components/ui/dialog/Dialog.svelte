<script>
  let { open = $bindable(false), children } = $props();
</script>

{#if open}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 bg-black/80"
    onclick={() => (open = false)}
    onkeydown={(e) => e.key === 'Escape' && (open = false)}
    role="button"
    tabindex="-1"
  ></div>

  <!-- Dialog container -->
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    {@render children?.()}
  </div>
{/if}
