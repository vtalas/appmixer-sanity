<script>
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Progress } from '$lib/components/ui/progress';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import TestRunCard from '$lib/components/test-runs/TestRunCard.svelte';
  import { invalidateAll } from '$app/navigation';

  let { data } = $props();

  let showCreateDialog = $state(false);
  let newRunName = $state('');
  let isCreating = $state(false);
  let createError = $state('');

  // Progress state
  let progressStep = $state('');
  let progressMessage = $state('');
  let progressCompleted = $state(0);
  let progressTotal = $state(0);
  let progressCurrent = $state('');

  const progressPercent = $derived(
    progressTotal > 0 ? (progressCompleted / progressTotal) * 100 : 0
  );

  function resetProgress() {
    progressStep = '';
    progressMessage = '';
    progressCompleted = 0;
    progressTotal = 0;
    progressCurrent = '';
  }

  async function createTestRun() {
    if (!newRunName.trim()) {
      createError = 'Please enter a name for the test run';
      return;
    }

    isCreating = true;
    createError = '';
    resetProgress();

    try {
      const response = await fetch('/api/test-runs/create-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newRunName.trim() })
      });

      if (!response.ok) {
        const error = await response.json();
        createError = error.error || 'Failed to create test run';
        isCreating = false;
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        createError = 'Stream not supported';
        isCreating = false;
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              handleProgressEvent(data);
            } catch (e) {
              console.error('Failed to parse SSE data:', e);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error creating test run:', error);
      createError = 'Failed to create test run';
    } finally {
      isCreating = false;
    }
  }

  function handleProgressEvent(data) {
    switch (data.step) {
      case 'init':
        progressStep = 'init';
        progressMessage = data.message;
        break;
      case 'fetching':
        progressStep = 'fetching';
        progressMessage = data.message;
        break;
      case 'fetched':
        progressStep = 'fetched';
        progressMessage = data.message;
        progressTotal = data.total;
        break;
      case 'progress':
        progressStep = 'progress';
        progressCompleted = data.completed;
        progressTotal = data.total;
        progressCurrent = data.current;
        progressMessage = `Processing ${data.current} (${data.componentCount} components)`;
        break;
      case 'done':
        progressStep = 'done';
        progressMessage = `Created with ${data.connectorCount} connectors and ${data.componentCount} components`;
        showCreateDialog = false;
        newRunName = '';
        resetProgress();
        invalidateAll();
        break;
      case 'error':
        createError = data.message;
        break;
    }
  }

  async function deleteTestRun(id) {
    try {
      const response = await fetch(`/api/test-runs/${id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        await invalidateAll();
      } else {
        const error = await response.json();
        alert(error.error || 'Failed to delete test run');
      }
    } catch (error) {
      console.error('Error deleting test run:', error);
      alert('Failed to delete test run');
    }
  }
</script>

<svelte:head>
  <title>Dashboard - Appmixer Sanity Check</title>
</svelte:head>

<div class="space-y-8">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-3xl font-bold">Test Runs</h1>
      <p class="text-muted-foreground mt-1">Manage and track connector sanity checks</p>
    </div>
    <Button onclick={() => (showCreateDialog = true)}>
      Create Test Run
    </Button>
  </div>

  {#if data.testRuns.length === 0}
    <div class="text-center py-12 border rounded-lg bg-muted/50">
      <h2 class="text-xl font-semibold mb-2">No test runs yet</h2>
      <p class="text-muted-foreground mb-4">Create your first test run to start tracking sanity checks</p>
      <Button onclick={() => (showCreateDialog = true)}>
        Create Test Run
      </Button>
    </div>
  {:else}
    <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {#each data.testRuns as testRun (testRun.id)}
        <TestRunCard {testRun} onDelete={deleteTestRun} />
      {/each}
    </div>
  {/if}
</div>

<Dialog bind:open={showCreateDialog}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Create Test Run</DialogTitle>
      <DialogDescription>
        This will fetch all available connectors and their components from the API
        and create a snapshot for testing.
      </DialogDescription>
    </DialogHeader>

    <div class="py-4 space-y-4">
      <Input
        placeholder="Test run name (e.g., Sprint 42 Sanity Check)"
        bind:value={newRunName}
        disabled={isCreating}
      />

      {#if isCreating}
        <div class="space-y-3 p-4 bg-muted/50 rounded-lg">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
            <span class="text-sm font-medium">
              {#if progressStep === 'init' || progressStep === 'fetching'}
                {progressMessage}
              {:else if progressStep === 'fetched' || progressStep === 'progress'}
                Processing connectors...
              {:else}
                Working...
              {/if}
            </span>
          </div>

          {#if progressTotal > 0}
            <Progress value={progressPercent} />
            <div class="flex justify-between text-xs text-muted-foreground">
              <span>{progressCompleted} / {progressTotal} connectors</span>
              <span>{Math.round(progressPercent)}%</span>
            </div>
            {#if progressCurrent}
              <p class="text-xs text-muted-foreground truncate">
                Current: {progressCurrent}
              </p>
            {/if}
          {/if}
        </div>
      {/if}

      {#if createError}
        <p class="text-sm text-destructive">{createError}</p>
      {/if}
    </div>

    <DialogFooter>
      <Button variant="outline" onclick={() => (showCreateDialog = false)} disabled={isCreating}>
        Cancel
      </Button>
      <Button onclick={createTestRun} disabled={isCreating}>
        {isCreating ? 'Creating...' : 'Create'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
