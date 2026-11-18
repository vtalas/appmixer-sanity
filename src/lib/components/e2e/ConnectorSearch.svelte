<script>
  import { Input } from '$lib/components/ui/input';

  /**
   * Connector search with suggestions. Typing narrows by substring (`query`);
   * picking a suggestion pins that one connector (`selected`), so "ai" does not
   * also match "airtable".
   * @type {{
   *   connectors: Array<{name: string, count: number}>,
   *   query: string,
   *   selected: string,
   *   placeholder?: string,
   *   class?: string
   * }}
   */
  let {
    connectors,
    query = $bindable(''),
    selected = $bindable(''),
    placeholder = 'Search connectors...',
    class: className = ''
  } = $props();

  const MAX_SUGGESTIONS = 50;
  const listId = 'connector-search-suggestions';

  let open = $state(false);
  let activeIndex = $state(-1);
  /** @type {HTMLElement|null} */
  let listEl = $state(null);

  const suggestions = $derived.by(() => {
    // With a connector pinned the whole list is offered again, to switch quickly
    const q = selected ? '' : query.trim().toLowerCase();
    if (!q) return connectors;
    const starts = [];
    const contains = [];
    for (const connector of connectors) {
      const name = connector.name.toLowerCase();
      // "calendar" should find "microsoft/calendar" as a prefix match too
      if (name.startsWith(q) || name.split('/').some((part) => part.startsWith(q))) {
        starts.push(connector);
      } else if (name.includes(q)) {
        contains.push(connector);
      }
    }
    return [...starts, ...contains];
  });
  const shown = $derived(suggestions.slice(0, MAX_SUGGESTIONS));

  function onInput() {
    // Typing replaces a pinned connector with a free-text search
    selected = '';
    open = true;
    activeIndex = -1;
  }

  /** @param {string} name */
  function pick(name) {
    query = name;
    selected = name;
    open = false;
    activeIndex = -1;
  }

  function clear() {
    query = '';
    selected = '';
    activeIndex = -1;
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        open = true;
        return;
      }
      if (shown.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + step + shown.length) % shown.length;
      listEl?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && shown[activeIndex]) {
        event.preventDefault();
        pick(shown[activeIndex].name);
      } else if (open && shown.length === 1) {
        event.preventDefault();
        pick(shown[0].name);
      } else {
        open = false;
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        open = false;
      }
    }
  }

  /** @param {FocusEvent} event */
  function onFocusOut(event) {
    const next = /** @type {Node|null} */ (event.relatedTarget);
    if (next && /** @type {HTMLElement} */ (event.currentTarget).contains(next)) return;
    open = false;
  }
</script>

<div class="relative {className}" onfocusout={onFocusOut}>
  <Input
    type="text"
    {placeholder}
    bind:value={query}
    class="pr-8"
    role="combobox"
    aria-expanded={open}
    aria-controls={listId}
    aria-autocomplete="list"
    autocomplete="off"
    oninput={onInput}
    onfocus={() => (open = true)}
    onclick={() => (open = true)}
    onkeydown={onKeydown}
  />
  {#if query}
    <button
      type="button"
      class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-sm px-1"
      aria-label="Clear connector search"
      onclick={clear}
    >
      ✕
    </button>
  {/if}

  {#if open}
    <ul
      id={listId}
      role="listbox"
      bind:this={listEl}
      class="absolute z-30 mt-1 w-full max-h-72 overflow-auto rounded-md border bg-background shadow-md py-1 text-sm"
    >
      {#each shown as connector, index (connector.name)}
        <li
          role="option"
          aria-selected={connector.name === selected}
          class="flex items-center justify-between gap-3 px-3 py-1.5 cursor-pointer {index ===
          activeIndex
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-muted'} {connector.name === selected ? 'font-semibold' : ''}"
          onmousedown={(event) => {
            // Keep focus in the input so the list does not close before the click
            event.preventDefault();
            pick(connector.name);
          }}
        >
          <span class="truncate">{connector.name}</span>
          <span class="text-xs text-muted-foreground shrink-0">
            {connector.count} flow{connector.count !== 1 ? 's' : ''}
          </span>
        </li>
      {/each}
      {#if shown.length === 0}
        <li class="px-3 py-1.5 text-muted-foreground">No connector matches</li>
      {:else if suggestions.length > shown.length}
        <li class="px-3 py-1.5 text-xs text-muted-foreground">
          {suggestions.length - shown.length} more — keep typing
        </li>
      {/if}
    </ul>
  {/if}
</div>
