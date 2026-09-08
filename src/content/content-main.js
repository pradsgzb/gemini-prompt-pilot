(function attachPromptPilotContentMain(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const messageTypes = root.MESSAGE_TYPES;
  const statuses = root.RUN_STATUS;
  const stateKey = '__PROMPT_PILOT_CONTENT_MAIN_STATE__';
  const runtimeId = utils.getChromeRuntimeId?.() || null;

  // Programmatic reinjection replaces every module in this isolated world. Ask the old
  // runner to suspend instead of stopping it so its exact current prompt remains resumable.
  try {
    const existingMain = global[stateKey];
    if (existingMain?.cleanup) existingMain.cleanup('content-script-reinitialize');
  } catch (_) {}

  function removeStalePanelHost() {
    try {
      const hostId = root.Dom?.PANEL_HOST_ID;
      if (!hostId) return;
      const host = document.getElementById(hostId);
      if (!host) return;
      const hostVersion = host.dataset?.promptPilotVersion || '';
      const hostRuntimeId = host.dataset?.promptPilotRuntimeId || '';
      if (hostVersion !== root.VERSION || (runtimeId && hostRuntimeId && hostRuntimeId !== runtimeId) || !hostVersion) host.remove();
    } catch (_) {}
  }

  removeStalePanelHost();

  const contentState = {
    version: root.VERSION,
    runtimeId,
    ready: false,
    loadedAt: new Date().toISOString(),
    cleanup: null
  };
  global[stateKey] = contentState;

  const repository = new root.SettingsRepository();
  const disposers = [];
  let activeRunner = null;
  let pagePanel = null;
  let resumeInProgress = false;
  let launchInProgress = false;
  let settingsCache = root.DEFAULT_SETTINGS || {};
  let tabContextCache = null;
  let logBuffer = [];
  let logFlushTimer = null;
  let logFlushChain = Promise.resolve([]);
  let activeRunId = null;
  let latestState = {
    status: statuses.IDLE,
    message: 'Ready',
    current: 0,
    total: 0,
    completedCount: 0,
    processedCount: 0,
    successfulCount: 0,
    failedCount: 0,
    siteId: null,
    siteName: null,
    phase: 'idle',
    runId: null,
    updatedAt: new Date().toISOString()
  };

  function flushLogsSoon(delay) {
    if (logFlushTimer) return;
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null;
      flushLogBuffer().catch(() => {});
    }, Math.max(100, Number(delay || 500)));
  }

  async function getTabContext() {
    if (tabContextCache?.tabId != null) return tabContextCache;
    try {
      const response = await utils.chromeRuntimeRequest({ type: messageTypes.GET_TAB_CONTEXT }, 10000);
      tabContextCache = {
        tabId: response.tabId ?? null,
        windowId: response.windowId ?? null,
        url: response.url || location.href
      };
    } catch (_) {
      tabContextCache = { tabId: null, windowId: null, url: location.href };
    }
    return tabContextCache;
  }

  async function flushLogBufferNow() {
    if (!logBuffer.length || settingsCache.logging?.persist === false) return [];
    const batch = logBuffer.splice(0, logBuffer.length);
    try {
      const tabContext = await getTabContext();
      const fallbackRunId = activeRunId || latestState.runId || `tab-${tabContext.tabId ?? 'unknown'}-session`;
      const groups = new Map();
      for (const entry of batch) {
        const runId = entry.runId || entry.context?.runId || entry.meta?.runId || fallbackRunId;
        if (!groups.has(runId)) groups.set(runId, []);
        groups.get(runId).push({ ...entry, runId });
      }

      const persisted = [];
      for (const [runId, entries] of groups.entries()) {
        const result = await repository.appendRunLogs(
          runId,
          entries,
          settingsCache.logging?.maxEntries ?? 2000,
          settingsCache.logging?.maxBytesPerRun ?? 1500000,
          settingsCache.logging?.maxPersistedRuns ?? 8
        );
        persisted.push(...result.slice(-entries.length));
      }
      return persisted;
    } catch (_) {
      // Do not discard diagnostics just because storage was temporarily unavailable.
      logBuffer = [...batch, ...logBuffer].slice(-1000);
      return [];
    }
  }

  function flushLogBuffer() {
    // Storage append operations are read-modify-write. Serialize all flushes so a popup state read,
    // pagehide flush and timer flush cannot overwrite one another and lose diagnostic entries.
    logFlushChain = logFlushChain
      .catch(() => [])
      .then(() => flushLogBufferNow());
    return logFlushChain;
  }

  function cleanup(reason) {
    try { activeRunner?.suspendForReload?.(reason || 'content-script-cleanup'); } catch (_) {}
    activeRunner = null;
    try { pagePanel?.close?.(); } catch (_) {}
    pagePanel = null;
    if (logFlushTimer) clearTimeout(logFlushTimer);
    logFlushTimer = null;
    flushLogBuffer().catch(() => {});
    while (disposers.length) {
      try { disposers.pop()(); } catch (_) {}
    }
    if (global[stateKey] === contentState) {
      global[stateKey] = {
        version: root.VERSION,
        runtimeId,
        ready: false,
        loadedAt: contentState.loadedAt,
        unloadedAt: new Date().toISOString(),
        reason: reason || 'cleanup'
      };
    }
  }
  contentState.cleanup = cleanup;

  function ensurePanel() {
    if (!pagePanel) {
      pagePanel = new root.PagePanel({
        repository,
        getState,
        getContext: resolveContext,
        startRun,
        stopRun,
        onSettingsChanged: patch => applyLiveSettings(patch, 'panel')
      });
    }
    return pagePanel;
  }

  function applyLiveSettings(settingsOrPatch, source, options) {
    const replace = options?.replace === true;
    const nextSettings = replace
      ? utils.deepMerge(root.DEFAULT_SETTINGS || {}, settingsOrPatch || {})
      : utils.deepMerge(settingsCache || root.DEFAULT_SETTINGS || {}, settingsOrPatch || {});
    settingsCache = nextSettings;
    activeRunner?.updateSettings?.(nextSettings, { replace: true });
    if (source !== 'panel' && pagePanel?.host) pagePanel.applyExternalSettings?.(nextSettings);
    return nextSettings;
  }

  function publishStatus(statePatch) {
    latestState = utils.deepMerge(latestState, statePatch || {});
    if (statePatch?.runId) {
      activeRunId = statePatch.runId;
      latestState.runId = statePatch.runId;
    }
    latestState.updatedAt = new Date().toISOString();
    if (pagePanel?.host) pagePanel.updateRunState(latestState);
    utils.safeChromeSendMessage({
      type: messageTypes.STATUS,
      state: latestState,
      url: location.href,
      version: root.VERSION
    });
  }

  function publishLog(entry) {
    const normalizedEntry = {
      time: entry?.time || new Date().toISOString(),
      elapsedMs: entry?.elapsedMs ?? null,
      sequence: entry?.sequence ?? null,
      scope: entry?.scope || 'PromptPilot',
      level: entry?.level || 'info',
      event: entry?.event || entry?.meta?.event || null,
      message: entry?.message || '',
      context: entry?.context || null,
      meta: entry?.meta || null,
      runId: entry?.context?.runId || entry?.meta?.runId || activeRunId || latestState.runId || null,
      url: location.href,
      version: root.VERSION
    };
    if (normalizedEntry.runId) activeRunId = normalizedEntry.runId;
    if (pagePanel?.host) pagePanel.appendLog(normalizedEntry);
    if (settingsCache.logging?.persist !== false) {
      logBuffer.push(normalizedEntry);
      flushLogsSoon(logBuffer.length >= 25 ? 100 : 500);
    }
    utils.safeChromeSendMessage({
      type: messageTypes.STATUS,
      event: 'log',
      entry: normalizedEntry,
      state: latestState,
      url: location.href,
      version: root.VERSION
    });
  }

  async function resolveContext(settingsOverride) {
    const settings = utils.deepMerge(root.DEFAULT_SETTINGS || {}, settingsOverride || await repository.getSettings());
    settingsCache = settings;
    const configs = await repository.getSiteConfigs();
    const config = root.SiteResolver.resolveSiteConfig(configs, location.href);
    const capabilities = root.SiteResolver.getCapabilities(config);
    latestState.siteId = config?.id || null;
    latestState.siteName = config?.name || 'Unsupported site';
    return { settings, configs, config, capabilities };
  }

  async function getCheckpointForTab(tabContext) {
    if (tabContext?.tabId != null) return repository.getActiveRun(tabContext.tabId).catch(() => null);
    return repository.getRunState().catch(() => null);
  }

  async function getState() {
    const [{ settings, config, capabilities }, tabContext] = await Promise.all([
      resolveContext(),
      getTabContext()
    ]);
    const checkpoint = await getCheckpointForTab(tabContext);
    const runId = activeRunner?.checkpoint?.data?.runId
      || checkpoint?.runId
      || latestState.runId
      || activeRunId
      || null;
    if (runId) activeRunId = runId;
    await flushLogBuffer().catch(() => {});
    const logs = runId ? await repository.getRunLogs(runId).catch(() => []) : [];
    return {
      state: latestState,
      settings,
      site: root.SiteResolver.summarizeConfig(config),
      capabilities,
      logs: logs.slice(-1000),
      checkpoint,
      tabContext,
      logRunId: runId,
      version: root.VERSION,
      runtimeId,
      contextHealthy: utils.hasUsableExtensionContext?.() !== false,
      url: location.href
    };
  }

  function isRunning() {
    if (launchInProgress || resumeInProgress) return true;
    if (!activeRunner) return false;
    // launchRunner assigns activeRunner before runner.start() reaches its first await. Treat that
    // short IDLE window as active so two rapid Start commands cannot create concurrent queues.
    return ![
      statuses.COMPLETED,
      statuses.STOPPED,
      statuses.ERROR
    ].includes(activeRunner.state?.status);
  }

  async function launchRunner(config, settings, prompts, resumeCheckpoint) {
    const tabContext = await getTabContext();
    const logger = new root.Logger(
      `PromptPilot:${config.id}`,
      settings.logging?.level || settings.logLevel || 'debug',
      publishLog,
      {
        siteId: config.id,
        tabId: tabContext.tabId,
        extensionVersion: root.VERSION
      }
    );
    const runner = new root.AutomationRunner(config, settings, logger, publishStatus, {
      repository,
      tabContext,
      resumeCheckpoint: resumeCheckpoint || null
    });
    activeRunner = runner;

    const runPromise = runner.start(prompts);
    activeRunId = runner.checkpoint?.data?.runId || resumeCheckpoint?.runId || activeRunId;
    runPromise
      .catch(error => {
        publishStatus({
          status: statuses.ERROR,
          message: error.message,
          lastError: error.message,
          phase: 'error',
          runId: runner.checkpoint?.data?.runId || activeRunId
        });
      })
      .finally(() => {
        if (activeRunner === runner && ![
          statuses.PREPARING,
          statuses.RUNNING,
          statuses.COOLDOWN,
          statuses.RECOVERING,
          statuses.RETRYING,
          statuses.STOPPING
        ].includes(runner.state.status)) {
          activeRunner = null;
        }
        flushLogsSoon(100);
      });
    return runner;
  }

  async function startRun(message) {
    if (isRunning()) throw new Error('A run is already active on this tab. Stop it before starting a new one.');
    // Acquire the launch lock synchronously, before the first await. Runtime messages can arrive
    // back-to-back; without this lock, two Start commands can both pass isRunning() while site
    // settings/tab context are still resolving and create concurrent runners for the same queue.
    launchInProgress = true;
    try {
      const prompts = Array.isArray(message.prompts) ? message.prompts : [];
      const settings = message.settings || await repository.getSettings();
      settingsCache = settings;
      const { config, capabilities } = await resolveContext(settings);
      if (!config || !capabilities.supported) throw new Error('This website is not supported by the current site configuration.');

      const runner = await launchRunner(config, settings, prompts, null);
      return { accepted: true, state: runner.state, runId: runner.checkpoint?.data?.runId || null };
    } finally {
      launchInProgress = false;
    }
  }

  async function attemptAutoResume(config, settings) {
    if (isRunning() || !config || settings.autoResume === false) return false;
    // Reserve the tab immediately so a manual Start cannot race an asynchronous checkpoint read.
    resumeInProgress = true;
    try {
      const tabContext = await getTabContext();
      const checkpoint = await getCheckpointForTab(tabContext);
      if (!root.RunCheckpoint.isResumable(checkpoint)) return false;
      if (!root.RunCheckpoint.isFresh(checkpoint, settings.resumeMaxAgeHours || 24)) return false;
      if (!root.RunCheckpoint.belongsToTab(checkpoint, tabContext)) return false;
      if (checkpoint.owner?.siteId && checkpoint.owner.siteId !== config.id) return false;
      try {
        if (checkpoint.owner?.origin && checkpoint.owner.origin !== new URL(location.href).origin) return false;
      } catch (_) {}

      settingsCache = utils.deepMerge(checkpoint.settings || {}, settings);
      activeRunId = checkpoint.runId;
      publishStatus({
        status: statuses.RECOVERING,
        phase: 'auto-resume',
        message: `Resuming prompt ${checkpoint.currentIndex + 1}/${checkpoint.total} from durable checkpoint.`,
        current: checkpoint.currentIndex + 1,
        total: checkpoint.total,
        completedCount: checkpoint.completedCount || 0,
        processedCount: checkpoint.processedCount || checkpoint.completedCount || 0,
        successfulCount: checkpoint.successfulCount || 0,
        failedCount: checkpoint.failedCount || 0,
        runId: checkpoint.runId
      });
      await launchRunner(config, settingsCache, [], checkpoint);
      return true;
    } finally {
      resumeInProgress = false;
    }
  }

  async function stopRun() {
    if (activeRunner) {
      activeRunner.stop();
      return { stopped: true, state: activeRunner.state };
    }
    publishStatus({ status: statuses.STOPPED, message: 'No active run.', phase: 'stopped' });
    return { stopped: false, state: latestState };
  }

  async function togglePanel() { return ensurePanel().toggle(); }
  async function showPanel() { return ensurePanel().open(); }
  async function hidePanel() {
    if (pagePanel) pagePanel.collapse();
    return { visible: Boolean(pagePanel?.host), collapsed: true };
  }

  async function handleMessage(message) {
    if (!message || !message.type) return null;
    if (message.type === messageTypes.PING) {
      return {
        pong: true,
        version: root.VERSION,
        runtimeId,
        contextHealthy: utils.hasUsableExtensionContext?.() !== false
      };
    }
    if (message.type === messageTypes.GET_STATE) return getState();
    if (message.type === messageTypes.START_RUN) return startRun(message);
    if (message.type === messageTypes.STOP_RUN) return stopRun();
    if (message.type === messageTypes.TOGGLE_PANEL) return togglePanel();
    if (message.type === messageTypes.SHOW_PANEL) return showPanel();
    if (message.type === messageTypes.HIDE_PANEL) return hidePanel();
    return null;
  }

  function addRuntimeMessageListener() {
    if (!utils.hasUsableExtensionContext?.()) return false;
    const listener = (message, sender, sendResponse) => {
      handleMessage(message)
        .then(result => sendResponse({ ok: true, ...(result || {}) }))
        .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    };

    try {
      chrome.runtime.onMessage.addListener(listener);
      disposers.push(() => {
        try { chrome.runtime.onMessage.removeListener(listener); } catch (_) {}
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function addSettingsStorageListener() {
    if (!utils.hasUsableExtensionContext?.() || !global.chrome?.storage?.onChanged) return false;
    const listener = (changes, areaName) => {
      if (areaName !== 'local') return;
      const change = changes?.[root.STORAGE_KEYS.SETTINGS];
      if (!change) return;
      const nextSettings = utils.deepMerge(root.DEFAULT_SETTINGS || {}, change.newValue || {});
      applyLiveSettings(nextSettings, 'storage', { replace: true });
    };
    try {
      chrome.storage.onChanged.addListener(listener);
      disposers.push(() => {
        try { chrome.storage.onChanged.removeListener(listener); } catch (_) {}
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function addLifecycleSuspension() {
    const suspend = event => {
      try { activeRunner?.suspendForReload?.(`page-${event?.type || 'lifecycle'}`); } catch (_) {}
      flushLogBuffer().catch(() => {});
    };
    try {
      global.addEventListener('pagehide', suspend, { capture: true });
      disposers.push(() => global.removeEventListener('pagehide', suspend, { capture: true }));
    } catch (_) {}
  }

  const listenerAttached = addRuntimeMessageListener();
  addSettingsStorageListener();
  addLifecycleSuspension();
  contentState.ready = listenerAttached;
  contentState.listenerAttached = listenerAttached;
  global[stateKey] = contentState;

  resolveContext().then(async ({ config, settings }) => {
    const tabContext = await getTabContext();
    const checkpoint = await getCheckpointForTab(tabContext);
    if (checkpoint?.runId) activeRunId = checkpoint.runId;
    publishStatus({
      status: statuses.IDLE,
      message: config ? `Ready on ${config.name}.` : 'Unsupported site.',
      siteId: config?.id || null,
      siteName: config?.name || 'Unsupported site',
      phase: 'idle',
      runId: checkpoint?.runId || null,
      current: checkpoint?.currentIndex != null && checkpoint.currentIndex < checkpoint.total
        ? checkpoint.currentIndex + 1
        : (checkpoint?.completedCount || 0),
      total: checkpoint?.total || 0,
      completedCount: checkpoint?.completedCount || 0,
      processedCount: checkpoint?.processedCount || checkpoint?.completedCount || 0,
      successfulCount: checkpoint?.successfulCount || 0,
      failedCount: checkpoint?.failedCount || 0
    });
    const resumed = await attemptAutoResume(config, settings);
    if (!resumed && config && settings.panel?.autoOpenOnSupportedSites) await ensurePanel().open();
  }).catch(error => {
    publishStatus({
      status: statuses.ERROR,
      message: utils.isExtensionContextInvalidatedError?.(error)
        ? 'Prompt Pilot was reloaded while this tab was open. Click the toolbar icon or refresh this tab.'
        : 'Prompt Pilot could not initialize on this tab.',
      lastError: error.message || String(error),
      phase: 'error'
    });
  });
})(globalThis);
