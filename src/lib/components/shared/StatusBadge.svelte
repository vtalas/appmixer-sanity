<script>
  import { Badge } from '$lib/components/ui/badge';

  /**
   * @type {'pending' | 'ok' | 'fail' | 'blocked' | 'in_progress' | 'completed'}
   */
  let { status } = $props();

  const statusConfig = {
    pending: { label: 'Pending', variant: 'secondary' },
    ok: { label: 'OK', variant: 'success' },
    fail: { label: 'Fail', variant: 'destructive' },
    blocked: { label: 'Blocked', variant: 'warning' },
    in_progress: { label: 'In Progress', variant: 'default' },
    completed: { label: 'Completed', variant: 'success' }
  };

  const config = $derived(statusConfig[status] || statusConfig.pending);
</script>

<Badge variant={config.variant}>{config.label}</Badge>
