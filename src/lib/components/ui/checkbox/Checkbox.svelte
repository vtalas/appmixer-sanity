<script>
  import { cn } from '$lib/utils.js';

  let {
    checked = false,
    disabled = false,
    onCheckedChange,
    class: className = '',
    ...restProps
  } = $props();

  function handleChange(e) {
    if (onCheckedChange) {
      onCheckedChange(e.target.checked);
    }
  }
</script>

<label class="inline-flex items-center cursor-pointer {disabled ? 'cursor-not-allowed opacity-50' : ''}">
  <input
    type="checkbox"
    {checked}
    {disabled}
    onchange={handleChange}
    class={cn(
      'peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 accent-primary cursor-pointer',
      className
    )}
    {...restProps}
  />
</label>
