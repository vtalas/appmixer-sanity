<script>
  import { cn } from '$lib/utils.js';

  let { class: className = '', children, ...restProps } = $props();
</script>

<div
  class={cn(
    'relative z-50 grid w-full max-w-lg gap-4 border bg-background p-6 shadow-lg sm:rounded-lg',
    className
  )}
  role="dialog"
  aria-modal="true"
  {...restProps}
>
  {@render children?.()}
</div>
