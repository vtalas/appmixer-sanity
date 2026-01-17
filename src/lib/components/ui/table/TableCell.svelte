<script>
  import { cn } from '$lib/utils.js';

  let { class: className = '', children, ...restProps } = $props();
</script>

<td class={cn('p-4 align-middle [&:has([role=checkbox])]:pr-0', className)} {...restProps}>
  {@render children?.()}
</td>
