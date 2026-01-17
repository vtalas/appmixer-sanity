<script>
  import { cn } from '$lib/utils.js';

  let { class: className = '', children, ...restProps } = $props();
</script>

<h2
  class={cn('text-lg font-semibold leading-none tracking-tight', className)}
  {...restProps}
>
  {@render children?.()}
</h2>
