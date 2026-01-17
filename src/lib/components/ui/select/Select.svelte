<script>
  import { cn } from '$lib/utils.js';

  /**
   * @type {Array<{value: string, label: string}>}
   */
  let { options = [], value = $bindable(''), class: className = '', disabled = false, placeholder = 'Select...', ...restProps } = $props();
</script>

<select
  bind:value
  {disabled}
  class={cn(
    'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
    className
  )}
  {...restProps}
>
  {#if placeholder}
    <option value="" disabled>{placeholder}</option>
  {/if}
  {#each options as option}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>
