<script>
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '$lib/components/ui/table';
  import { Badge } from '$lib/components/ui/badge';
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '$lib/components/ui/dialog';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { configKeysOf } from '$lib/authhub-config.js';

  let { data } = $props();

  const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

  let search = $state('');
  /** @type {Set<string>} */
  let statusFilter = $state(new Set());
  // QA isn't verified connector by connector — it shows whether each one has
  // its config (keys besides serviceId) instead of the verification status
  let showConfigCheck = $derived(data.env.id === 'qa');
  /** @type {Set<string>} */
  let configFilter = $state(new Set());
  const STATUS_FILTERS = [
    { value: 'not_verified', label: '\u274c Not Verified' },
    { value: 'in_progress', label: '\u23f3 In Progress' },
    { value: 'verified', label: '\u2705 Verified' }
  ];
  const CONFIG_FILTERS = [
    { value: 'configured', label: '\u2705 Configured' },
    { value: 'not_configured', label: '\u274c Not Configured' }
  ];

  /**
   * @param {Set<string>} set
   * @param {string} value
   */
  function toggled(set, value) {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    return next;
  }
  // Per-environment data: derived from the load result (so switching ?env=
  // replaces it) and overwritten locally as the page updates it
  /** @type {Record<string, {version?: string, icon?: string, label?: string}>} */
  let cachedInfo = $derived(data.cachedInfo || {});
  /** @type {Record<string, string>} */
  let statuses = $derived(data.statuses || {});
  /** @type {Record<string, string>} */
  let notes = $derived(data.notes || {});
  // `data` isn't deeply reactive — assigning data.connectors wouldn't re-render
  /** @type {Array<{serviceId: string, source: string, configKeys?: string[]}>} */
  let connectors = $derived(data.connectors || []);

  /**
   * Show the config keys a connector has now
   * @param {string} serviceId
   * @param {string[]} configKeys
   */
  function setConfigKeys(serviceId, configKeys) {
    connectors = connectors.map((c) => (c.serviceId === serviceId ? { ...c, configKeys } : c));
  }

  /**
   * API URL for the Auth Hub environment shown on the page
   * @param {string} path
   * @param {Record<string, string>} [params]
   */
  function api(path, params = {}) {
    return `${path}?${new URLSearchParams({ env: data.env.id, ...params })}`;
  }

  /** @param {number} bytes */
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /**
   * Wait until Auth Hub has processed an upload. Its ticket holds `{started}`
   * while it unpacks, tests and installs the bundle, then `{finished, installed}`
   * or `{finished, err, data}` — `finished` is set on failure too.
   * @param {string} ticket
   * @param {(message: string) => void} onProgress
   * @param {string} [envId] - the environment the upload went to
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function waitForUpload(ticket, onProgress, envId = data.env.id) {
    const url = api('/api/auth-hub/upload', { ticket, env: envId });
    const started = Date.now();
    while (Date.now() - started < UPLOAD_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 2000));
      // 404 until Auth Hub has registered the ticket
      const res = await fetch(url);
      if (!res.ok) continue;
      const status = await res.json();
      if (status.err) {
        const detail = status.data ? ` ${JSON.stringify(status.data)}` : '';
        return { ok: false, message: `Auth Hub rejected the bundle: ${status.err}${detail}` };
      }
      if (status.finished) return { ok: true, message: 'Upload complete!' };
      onProgress(`Auth Hub is processing the bundle… ${Math.round((Date.now() - started) / 1000)} s`);
    }
    return { ok: false, message: 'Timed out waiting for Auth Hub to process the bundle' };
  }

  /**
   * Auth Hub lists a connector (GET /service-config) only once it has a service
   * config — a bundle alone stays invisible. GET answers `{}` for a missing one.
   * @param {string} serviceId
   * @param {string} envId
   * @returns {Promise<string[]>} keys of the config besides serviceId
   */
  async function ensureServiceConfig(serviceId, envId) {
    const res = await fetch(api('/api/auth-hub/service-config', { serviceId, env: envId }));
    const config = res.ok ? await res.json() : {};
    if (Object.keys(config).length > 0) return configKeysOf(config);
    const put = await fetch(api('/api/auth-hub/service-config', { env: envId }), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId, config: { serviceId } })
    });
    if (!put.ok) {
      const result = await put.json().catch(() => ({}));
      throw new Error(`The bundle is uploaded, but creating its service config failed: ${result.error || put.status}`);
    }
    return [];
  }

  /**
   * After a successful upload: register a connector new to the Auth Hub, show
   * it and its new bundle version.
   * @param {string} serviceId
   * @param {string} [envId]
   */
  async function afterUpload(serviceId, envId = data.env.id) {
    const existing = connectors.find((c) => c.serviceId === serviceId);
    if (!existing) {
      const configKeys = await ensureServiceConfig(serviceId, envId);
      connectors = [...connectors, { serviceId, source: 'authhub', configKeys }]
        .sort((a, b) => (a.serviceId || '').localeCompare(b.serviceId || ''));
    } else if (existing.source === 'github') {
      const configKeys = await ensureServiceConfig(serviceId, envId);
      connectors = connectors.map((c) => (c.serviceId === serviceId ? { ...c, source: 'both', configKeys } : c));
    }
    try {
      const res = await fetch(api('/api/auth-hub/bundle'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId })
      });
      const result = await res.json();
      if (res.ok && result.version) {
        cachedInfo = { ...cachedInfo, [serviceId]: { ...cachedInfo[serviceId], version: result.version } };
      }
    } catch { /* ignore */ }
  }

  // Bundle packed from GitHub (Upload Bundle / Upload New → From repository)
  /** @type {'repo'|'file'} */
  let bundleMode = $state('repo');
  let repoSource = $state('dev');
  /** @type {any} */
  let repoPreview = $state(null);
  let repoPreviewLoading = $state(false);
  let repoPreviewError = $state('');
  let repoFilesOpen = $state(false);
  let repoPreviewSeq = 0;

  /** Production gets what's released, QA what's in development */
  function defaultRepoSource() {
    const preferred = data.env.id === 'prod' ? 'release' : 'dev';
    const sources = data.packSources || [];
    return sources.some((s) => s.id === preferred) ? preferred : sources[0]?.id || 'dev';
  }

  /** @param {'repo'|'file'} mode */
  function resetBundleSource(mode) {
    bundleMode = mode;
    repoSource = defaultRepoSource();
    repoPreview = null;
    repoPreviewError = '';
    repoPreviewLoading = false;
    repoFilesOpen = false;
    repoPreviewSeq++;
  }

  /** @param {string} serviceId */
  async function loadRepoPreview(serviceId) {
    const seq = ++repoPreviewSeq;
    repoPreview = null;
    repoPreviewError = '';
    repoFilesOpen = false;
    if (!serviceId) return;
    repoPreviewLoading = true;
    try {
      const res = await fetch(api('/api/auth-hub/upload-from-repo', { serviceId, source: repoSource }));
      const result = await res.json();
      if (seq !== repoPreviewSeq) return;
      if (res.ok) repoPreview = result;
      else repoPreviewError = result.error || `Error ${res.status}`;
    } catch (err) {
      if (seq === repoPreviewSeq) repoPreviewError = /** @type {Error} */ (err).message;
    } finally {
      if (seq === repoPreviewSeq) repoPreviewLoading = false;
    }
  }

  function downloadRepoPack() {
    if (!repoPreview) return;
    window.open(api('/api/auth-hub/upload-from-repo', {
      serviceId: repoPreview.serviceId,
      source: repoSource,
      commit: repoPreview.commitSha,
      download: '1'
    }), '_blank');
  }

  /**
   * Pack the previewed commit on the server and upload it.
   * @param {(message: string) => void} onProgress
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function uploadRepoPack(onProgress) {
    const preview = repoPreview;
    onProgress(`Packing ${preview.name} v${preview.version} and uploading…`);
    const res = await fetch(api('/api/auth-hub/upload-from-repo'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId: preview.serviceId, source: repoSource, commitSha: preview.commitSha })
    });
    const result = await res.json();
    if (!res.ok) return { ok: false, message: result.error || 'Upload failed' };
    onProgress(`Uploaded ${formatSize(result.size)} (${result.fileCount} files), waiting for Auth Hub…`);
    const outcome = await waitForUpload(result.ticket, onProgress);
    return outcome.ok
      ? { ok: true, message: `${preview.name} v${preview.version} uploaded from ${preview.source.repo}@${preview.commitSha.slice(0, 7)}` }
      : outcome;
  }

  // Close dialogs of the previous environment when ?env= changes
  let shownEnv = '';
  $effect.pre(() => {
    const envId = data.env.id;
    if (shownEnv && envId !== shownEnv) {
      viewDialogOpen = false;
      uploadDialogOpen = false;
      uploadNewDialogOpen = false;
      notesDialogOpen = false;
      deleteDialogOpen = false;
      batchDialogOpen = false;
      batchStopRequested = true;
      selected = new Set();
      bundleLoading = {};
    }
    shownEnv = envId;
  });

  // Batch upload from the repository (admin only): select rows, preview them
  // all at one commit, upload one after another
  /** @type {Set<string>} */
  let selected = $state(new Set());
  let batchDialogOpen = $state(false);
  let batchSource = $state('dev');
  /** @type {{source: any, commitSha: string, committedAt: string|null, commitUrl: string}|null} */
  let batchPreview = $state(null);
  /**
   * @typedef {'new'|'upgrade'|'same'|'downgrade'|'unknown'|'error'} Verdict
   * @type {Array<any>}
   */
  let batchItems = $state([]);
  let batchLoading = $state(false);
  let batchError = $state('');
  let batchRunning = $state(false);
  let batchStopRequested = $state(false);
  let batchRun = $state({ total: 0, finished: 0 });
  let batchSeq = 0;

  /**
   * @param {string} serviceId
   * @param {boolean} on
   */
  function toggleSelected(serviceId, on) {
    const next = new Set(selected);
    if (on) next.add(serviceId);
    else next.delete(serviceId);
    selected = next;
  }

  /** @param {boolean} on */
  function toggleAllFiltered(on) {
    const next = new Set(selected);
    for (const c of filteredConnectors) {
      if (on) next.add(c.serviceId);
      else next.delete(c.serviceId);
    }
    selected = next;
  }

  /**
   * What uploading `version` would do to the Auth Hub
   * @param {string} serviceId
   * @param {string|null} version
   * @returns {Verdict}
   */
  function uploadVerdict(serviceId, version) {
    if (connectors.find((c) => c.serviceId === serviceId)?.source === 'github') return 'new';
    const cmp = compareVersions(cachedInfo[serviceId]?.version, version ?? undefined);
    if (cmp === 'outdated') return 'upgrade';
    if (cmp === 'match') return 'same';
    if (cmp === 'newer') return 'downgrade';
    return 'unknown';
  }

  function openBatch() {
    batchSource = defaultRepoSource();
    batchStopRequested = false;
    batchDialogOpen = true;
    loadBatchPreview();
  }

  async function loadBatchPreview() {
    const seq = ++batchSeq;
    batchPreview = null;
    batchItems = [];
    batchError = '';
    batchLoading = true;
    try {
      const res = await fetch(api('/api/auth-hub/upload-from-repo/preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceIds: [...selected].sort(), source: batchSource })
      });
      const result = await res.json();
      if (seq !== batchSeq) return;
      if (!res.ok) {
        batchError = result.error || `Error ${res.status}`;
        return;
      }
      const { items, ...commit } = result;
      batchPreview = commit;
      // Upgrades, new connectors and unknown Auth Hub versions go up by default;
      // same versions and downgrades only when ticked
      batchItems = items.map((/** @type {any} */ item) => {
        const verdict = item.ok ? uploadVerdict(item.serviceId, item.version) : 'error';
        return {
          ...item,
          verdict,
          include: ['new', 'upgrade', 'unknown'].includes(verdict),
          state: 'idle',
          message: ''
        };
      });
    } catch (err) {
      if (seq === batchSeq) batchError = /** @type {Error} */ (err).message;
    } finally {
      if (seq === batchSeq) batchLoading = false;
    }
  }

  let batchPending = $derived(batchItems.filter((i) => i.ok && i.include && i.state !== 'done'));
  let batchIncludable = $derived(batchItems.filter((i) => i.ok && i.state !== 'done'));
  let batchCounts = $derived({
    done: batchItems.filter((i) => i.state === 'done').length,
    failed: batchItems.filter((i) => i.state === 'failed').length
  });

  async function runBatch() {
    const preview = batchPreview;
    if (!preview || batchRunning) return;
    // The whole batch goes to the environment it was started in
    const envId = data.env.id;
    const source = batchSource;
    batchRunning = true;
    batchStopRequested = false;
    const queue = batchPending;
    batchRun = { total: queue.length, finished: 0 };
    for (const item of queue) {
      if (batchStopRequested || data.env.id !== envId) break;
      /** @param {string} message */
      const progress = (message) => {
        item.state = 'running';
        item.message = message;
      };
      progress('Packing and uploading…');
      try {
        const res = await fetch(api('/api/auth-hub/upload-from-repo', { env: envId }), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceId: item.serviceId, source, commitSha: preview.commitSha })
        });
        const result = await res.json();
        const outcome = res.ok
          ? await waitForUpload(result.ticket, progress, envId)
          : { ok: false, message: result.error || 'Upload failed' };
        if (outcome.ok && data.env.id === envId) {
          await afterUpload(item.serviceId, envId);
          toggleSelected(item.serviceId, false);
        }
        item.state = outcome.ok ? 'done' : 'failed';
        item.message = outcome.ok ? `v${item.version} uploaded` : outcome.message;
      } catch (err) {
        item.state = 'failed';
        item.message = /** @type {Error} */ (err).message;
      }
      batchRun.finished++;
    }
    batchRunning = false;
  }
  /** @type {string|null} */
  let notesServiceId = $state(null);
  let notesDialogOpen = $state(false);
  let notesDraft = $state('');
  let notesSaving = $state(false);

  /** @param {string} serviceId */
  function openNotes(serviceId) {
    notesServiceId = serviceId;
    notesDraft = notes[serviceId] || '';
    notesDialogOpen = true;
  }

  async function saveNotes() {
    if (!notesServiceId) return;
    notesSaving = true;
    try {
      await fetch(api('/api/auth-hub/notes'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: notesServiceId, notes: notesDraft })
      });
      notes = { ...notes, [notesServiceId]: notesDraft };
      notesDialogOpen = false;
    } catch { /* ignore */ } finally {
      notesSaving = false;
    }
  }
  /** @type {Record<string, boolean>} */
  let bundleLoading = $state({});
  let fetchAllRunning = $state(false);
  let fetchAllProgress = $state({ done: 0, total: 0 });
  let fetchAllPhase = $state('');

  // Upload (admin only)
  let uploadDialogOpen = $state(false);
  /** @type {File|null} */
  let uploadFile = $state(null);
  let uploadDragOver = $state(false);
  let uploading = $state(false);
  /** @type {'idle'|'uploading'|'polling'|'done'|'error'} */
  let uploadStatus = $state('idle');
  let uploadMessage = $state('');

  /** @param {File} file */
  function setUploadFile(file) {
    if (!file.name.endsWith('.zip')) {
      uploadMessage = 'Only .zip files are supported';
      return;
    }
    uploadFile = file;
    uploadMessage = '';
  }

  async function doUpload() {
    const serviceId = viewServiceId;
    if (bundleMode === 'file' ? !uploadFile : !repoPreview) return;
    uploading = true;
    uploadStatus = 'uploading';
    /** @param {string} message */
    const progress = (message) => { uploadStatus = 'polling'; uploadMessage = message; };

    try {
      let outcome;
      if (bundleMode === 'repo') {
        outcome = await uploadRepoPack(progress);
      } else {
        const file = /** @type {File} */ (uploadFile);
        uploadMessage = `Uploading ${file.name}...`;
        const res = await fetch(api('/api/auth-hub/upload'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file
        });
        const result = await res.json();
        outcome = res.ok
          ? await waitForUpload(result.ticket, progress)
          : { ok: false, message: result.error || 'Upload failed' };
      }

      if (outcome.ok && serviceId) await afterUpload(serviceId);
      uploadStatus = outcome.ok ? 'done' : 'error';
      uploadMessage = outcome.message;
    } catch (err) {
      uploadStatus = 'error';
      uploadMessage = /** @type {Error} */ (err).message;
    } finally {
      uploading = false;
    }
  }

  function resetUpload() {
    uploadFile = null;
    uploadStatus = 'idle';
    uploadMessage = '';
    uploadDragOver = false;
    resetBundleSource('repo');
  }

  // Upload New (admin only) — service name + config + bundle
  let uploadNewDialogOpen = $state(false);
  let uploadNewServiceId = $state('');
  /** @type {Record<string, string>} */
  let uploadNewConfig = $state({});
  let uploadNewConfigKey = $state('');
  let uploadNewConfigValue = $state('');
  /** @type {File|null} */
  let uploadNewFile = $state(null);
  let uploadNewDragOver = $state(false);
  /** @type {'form'|'checking'|'confirm'|'saving'|'uploading'|'polling'|'done'|'error'} */
  let uploadNewStep = $state('form');
  let uploadNewMessage = $state('');

  /** @param {string} [serviceId] - prefill (a connector not in Auth Hub yet) */
  function resetUploadNew(serviceId = '') {
    uploadNewServiceId = serviceId;
    uploadNewConfig = {};
    uploadNewConfigKey = '';
    uploadNewConfigValue = '';
    uploadNewFile = null;
    uploadNewDragOver = false;
    uploadNewStep = 'form';
    uploadNewMessage = '';
    resetBundleSource(serviceId ? 'repo' : 'file');
    if (serviceId) loadRepoPreview(serviceId);
  }

  /** @param {File} file */
  function setUploadNewFile(file) {
    if (!file.name.endsWith('.zip')) { uploadNewMessage = 'Only .zip files are supported'; return; }
    uploadNewFile = file;
    uploadNewMessage = '';
  }

  async function doUploadNew(force = false) {
    const sid = uploadNewServiceId.trim();
    if (!sid) { uploadNewMessage = 'Service name is required'; return; }
    if (bundleMode === 'repo' && repoPreview?.serviceId !== sid) {
      uploadNewMessage = 'Load the repository preview for this service name first';
      return;
    }

    if (!force) {
      // Check if config already exists
      uploadNewStep = 'checking';
      uploadNewMessage = '';
      try {
        const res = await fetch(api('/api/auth-hub/service-config', { serviceId: sid }));
        // Auth Hub answers a missing config with an empty object
        if (res.ok && Object.keys(await res.json()).length > 0) {
          // Exists — ask to confirm
          uploadNewStep = 'confirm';
          return;
        }
      } catch { /* treat as not found */ }
    }

    // Save the config first — even without keys: Auth Hub lists only connectors
    // that have one
    uploadNewStep = 'saving';
    uploadNewMessage = 'Saving service config...';
    const configBody = Object.fromEntries(
      Object.entries(uploadNewConfig).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch { return [k, v]; } })
    );
    // Always include serviceId in config
    if (!configBody.serviceId) configBody.serviceId = sid;
    const saveRes = await fetch(api('/api/auth-hub/service-config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId: sid, config: configBody })
    });
    if (!saveRes.ok) {
      const r = await saveRes.json();
      uploadNewStep = 'error';
      uploadNewMessage = r.error || 'Failed to save config';
      return;
    }
    // PUT replaces the whole config
    setConfigKeys(sid, configKeysOf(configBody));

    // Upload bundle (packed from the repository or the selected file)
    let doneMessage = 'Done!';
    if (bundleMode === 'repo' ? repoPreview : uploadNewFile) {
      uploadNewStep = 'uploading';
      /** @param {string} message */
      const progress = (message) => { uploadNewStep = 'polling'; uploadNewMessage = message; };
      try {
        let outcome;
        if (bundleMode === 'repo') {
          outcome = await uploadRepoPack(progress);
        } else {
          const file = /** @type {File} */ (uploadNewFile);
          uploadNewMessage = `Uploading ${file.name}...`;
          const res = await fetch(api('/api/auth-hub/upload'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file
          });
          const result = await res.json();
          outcome = res.ok
            ? await waitForUpload(result.ticket, progress)
            : { ok: false, message: result.error || 'Upload failed' };
        }
        if (!outcome.ok) {
          uploadNewStep = 'error';
          uploadNewMessage = outcome.message;
          return;
        }
        doneMessage = outcome.message;
      } catch (err) {
        uploadNewStep = 'error';
        uploadNewMessage = /** @type {Error} */ (err).message;
        return;
      }
    }

    try {
      await afterUpload(sid);
    } catch (err) {
      uploadNewStep = 'error';
      uploadNewMessage = /** @type {Error} */ (err).message;
      return;
    }
    uploadNewStep = 'done';
    uploadNewMessage = doneMessage;
  }

  // View connector details popup
  const WHITELIST_EXCLUDED = new Set(['serviceId', 'clientId', 'clientSecret']);

  /** @type {string|null} */
  let viewServiceId = $state(null);
  let viewDialogOpen = $state(false);
  /** @type {Record<string, unknown>|null} */
  let viewServiceConfig = $state(null);
  /** @type {Set<string>} */
  let viewWhitelistKeys = $state(new Set());
  let viewLoading = $state(false);
  let viewError = $state('');

  let viewEditMode = $state(false);
  let configJsonMode = $state(false);
  let configJsonDraft = $state('');
  let configJsonError = $state('');
  /** @type {Record<string, string>} */
  let viewEditConfig = $state({});
  let configSaving = $state(false);
  let configSaveError = $state('');
  let newConfigKey = $state('');
  let newConfigValue = $state('');
  /** @type {Record<string, boolean>} */
  let whitelistAdding = $state({});
  /** @type {Record<string, boolean>} */
  let whitelistRemoving = $state({});

  /** @param {string} serviceId */
  async function openView(serviceId) {
    viewServiceId = serviceId;
    viewServiceConfig = null;
    viewWhitelistKeys = new Set();
    viewEditMode = false;
    viewError = '';
    viewLoading = true;
    viewDialogOpen = true;
    await refreshView(serviceId);
    viewLoading = false;
  }

  /** @param {string} serviceId */
  async function refreshView(serviceId) {
    try {
      const [configRes, whitelistRes, bundleRes] = await Promise.all([
        fetch(api('/api/auth-hub/service-config', { serviceId })),
        fetch(api('/api/auth-hub/service-config', { serviceId, whitelist: '1' })),
        fetch(api('/api/auth-hub/bundle'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceId })
        })
      ]);
      const configResult = await configRes.json();
      if (!configRes.ok) {
        viewError = configResult.error || `Error ${configRes.status}`;
      } else {
        viewServiceConfig = configResult;
        setConfigKeys(serviceId, configKeysOf(configResult));
      }
      if (whitelistRes.ok) {
        const wl = await whitelistRes.json();
        viewWhitelistKeys = new Set(Array.isArray(wl) ? wl : Object.keys(wl));
      }
      if (bundleRes.ok) {
        const bundleResult = await bundleRes.json();
        if (bundleResult.version) {
          cachedInfo = { ...cachedInfo, [serviceId]: { ...cachedInfo[serviceId], ...bundleResult } };
        }
      }
    } catch (err) {
      viewError = /** @type {Error} */ (err).message;
    }
  }

  function enterEditMode() {
    if (viewServiceConfig) {
      viewEditConfig = Object.fromEntries(
        Object.entries(viewServiceConfig).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')])
      );
      configJsonDraft = JSON.stringify(viewServiceConfig, null, 2);
    }
    configSaveError = '';
    configJsonError = '';
    configJsonMode = false;
    newConfigKey = '';
    newConfigValue = '';
    viewEditMode = true;
  }

  function switchToJsonMode() {
    // Sync current key-value state into JSON draft
    const obj = Object.fromEntries(Object.entries(viewEditConfig).map(([k, v]) => [k, v]));
    configJsonDraft = JSON.stringify(obj, null, 2);
    configJsonError = '';
    configJsonMode = true;
  }

  function switchToFieldMode() {
    try {
      const parsed = JSON.parse(configJsonDraft);
      viewEditConfig = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')])
      );
      configJsonError = '';
      configJsonMode = false;
    } catch (e) {
      configJsonError = 'Invalid JSON — fix before switching';
    }
  }

  async function saveServiceConfig() {
    if (!viewServiceId) return;
    configSaving = true;
    configSaveError = '';
    configJsonError = '';
    try {
      let body;
      if (configJsonMode) {
        try {
          body = JSON.parse(configJsonDraft);
        } catch {
          configJsonError = 'Invalid JSON';
          configSaving = false;
          return;
        }
        // Ensure all values are strings
        body = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? '')]));
      } else {
        // Key-value mode — values are already strings
        body = Object.fromEntries(Object.entries(viewEditConfig));
      }
      const res = await fetch(api('/api/auth-hub/service-config'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: viewServiceId, config: body })
      });
      const result = await res.json();
      if (!res.ok) {
        configSaveError = result.error || `Error ${res.status}`;
      } else {
        viewServiceConfig = body;
        setConfigKeys(viewServiceId, configKeysOf(body));
        viewEditMode = false;
      }
    } catch (err) {
      configSaveError = /** @type {Error} */ (err).message;
    } finally {
      configSaving = false;
    }
  }

  /** @param {string} key */
  async function addToWhitelist(key) {
    if (!viewServiceId) return;
    whitelistAdding = { ...whitelistAdding, [key]: true };
    try {
      const res = await fetch(api('/api/auth-hub/service-config/whitelist-key'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: viewServiceId, key, value: null })
      });
      if (res.ok) await refreshView(viewServiceId);
    } catch { /* ignore */ } finally {
      whitelistAdding = { ...whitelistAdding, [key]: false };
    }
  }

  /** @param {string} key */
  async function removeFromWhitelist(key) {
    if (!viewServiceId) return;
    whitelistRemoving = { ...whitelistRemoving, [key]: true };
    try {
      const res = await fetch(api('/api/auth-hub/service-config/whitelist-key'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: viewServiceId, key })
      });
      if (res.ok) await refreshView(viewServiceId);
    } catch { /* ignore */ } finally {
      whitelistRemoving = { ...whitelistRemoving, [key]: false };
    }
  }

  /** @param {string} serviceId */
  function downloadBundle(serviceId) {
    window.open(api('/api/auth-hub/bundle-download', { serviceId }), '_blank');
  }

  // Delete confirm (admin only)
  /** @type {string|null} */
  let deleteServiceId = $state(null);
  let deleteDialogOpen = $state(false);
  let deleting = $state(false);
  let deleteError = $state('');

  // GitHub versions (admin only)
  /** @type {Record<string, {version: string, path: string}>} */
  let githubVersions = $derived(
    Object.fromEntries(Object.entries(data.githubVersions || {}).map(([k, v]) => [k, { version: v, path: '' }]))
  );
  let showNotInAuthHub = $state(false);

  let filteredConnectors = $derived(
    connectors.filter((c) => {
      if (search) {
        const q = search.toLowerCase();
        if (!(c.serviceId || '').toLowerCase().includes(q)) return false;
      }
      if (showConfigCheck && configFilter.size > 0) {
        // Only connectors in the Auth Hub have a config to check
        if (c.source === 'github') return false;
        if (!configFilter.has(c.configKeys?.length ? 'configured' : 'not_configured')) return false;
      }
      if (!showConfigCheck && statusFilter.size > 0) {
        const s = statuses[c.serviceId] || 'not_verified';
        if (!statusFilter.has(s)) return false;
      }
      if (showNotInAuthHub && c.source !== 'github') return false;
      return true;
    })
  );

  let githubOnlyCount = $derived(filteredConnectors.filter(c => c.source === 'github').length);

  /** @param {string} serviceId */
  function shortName(serviceId) {
    if (!serviceId) return '';
    const parts = serviceId.split(':');
    return parts.length > 1 ? parts.slice(1).join(':') : serviceId;
  }

  async function fetchAll() {
    fetchAllRunning = true;
    fetchAllPhase = 'bundles';
    const ids = connectors.filter(c => c.source !== 'github').map(c => c.serviceId).filter(Boolean);
    fetchAllProgress = { done: 0, total: ids.length };

    for (const serviceId of ids) {
      bundleLoading = { ...bundleLoading, [serviceId]: true };
      try {
        const res = await fetch(api('/api/auth-hub/bundle'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceId })
        });
        const result = await res.json();
        if (res.ok && result.version) {
          cachedInfo = { ...cachedInfo, [serviceId]: { ...cachedInfo[serviceId], version: result.version } };
        }
      } catch { /* continue */ }
      bundleLoading = { ...bundleLoading, [serviceId]: false };
      fetchAllProgress = { done: fetchAllProgress.done + 1, total: ids.length };
    }

    try {
      const cacheRes = await fetch(api('/api/auth-hub/bundle'));
      if (cacheRes.ok) {
        cachedInfo = await cacheRes.json();
      }
    } catch { /* ignore */ }

    // Refresh GitHub oauth2 connector cache + versions in DB
    fetchAllPhase = 'github';
    try {
      const ghRes = await fetch('/api/auth-hub/github-oauth', { method: 'POST' });
      if (ghRes.ok) {
        const ghData = await ghRes.json();
        /** @type {Array<{serviceId: string, path: string}>} */
        const githubOAuth = ghData.oauth2 || [];
        /** @type {Record<string, string>} */
        const rawVersions = ghData.versions || {};

        // Update github versions map
        githubVersions = Object.fromEntries(
          Object.entries(rawVersions).map(([k, v]) => [k, { version: v, path: '' }])
        );

        const authhubIds = new Set(connectors.filter(c => c.source !== 'github').map(c => c.serviceId));
        const githubIds = new Set(githubOAuth.map(c => c.serviceId));

        connectors = connectors
          .filter(c => c.source !== 'github' || githubIds.has(c.serviceId))
          .map(c => ({ ...c, source: githubIds.has(c.serviceId) ? (c.source === 'github' ? 'github' : 'both') : c.source }));

        for (const c of githubOAuth) {
          if (!authhubIds.has(c.serviceId) && !connectors.find(x => x.serviceId === c.serviceId)) {
            connectors = [...connectors, { serviceId: c.serviceId, source: 'github' }];
          }
        }

        connectors = [...connectors].sort((a, b) => (a.serviceId || '').localeCompare(b.serviceId || ''));
      }
    } catch { /* ignore */ }

    fetchAllRunning = false;
    fetchAllPhase = '';
  }

  /**
   * @param {string} serviceId
   * @param {string} status
   */
  async function updateStatus(serviceId, status) {
    statuses = { ...statuses, [serviceId]: status };
    try {
      await fetch(api('/api/auth-hub/status'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId, status })
      });
    } catch { /* ignore */ }
  }

  async function confirmDelete() {
    if (!deleteServiceId) return;
    deleting = true;
    deleteError = '';
    try {
      const res = await fetch(api('/api/auth-hub/connector'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: deleteServiceId })
      });
      const result = await res.json();
      if (!res.ok) {
        deleteError = result.error || 'Delete failed';
        return;
      }
      // Remove from local state
      // A connector the repository has stays listed as "not in Auth Hub"
      connectors = connectors.flatMap((c) => {
        if (c.serviceId !== deleteServiceId) return [c];
        return c.source === 'both' ? [{ ...c, source: 'github' }] : [];
      });
      cachedInfo = Object.fromEntries(Object.entries(cachedInfo).filter(([k]) => k !== deleteServiceId));
      deleteServiceId = null;
      deleteDialogOpen = false;
    } catch {
      deleteError = 'Delete failed';
    } finally {
      deleting = false;
    }
  }

  /**
   * @param {string|undefined} authhubVersion
   * @param {string|undefined} githubVersion
   * @returns {'outdated'|'newer'|'match'|null}
   */
  function compareVersions(authhubVersion, githubVersion) {
    if (!authhubVersion || !githubVersion) return null;
    const a = authhubVersion.split('.').map(Number);
    const g = githubVersion.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, g.length); i++) {
      const av = a[i] || 0;
      const gv = g[i] || 0;
      if (av < gv) return 'outdated';
      if (av > gv) return 'newer';
    }
    return 'match';
  }

  // Switching the environment mid-operation would mix up the two Auth Hubs
  let busy = $derived(
    fetchAllRunning || uploading || deleting || configSaving || batchRunning ||
      ['checking', 'saving', 'uploading', 'polling'].includes(uploadNewStep)
  );

  let allFilteredSelected = $derived(
    filteredConnectors.length > 0 && filteredConnectors.every((c) => selected.has(c.serviceId))
  );
  // Rows the version column flags ⚠️ (Auth Hub older than the repository)
  let outdatedIds = $derived(
    connectors
      .filter((c) => c.source !== 'github')
      .filter((c) => compareVersions(cachedInfo[c.serviceId]?.version, githubVersions[c.serviceId]?.version) === 'outdated')
      .map((c) => c.serviceId)
  );
</script>

{#snippet envTarget()}
  <p class="rounded-md px-3 py-2 text-xs {data.env.id === 'prod' ? 'bg-destructive/10 text-destructive' : 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'}">
    Target: <strong>{data.env.label}</strong> Auth Hub{#if data.env.host}{' '}(<span class="font-mono">{data.env.host}</span>){/if}
  </p>
{/snippet}

{#snippet bundleModeToggle(/** @type {() => void} */ onRepo)}
  <div class="flex gap-1">
    {#each [{ mode: 'repo', label: 'From repository' }, { mode: 'file', label: 'ZIP file' }] as opt}
      <button
        class="rounded px-2 py-0.5 text-xs border transition-colors {bundleMode === opt.mode ? 'bg-primary text-primary-foreground border-primary' : 'border-input text-muted-foreground hover:bg-muted'}"
        onclick={() => {
          if (bundleMode === opt.mode) return;
          bundleMode = /** @type {'repo'|'file'} */ (opt.mode);
          if (opt.mode === 'repo') onRepo();
        }}
      >{opt.label}</button>
    {/each}
  </div>
{/snippet}

{#snippet repoPanel(/** @type {string} */ serviceId)}
  <div class="min-w-0 space-y-2">
    <div class="flex items-center gap-2">
      <label class="shrink-0 text-xs font-medium text-muted-foreground" for="repo-source">Source</label>
      <select
        id="repo-source"
        class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        bind:value={repoSource}
        onchange={() => loadRepoPreview(serviceId)}
        disabled={repoPreviewLoading}
      >
        {#each data.packSources || [] as src}
          <option value={src.id}>{src.label} — {src.repo}@{src.branch}</option>
        {/each}
      </select>
    </div>
    {#if repoPreviewLoading}
      <div class="flex items-center gap-2 rounded-md border p-3 text-xs text-muted-foreground">
        <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
        Reading {serviceId} from GitHub…
      </div>
    {:else if repoPreviewError}
      <p class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">{repoPreviewError}</p>
    {:else if repoPreview}
      {@const current = cachedInfo[repoPreview.serviceId]?.version}
      {@const cmp = compareVersions(current, repoPreview.version)}
      <div class="min-w-0 space-y-1 rounded-md border p-3">
        <div class="flex items-baseline justify-between gap-2">
          <span class="min-w-0 truncate font-mono text-sm font-medium">{repoPreview.name}</span>
          <span class="text-sm font-semibold tabular-nums">v{repoPreview.version ?? '?'}</span>
        </div>
        <p class="text-xs {cmp === 'newer' ? 'font-medium text-destructive' : cmp === 'match' ? 'text-muted-foreground' : ''}">
          {#if !current}
            Not in {data.env.label} Auth Hub yet (or its version isn't loaded)
          {:else if cmp === 'outdated'}
            {data.env.label} Auth Hub has v{current} — this upgrades it
          {:else if cmp === 'match'}
            {data.env.label} Auth Hub already has v{current} — the files may still differ
          {:else if cmp === 'newer'}
            ⚠ {data.env.label} Auth Hub has a newer v{current} — this is a downgrade
          {/if}
        </p>
        <p class="text-xs text-muted-foreground">
          <a href={repoPreview.pathUrl} target="_blank" rel="noreferrer" class="underline hover:text-foreground">{repoPreview.path}</a>
          at <a href={repoPreview.commitUrl} target="_blank" rel="noreferrer" class="font-mono underline hover:text-foreground">{repoPreview.commitSha.slice(0, 7)}</a>
          {#if repoPreview.committedAt}({new Date(repoPreview.committedAt).toLocaleString()}){/if}
        </p>
        <p class="text-xs text-muted-foreground">
          {repoPreview.kind === 'module' ? 'Module, with the shared files of its service' : 'Service'} ·
          <button class="underline hover:text-foreground" onclick={() => { repoFilesOpen = !repoFilesOpen; }}>{repoPreview.files.length} files</button>,
          {formatSize(repoPreview.totalSize)} ·
          <button class="underline hover:text-foreground" onclick={downloadRepoPack}>Download ZIP</button>
        </p>
        {#if repoFilesOpen}
          <ul class="mt-1 max-h-40 overflow-y-auto rounded bg-muted/50 p-2 font-mono text-xs">
            {#each repoPreview.files as f}
              <li class="flex justify-between gap-2">
                <span class="min-w-0 truncate" title={f.name}>{f.name}</span>
                <span class="shrink-0 text-muted-foreground">{formatSize(f.size)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else}
      <p class="rounded-md border p-3 text-xs text-muted-foreground">
        {serviceId ? 'Pick a source to read the connector from GitHub.' : 'Enter the service name to read it from GitHub.'}
      </p>
    {/if}
  </div>
{/snippet}

<div class="space-y-6">
  <div class="flex flex-wrap items-center justify-between gap-4">
    <div>
      <div class="flex items-center gap-2">
        <h1 class="text-2xl font-bold">Auth Hub</h1>
        {#if data.env.id !== 'prod'}
          <Badge variant="warning">{data.env.label}</Badge>
        {/if}
      </div>
      <p class="text-muted-foreground">
        Browse connectors registered in {data.env.label} Auth Hub
        {#if data.env.host}<span class="font-mono text-xs">· {data.env.host}</span>{/if}
      </p>
      {#if data.isAdmin && data.githubInfo}
        <p class="text-xs text-muted-foreground mt-1">
          GitHub: <a href={data.githubInfo.url} target="_blank" class="underline hover:text-foreground">{data.githubInfo.owner}/{data.githubInfo.repo}</a> ({data.githubInfo.branch})
          · <a href="/settings" class="underline hover:text-foreground">Settings</a>
        </p>
      {/if}
    </div>
    <div class="flex flex-wrap items-center gap-3">
      <nav class="inline-flex rounded-md border p-0.5" aria-label="Auth Hub environment">
        {#each data.envs as e (e.id)}
          {#if e.configured || e.id === data.env.id}
            <a
              href="?env={e.id}"
              data-sveltekit-noscroll
              aria-current={e.id === data.env.id ? 'page' : undefined}
              aria-disabled={busy}
              class="rounded px-3 py-1 text-xs font-medium transition-colors {e.id === data.env.id ? (e.id === 'prod' ? 'bg-primary text-primary-foreground' : 'bg-yellow-500 text-white') : 'text-muted-foreground hover:bg-muted'} {busy ? 'pointer-events-none opacity-50' : ''}"
            >{e.label}</a>
          {:else}
            <span
              class="cursor-not-allowed rounded px-3 py-1 text-xs text-muted-foreground/50"
              title="Not configured — set {e.requires.join(' and ')}"
            >{e.label}</span>
          {/if}
        {/each}
      </nav>
      <Badge variant="secondary">{filteredConnectors.length} connectors</Badge>
      {#if githubOnlyCount > 0}
        <Badge variant="outline" class="text-orange-600 border-orange-300">{githubOnlyCount} not in Auth Hub</Badge>
      {/if}
      {#if !data.error}
        <Button
          variant="outline"
          size="sm"
          onclick={fetchAll}
          disabled={fetchAllRunning}
        >
          {#if fetchAllRunning}
            {#if fetchAllPhase === 'github'}
              GitHub versions...
            {:else}
              Bundles {fetchAllProgress.done}/{fetchAllProgress.total}...
            {/if}
          {:else}
            Refresh
          {/if}
        </Button>
        {#if data.isAdmin}
          <Button
            variant="outline"
            size="sm"
            onclick={() => { resetUploadNew(); uploadNewDialogOpen = true; }}
            disabled={busy}
          >
            Upload New
          </Button>
        {/if}
      {/if}
    </div>
  </div>

  {#if data.error}
    <div class="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-destructive">
      <p>{data.error}</p>
    </div>
  {:else}
    <div class="flex items-center gap-3">
      <div class="max-w-sm flex-1">
        <Input
          placeholder="Search connectors..."
          bind:value={search}
        />
      </div>
      <div class="flex items-center gap-1">
        <button
          class="h-8 px-3 rounded-md border text-xs transition-colors {showNotInAuthHub ? 'bg-orange-500 text-white border-orange-500' : 'bg-background border-input text-muted-foreground hover:bg-muted'}"
          onclick={() => { showNotInAuthHub = !showNotInAuthHub; }}
        >
          Not in Auth Hub
        </button>
        {#each showConfigCheck ? CONFIG_FILTERS : STATUS_FILTERS as opt (opt.value)}
          {@const active = (showConfigCheck ? configFilter : statusFilter).has(opt.value)}
          <button
            class="h-8 px-3 rounded-md border text-xs transition-colors {active ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input text-muted-foreground hover:bg-muted'}"
            onclick={() => {
              if (showConfigCheck) configFilter = toggled(configFilter, opt.value);
              else statusFilter = toggled(statusFilter, opt.value);
            }}
          >
            {opt.label}
          </button>
        {/each}
      </div>
      {#if data.isAdmin}
        <button
          class="h-8 px-3 rounded-md border border-input bg-background text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
          title="Select every connector whose Auth Hub bundle is older than the repository (⚠️)"
          disabled={outdatedIds.length === 0 || batchRunning}
          onclick={() => { selected = new Set([...selected, ...outdatedIds]); }}
        >
          Select outdated ({outdatedIds.length})
        </button>
      {/if}
    </div>

    {#if data.isAdmin && (selected.size > 0 || batchRunning)}
      <div class="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm shadow-md">
        {#if batchRunning}
          <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
          <span>
            Uploading to {data.env.label}: {batchRun.finished} of {batchRun.total} finished{batchCounts.failed ? `, ${batchCounts.failed} failed` : ''}
          </span>
          <button class="text-xs underline" onclick={() => { batchDialogOpen = true; }}>Show progress</button>
        {:else}
          <span class="font-medium">{selected.size} selected</span>
          <Button size="sm" onclick={openBatch} disabled={busy}>Upload from repository…</Button>
          <button class="text-xs text-muted-foreground underline hover:text-foreground" onclick={() => { selected = new Set(); }}>Clear</button>
        {/if}
      </div>
    {/if}

    {#if filteredConnectors.length === 0}
      <div class="text-center py-12 border rounded-lg bg-muted/50">
        <p class="text-muted-foreground">No connectors found</p>
      </div>
    {:else}
      <div class="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {#if data.isAdmin}
                <TableHead class="w-8">
                  <Checkbox
                    checked={allFilteredSelected}
                    disabled={batchRunning}
                    aria-label="Select all shown connectors"
                    onCheckedChange={(/** @type {boolean} */ on) => toggleAllFiltered(on)}
                  />
                </TableHead>
              {/if}
              <TableHead class="w-10"><span></span></TableHead>
              <TableHead>Connector</TableHead>
              <TableHead class="w-28">Auth Hub</TableHead>
              <TableHead class="w-40">{showConfigCheck ? 'Config' : 'Status'}</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead class="w-20"><span></span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each filteredConnectors as connector}
              {@const info = cachedInfo[connector.serviceId]}
              {@const currentStatus = statuses[connector.serviceId] || 'not_verified'}
              {@const ghInfo = githubVersions[connector.serviceId]}
              {@const cmp = compareVersions(info?.version, ghInfo?.version)}
              {@const githubOnly = connector.source === 'github'}
              <TableRow class={githubOnly && !selected.has(connector.serviceId) ? 'opacity-60' : ''}>
                {#if data.isAdmin}
                  <TableCell>
                    <Checkbox
                      checked={selected.has(connector.serviceId)}
                      disabled={batchRunning}
                      aria-label="Select {connector.serviceId}"
                      onCheckedChange={(/** @type {boolean} */ on) => toggleSelected(connector.serviceId, on)}
                    />
                  </TableCell>
                {/if}
                <TableCell>
                  {#if info?.icon}
                    <img src={info.icon} alt="" class="w-5 h-5 object-contain" />
                  {:else}
                    <div class="w-5 h-5 rounded bg-muted flex items-center justify-center text-xs text-muted-foreground">
                      {(shortName(connector.serviceId) || '?')[0].toUpperCase()}
                    </div>
                  {/if}
                </TableCell>
                <TableCell>
                  <div class="flex items-baseline gap-2">
                    <span class="font-medium">{info?.label || shortName(connector.serviceId)}</span>
                    <span class="text-xs text-muted-foreground">{connector.serviceId}</span>
                    {#if githubOnly && info?.version}
                      <span
                        class="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
                        title="{data.env.label} Auth Hub has its bundle, but no service config — it isn't listed until it has one. Add creates it."
                      >bundle only, no service config</span>
                    {:else if githubOnly}
                      <span class="rounded bg-orange-100 px-1.5 py-0.5 text-xs text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">not in Auth Hub</span>
                    {/if}
                  </div>
                </TableCell>
                <TableCell>
                  {#if githubOnly}
                    <span class="text-muted-foreground tabular-nums">{info?.version ? `v${info.version}` : '—'}</span>
                  {:else if bundleLoading[connector.serviceId]}
                    <span class="text-xs text-muted-foreground">loading...</span>
                  {:else if info?.version}
                    <span class="inline-flex items-center gap-1">
                      <span class="tabular-nums {cmp === 'outdated' ? 'text-red-600 font-semibold' : ''}">v{info.version}</span>
                      {#if cmp === 'outdated'}
                        <span title="GitHub: v{ghInfo?.version} (outdated)">⚠️</span>
                      {:else if cmp === 'match'}
                        <span class="text-green-600" title="Matches GitHub v{ghInfo?.version}">✓</span>
                      {:else if cmp === 'newer'}
                        <span class="text-blue-500" title="Newer than GitHub v{ghInfo?.version}">↑</span>
                      {/if}
                    </span>
                  {:else}
                    <span class="text-muted-foreground">—</span>
                  {/if}
                </TableCell>
                <TableCell>
                  {#if githubOnly}
                    <span class="text-muted-foreground">—</span>
                  {:else if showConfigCheck}
                    {#if connector.configKeys?.length}
                      <span class="text-xs" title="Config keys: {connector.configKeys.join(', ')}">{'\u2705'} Configured</span>
                    {:else}
                      <span class="text-xs text-muted-foreground" title="The service config has only serviceId — add clientId / clientSecret via Details → Edit">{'\u274c'} Not configured</span>
                    {/if}
                  {:else}
                    <select
                      class="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                      value={currentStatus}
                      onchange={(/** @type {Event} */ e) => updateStatus(connector.serviceId, /** @type {HTMLSelectElement} */ (e.target).value)}
                    >
                      <option value="not_verified">{'\u274c'} Not Verified</option>
                      <option value="in_progress">{'\u23f3'} In Progress</option>
                      <option value="verified">{'\u2705'} Verified</option>
                    </select>
                  {/if}
                </TableCell>
                <TableCell>
                  {@const note = notes[connector.serviceId]}
                  <button
                    class="group flex items-center gap-1 text-left w-full"
                    onclick={() => openNotes(connector.serviceId)}
                  >
                    {#if note}
                      <span class="text-xs text-foreground line-clamp-2 max-w-xs">{note}</span>
                    {:else}
                      <span class="text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">+ Add note</span>
                    {/if}
                  </button>
                </TableCell>
                <TableCell>
                  {#if data.isAdmin && !githubOnly}
                    <button
                      class="text-xs text-muted-foreground hover:text-foreground transition-colors underline"
                      onclick={() => openView(connector.serviceId)}
                    >
                      Details
                    </button>
                  {:else if data.isAdmin}
                    <button
                      class="text-xs text-muted-foreground hover:text-foreground transition-colors underline"
                      title="Add to {data.env.label} Auth Hub: service config + bundle from the repository"
                      onclick={() => { resetUploadNew(connector.serviceId); uploadNewDialogOpen = true; }}
                    >
                      Add
                    </button>
                  {/if}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  {/if}
</div>

<!-- Batch Upload Dialog -->
<Dialog bind:open={batchDialogOpen}>
  <DialogContent class="max-w-3xl">
    <DialogHeader>
      <DialogTitle>Upload {batchItems.length || selected.size} bundles from the repository</DialogTitle>
      <DialogDescription>
        Each connector is packed like <code>appmixer pack</code>, all from one commit, and uploaded one after another. A failed upload doesn't stop the rest.
      </DialogDescription>
    </DialogHeader>
    {@render envTarget()}

    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <label class="shrink-0 text-xs font-medium text-muted-foreground" for="batch-source">Source</label>
      <select
        id="batch-source"
        class="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
        bind:value={batchSource}
        onchange={loadBatchPreview}
        disabled={batchLoading || batchRunning || batchCounts.done > 0}
      >
        {#each data.packSources || [] as src}
          <option value={src.id}>{src.label} — {src.repo}@{src.branch}</option>
        {/each}
      </select>
      {#if batchPreview}
        <span class="text-xs text-muted-foreground">
          at <a href={batchPreview.commitUrl} target="_blank" rel="noreferrer" class="font-mono underline hover:text-foreground">{batchPreview.commitSha.slice(0, 7)}</a>
          {#if batchPreview.committedAt}({new Date(batchPreview.committedAt).toLocaleString()}){/if}
        </span>
      {/if}
    </div>

    {#if batchLoading}
      <div class="flex items-center gap-2 rounded-md border p-3 text-xs text-muted-foreground">
        <div class="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
        Reading {selected.size} connectors from GitHub…
      </div>
    {:else if batchError}
      <p class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">{batchError}</p>
    {:else if batchItems.length}
      <div class="max-h-[50vh] min-w-0 overflow-auto rounded-md border">
        <table class="w-full text-xs">
          <thead class="sticky top-0 z-10 bg-background text-left text-muted-foreground">
            <tr class="border-b">
              <th class="w-8 p-2">
                <Checkbox
                  checked={batchIncludable.length > 0 && batchIncludable.every((i) => i.include)}
                  disabled={batchRunning || batchIncludable.length === 0}
                  aria-label="Upload all"
                  onCheckedChange={(/** @type {boolean} */ on) => { for (const i of batchIncludable) i.include = on; }}
                />
              </th>
              <th class="p-2 font-medium">Connector</th>
              <th class="p-2 font-medium">{data.env.label}</th>
              <th class="p-2 font-medium">Repository</th>
              <th class="p-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {#each batchItems as item (item.serviceId)}
              {@const current = cachedInfo[item.serviceId]?.version}
              <tr class="border-b last:border-0 align-top {item.ok ? '' : 'bg-destructive/5'}">
                <td class="p-2">
                  <Checkbox
                    checked={item.include}
                    disabled={!item.ok || batchRunning || item.state === 'done'}
                    aria-label="Upload {item.serviceId}"
                    onCheckedChange={(/** @type {boolean} */ on) => { item.include = on; }}
                  />
                </td>
                <td class="p-2">
                  <div class="font-mono">{item.serviceId}</div>
                  {#if item.ok}
                    <div class="text-muted-foreground">
                      <a href={item.pathUrl} target="_blank" rel="noreferrer" class="underline hover:text-foreground">{item.kind}</a>
                      · {item.fileCount} files, {formatSize(item.totalSize)}
                    </div>
                  {/if}
                </td>
                <td class="p-2 tabular-nums">
                  {#if current}v{current}{:else if item.verdict === 'new'}<span class="text-muted-foreground">not there</span>{:else}<span class="text-muted-foreground" title="Not loaded — Refresh reads the Auth Hub versions">?</span>{/if}
                </td>
                <td class="p-2 tabular-nums">{item.ok ? `v${item.version ?? '?'}` : '—'}</td>
                <td class="p-2">
                  {#if item.state === 'running'}
                    <span class="inline-flex items-center gap-1.5 text-muted-foreground">
                      <span class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent"></span>
                      {item.message}
                    </span>
                  {:else if item.state === 'done'}
                    <span class="text-green-600">✅ {item.message}</span>
                  {:else if item.state === 'failed'}
                    <span class="break-words text-destructive">❌ {item.message}</span>
                  {:else if !item.ok}
                    <span class="break-words text-destructive">{item.error}</span>
                  {:else if item.verdict === 'new'}
                    <span class="rounded bg-orange-100 px-1.5 py-0.5 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">new in {data.env.label}</span>
                  {:else if item.verdict === 'upgrade'}
                    <span class="rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">upgrade</span>
                  {:else if item.verdict === 'same'}
                    <span class="text-muted-foreground">same version</span>
                  {:else if item.verdict === 'downgrade'}
                    <span class="font-medium text-destructive">⚠ downgrade</span>
                  {:else}
                    <span class="text-muted-foreground">Auth Hub version not loaded</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if batchCounts.done || batchCounts.failed}
        {@const notYet = batchPending.filter((i) => i.state !== 'failed').length}
        <p class="text-xs {batchCounts.failed ? 'text-destructive' : 'text-green-600'}">
          {batchCounts.done} uploaded{batchCounts.failed ? `, ${batchCounts.failed} failed` : ''}{!batchRunning && notYet ? `, ${notYet} not uploaded yet` : ''}
        </p>
      {/if}
    {/if}

    <DialogFooter>
      {#if batchRunning}
        <Button variant="outline" onclick={() => { batchStopRequested = true; }} disabled={batchStopRequested}>
          {batchStopRequested ? 'Stopping after the current one…' : 'Stop'}
        </Button>
      {:else}
        <Button variant="outline" onclick={() => { batchDialogOpen = false; }}>Close</Button>
        <Button onclick={runBatch} disabled={batchLoading || batchPending.length === 0}>
          {batchCounts.failed && batchPending.every((i) => i.state === 'failed') ? 'Retry' : 'Upload'}
          {batchPending.length} to {data.env.label}
        </Button>
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Upload New Dialog -->
<Dialog bind:open={uploadNewDialogOpen}>
  <DialogContent class="max-w-xl">
    <DialogHeader>
      <DialogTitle>Upload New Connector</DialogTitle>
      <DialogDescription>Define service name, config properties, and optionally upload a bundle.</DialogDescription>
    </DialogHeader>
    {@render envTarget()}

    {#if uploadNewStep === 'confirm'}
      <p class="text-sm">Service config for <strong>{uploadNewServiceId}</strong> already exists. Do you want to overwrite it?</p>
      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewStep = 'form'; }}>Cancel</Button>
        <Button variant="destructive" onclick={() => doUploadNew(true)}>Overwrite</Button>
      </DialogFooter>
    {:else if uploadNewStep === 'done'}
      <div class="flex flex-col items-center gap-3 py-6">
        <span class="text-3xl">✅</span>
        <p class="text-sm font-medium text-green-600">{uploadNewMessage}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewDialogOpen = false; }}>Close</Button>
      </DialogFooter>
    {:else if uploadNewStep === 'error'}
      <p class="text-sm text-destructive">{uploadNewMessage}</p>
      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewStep = 'form'; uploadNewMessage = ''; }}>Back</Button>
      </DialogFooter>
    {:else if uploadNewStep !== 'form'}
      <!-- checking / saving / uploading / polling -->
      <div class="flex flex-col items-center gap-3 py-6">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
        <p class="text-sm text-muted-foreground">{uploadNewMessage}</p>
      </div>
    {:else}
      <!-- Form -->
      <div class="min-w-0 space-y-4">
        <!-- Service name -->
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">Service name</label>
          <input
            class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="e.g. appmixer:box"
            bind:value={uploadNewServiceId}
            onchange={() => { if (bundleMode === 'repo') loadRepoPreview(uploadNewServiceId.trim()); }}
          />
        </div>

        <!-- Config properties -->
        <div>
          <label class="mb-1 block text-xs font-medium text-muted-foreground">Config properties</label>
          <div class="space-y-1 rounded-md border p-3">
            {#each Object.keys(uploadNewConfig) as key (key)}
              <div class="flex items-center gap-2">
                <span class="w-32 shrink-0 text-xs text-muted-foreground truncate font-mono" title={key}>{key}</span>
                <input
                  class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                  value={uploadNewConfig[key]}
                  oninput={(e) => { uploadNewConfig = { ...uploadNewConfig, [key]: /** @type {HTMLInputElement} */ (e.target).value }; }}
                />
                <button
                  class="shrink-0 text-muted-foreground hover:text-destructive px-1 text-xs"
                  onclick={() => { const c = { ...uploadNewConfig }; delete c[key]; uploadNewConfig = c; }}
                >✕</button>
              </div>
            {/each}
            <div class="flex items-center gap-2 {Object.keys(uploadNewConfig).length > 0 ? 'pt-2 border-t mt-1' : ''}">
              <input
                class="h-7 w-32 shrink-0 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="key"
                bind:value={uploadNewConfigKey}
              />
              <input
                class="h-7 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="value"
                bind:value={uploadNewConfigValue}
              />
              <button
                class="shrink-0 rounded border border-input px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
                disabled={!uploadNewConfigKey}
                onclick={() => { if (uploadNewConfigKey) { uploadNewConfig = { ...uploadNewConfig, [uploadNewConfigKey]: uploadNewConfigValue }; uploadNewConfigKey = ''; uploadNewConfigValue = ''; } }}
              >+ Add</button>
            </div>
          </div>
        </div>

        <!-- Bundle: packed from the repository or a .zip -->
        <div>
          <div class="mb-1 flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-muted-foreground">Bundle — optional</span>
            {@render bundleModeToggle(() => loadRepoPreview(uploadNewServiceId.trim()))}
          </div>
          {#if bundleMode === 'repo'}
            {@render repoPanel(uploadNewServiceId.trim())}
          {:else}
          <div
            class="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors {uploadNewDragOver ? 'border-primary bg-primary/5' : 'border-input bg-muted/30'}"
            role="region"
            aria-label="File drop zone"
            ondragover={(e) => { e.preventDefault(); uploadNewDragOver = true; }}
            ondragleave={() => { uploadNewDragOver = false; }}
            ondrop={(e) => { e.preventDefault(); uploadNewDragOver = false; const f = e.dataTransfer?.files?.[0]; if (f) setUploadNewFile(f); }}
          >
            {#if uploadNewFile}
              <p class="text-sm font-medium">{uploadNewFile.name}</p>
              <p class="text-xs text-muted-foreground mt-1">{(uploadNewFile.size / 1024).toFixed(1)} KB</p>
              <button class="mt-1 text-xs text-muted-foreground underline hover:text-foreground" onclick={() => { uploadNewFile = null; }}>Remove</button>
            {:else}
              <p class="text-sm text-muted-foreground">Drop .zip here or</p>
              <label class="mt-1 cursor-pointer text-sm text-primary underline hover:text-primary/80">
                browse
                <input type="file" accept=".zip" class="sr-only" onchange={(e) => { const f = /** @type {HTMLInputElement} */ (e.target).files?.[0]; if (f) setUploadNewFile(f); }} />
              </label>
            {/if}
          </div>
          {/if}
          {#if uploadNewMessage}
            <p class="mt-1 text-xs text-destructive">{uploadNewMessage}</p>
          {/if}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onclick={() => { uploadNewDialogOpen = false; }}>Cancel</Button>
        <Button onclick={() => doUploadNew(false)} disabled={!uploadNewServiceId.trim() || (bundleMode === 'repo' && repoPreviewLoading)}>Upload</Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

<!-- Notes Dialog -->
<Dialog bind:open={notesDialogOpen}>
  <DialogContent class="max-w-lg">
    <DialogHeader>
      <DialogTitle>Notes</DialogTitle>
      <DialogDescription>{notesServiceId}</DialogDescription>
    </DialogHeader>
    <textarea
      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
      rows="6"
      placeholder="Add notes about this connector..."
      bind:value={notesDraft}
    ></textarea>
    <DialogFooter>
      <Button variant="outline" onclick={() => { notesDialogOpen = false; }} disabled={notesSaving}>Cancel</Button>
      <Button onclick={saveNotes} disabled={notesSaving}>{notesSaving ? 'Saving...' : 'Save'}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- View Connector Dialog -->
<Dialog bind:open={viewDialogOpen}>
  <DialogContent class="max-w-2xl">
    <DialogHeader>
      <DialogTitle>{viewServiceId}</DialogTitle>
      <DialogDescription>Service config from {data.env.label} Auth Hub</DialogDescription>
    </DialogHeader>

    {#if viewLoading}
      <div class="flex items-center justify-center py-10">
        <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
      </div>
    {:else if viewError}
      <p class="text-sm text-destructive">{viewError}</p>
    {:else if viewServiceConfig}
      <div class="max-h-[60vh] overflow-y-auto space-y-4 pr-1">
        <!-- Service Config -->
        <div>
          <p class="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Service Config</p>
          {#if viewEditMode}
            <!-- Mode toggle -->
            <div class="mb-2 flex gap-1">
              <button
                class="rounded px-2 py-0.5 text-xs border transition-colors {!configJsonMode ? 'bg-primary text-primary-foreground border-primary' : 'border-input text-muted-foreground hover:bg-muted'}"
                onclick={configJsonMode ? switchToFieldMode : undefined}
              >Fields</button>
              <button
                class="rounded px-2 py-0.5 text-xs border transition-colors {configJsonMode ? 'bg-primary text-primary-foreground border-primary' : 'border-input text-muted-foreground hover:bg-muted'}"
                onclick={!configJsonMode ? switchToJsonMode : undefined}
              >JSON</button>
            </div>

            {#if configJsonMode}
              <textarea
                class="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                rows="12"
                bind:value={configJsonDraft}
              ></textarea>
              {#if configJsonError}
                <p class="mt-1 text-xs text-destructive">{configJsonError}</p>
              {/if}
            {:else}
              <div class="space-y-1 rounded-md border p-3">
                {#each Object.keys(viewEditConfig) as key (key)}
                  <div class="flex items-center gap-2">
                    <span class="w-36 shrink-0 text-xs text-muted-foreground truncate" title={key}>{key}</span>
                    <input
                      class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                      value={viewEditConfig[key]}
                      oninput={(e) => { viewEditConfig = { ...viewEditConfig, [key]: /** @type {HTMLInputElement} */ (e.target).value }; }}
                    />
                    <button
                      class="shrink-0 text-muted-foreground hover:text-destructive px-1 text-xs"
                      title="Remove property"
                      onclick={() => { const c = { ...viewEditConfig }; delete c[key]; viewEditConfig = c; }}
                    >✕</button>
                  </div>
                {/each}
                <!-- Add new property row -->
                <div class="flex items-center gap-2 pt-2 border-t mt-2">
                  <input
                    class="h-7 w-36 shrink-0 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="key"
                    bind:value={newConfigKey}
                  />
                  <input
                    class="h-7 flex-1 rounded border border-input bg-background px-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder="value"
                    bind:value={newConfigValue}
                  />
                  <button
                    class="shrink-0 rounded border border-input px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
                    disabled={!newConfigKey}
                    onclick={() => { if (newConfigKey) { viewEditConfig = { ...viewEditConfig, [newConfigKey]: newConfigValue }; newConfigKey = ''; newConfigValue = ''; } }}
                  >+ Add</button>
                </div>
              </div>
            {/if}
            {#if configSaveError}
              <p class="mt-1 text-xs text-destructive">{configSaveError}</p>
            {/if}
            <Button size="sm" class="mt-2" onclick={saveServiceConfig} disabled={configSaving}>
              {configSaving ? 'Saving...' : 'Save Config'}
            </Button>
          {:else}
            <!-- Read-only view with Add to Whitelist buttons -->
            <div class="space-y-1 rounded-md border p-3">
              {#each Object.entries(viewServiceConfig) as [key, val]}
                <div class="flex items-center gap-2">
                  <span class="w-36 shrink-0 text-xs text-muted-foreground truncate" title={key}>{key}</span>
                  <span class="flex-1 text-xs font-mono truncate">{typeof val === 'object' ? JSON.stringify(val) : String(val ?? '')}</span>
                  {#if !WHITELIST_EXCLUDED.has(key)}
                    {#if viewWhitelistKeys.has(key)}
                      <button
                        class="shrink-0 text-xs text-green-600 hover:text-destructive disabled:opacity-40"
                        title="Remove from whitelist"
                        disabled={whitelistRemoving[key]}
                        onclick={() => removeFromWhitelist(key)}
                      >{whitelistRemoving[key] ? '...' : '✓ whitelisted'}</button>
                    {:else}
                      <button
                        class="shrink-0 rounded border border-input px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-40"
                        disabled={whitelistAdding[key]}
                        onclick={() => addToWhitelist(key)}
                      >{whitelistAdding[key] ? '...' : '+ Whitelist'}</button>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Whitelist (read-only) -->
        <div>
          <p class="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">Whitelisted keys</p>
          {#if viewWhitelistKeys.size === 0}
            <p class="text-xs text-muted-foreground italic">None</p>
          {:else}
            <div class="flex flex-wrap gap-1">
              {#each [...viewWhitelistKeys] as key}
                <span class="rounded bg-muted px-2 py-0.5 text-xs font-mono">{key}</span>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <DialogFooter class="flex-wrap gap-2">
      <Button
        variant="outline"
        onclick={() => { if (viewServiceId) downloadBundle(viewServiceId); }}
        disabled={viewLoading}
      >
        Download Bundle
      </Button>
      {#if data.isAdmin}
        {#if !viewEditMode}
          <Button variant="outline" onclick={enterEditMode} disabled={viewLoading}>Edit</Button>
        {:else}
          <Button variant="outline" onclick={() => { viewEditMode = false; }} disabled={configSaving}>Cancel Edit</Button>
        {/if}
        <Button
          variant="outline"
          onclick={() => { resetUpload(); viewDialogOpen = false; uploadDialogOpen = true; if (viewServiceId) loadRepoPreview(viewServiceId); }}
          disabled={viewLoading}
        >
          Upload Bundle
        </Button>
        <Button
          variant="destructive"
          onclick={() => { if (viewServiceId) { deleteServiceId = viewServiceId; deleteError = ''; viewDialogOpen = false; deleteDialogOpen = true; } }}
          disabled={viewLoading}
        >
          Delete
        </Button>
      {/if}
      <Button variant="outline" onclick={() => { viewDialogOpen = false; }}>Close</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Upload Bundle Dialog -->
<Dialog bind:open={uploadDialogOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Upload Bundle</DialogTitle>
      <DialogDescription>
        {viewServiceId ? `Uploading bundle for ${viewServiceId}` : 'Drop a .zip connector bundle or click to select a file.'}
      </DialogDescription>
    </DialogHeader>
    {@render envTarget()}

    {#if uploadStatus === 'idle' || uploadStatus === 'error'}
      {@render bundleModeToggle(() => { if (viewServiceId && !repoPreview) loadRepoPreview(viewServiceId); })}
      {#if bundleMode === 'repo'}
        {@render repoPanel(viewServiceId || '')}
      {:else}
      <!-- Drop zone -->
      <div
        class="mt-2 flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors {uploadDragOver ? 'border-primary bg-primary/5' : 'border-input bg-muted/30'}"
        role="region"
        aria-label="File drop zone"
        ondragover={(e) => { e.preventDefault(); uploadDragOver = true; }}
        ondragleave={() => { uploadDragOver = false; }}
        ondrop={(e) => {
          e.preventDefault();
          uploadDragOver = false;
          const file = e.dataTransfer?.files?.[0];
          if (file) setUploadFile(file);
        }}
      >
        {#if uploadFile}
          <p class="text-sm font-medium">{uploadFile.name}</p>
          <p class="text-xs text-muted-foreground mt-1">{(uploadFile.size / 1024).toFixed(1)} KB</p>
          <button class="mt-2 text-xs text-muted-foreground underline hover:text-foreground" onclick={() => { uploadFile = null; uploadMessage = ''; }}>
            Remove
          </button>
        {:else}
          <p class="text-sm text-muted-foreground">Drop .zip here or</p>
          <label class="mt-2 cursor-pointer text-sm text-primary underline hover:text-primary/80">
            browse
            <input
              type="file"
              accept=".zip"
              class="sr-only"
              onchange={(e) => {
                const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
                if (file) setUploadFile(file);
              }}
            />
          </label>
        {/if}
      </div>
      {/if}
      {#if uploadMessage}
        <p class="text-sm {uploadStatus === 'error' ? 'text-destructive' : 'text-muted-foreground'}">{uploadMessage}</p>
      {/if}
    {:else}
      <!-- Progress -->
      <div class="flex flex-col items-center gap-3 py-6">
        {#if uploadStatus === 'done'}
          <span class="text-3xl">✅</span>
          <p class="text-sm font-medium text-green-600">{uploadMessage}</p>
        {:else}
          <div class="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"></div>
          <p class="text-sm text-muted-foreground">{uploadMessage}</p>
        {/if}
      </div>
    {/if}

    <DialogFooter>
      <Button variant="outline" onclick={() => { uploadDialogOpen = false; }} disabled={uploading}>
        {uploadStatus === 'done' ? 'Close' : 'Cancel'}
      </Button>
      {#if uploadStatus === 'idle' || uploadStatus === 'error'}
        <Button
          onclick={doUpload}
          disabled={uploading || (bundleMode === 'file' ? !uploadFile : !repoPreview || repoPreviewLoading)}
        >
          Upload{bundleMode === 'repo' && repoPreview ? ` v${repoPreview.version}` : ''}
        </Button>
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- Delete Confirm Dialog -->
<Dialog bind:open={deleteDialogOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Delete Connector</DialogTitle>
      <DialogDescription>
        This will permanently delete the service config and bundle for <strong>{deleteServiceId}</strong> from the <strong>{data.env.label}</strong> Auth Hub. This action cannot be undone.
      </DialogDescription>
    </DialogHeader>
    {#if deleteError}
      <p class="text-sm text-destructive">{deleteError}</p>
    {/if}
    <DialogFooter>
      <Button variant="outline" onclick={() => { deleteDialogOpen = false; deleteServiceId = null; }} disabled={deleting}>
        Cancel
      </Button>
      <Button variant="destructive" onclick={confirmDelete} disabled={deleting}>
        {deleting ? 'Deleting...' : 'Delete'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
