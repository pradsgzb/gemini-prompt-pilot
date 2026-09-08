(function promptPilotPopup(global) {
  'use strict';

  const root = global.PromptPilot;
  const utils = root.Utils;
  const messageTypes = root.MESSAGE_TYPES;
  const repository = new root.SettingsRepository();

  const elements = {};
  let activeTab = null;
  let activeSettings = null;
  let activeCapabilities = null;
  let activeSite = null;
  let activeRunId = null;
  let settingsSaveTimer = null;
  let settingsSaveSequence = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function tabsQuery(query) {
    return new Promise(resolve => chrome.tabs.query(query, tabs => resolve(tabs || [])));
  }

  function sendToActiveTab(message) {
    return new Promise((resolve, reject) => {
      if (!activeTab?.id) {
        reject(new Error('No active tab found.'));
        return;
      }
      chrome.tabs.sendMessage(activeTab.id, message, response => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (response && response.ok === false) reject(new Error(response.error || 'Content script error.'));
        else resolve(response || {});
      });
    });
  }

  function collectElements() {
    Object.assign(elements, {
      siteSummary: $('siteSummary'),
      statusPill: $('statusPill'),
      promptMode: $('promptMode'),
      promptSeparator: $('promptSeparator'),
      separatorWrap: $('separatorWrap'),
      cooldownMs: $('cooldownMs'),
      logLevel: $('logLevel'),
      promptText: $('promptText'),
      promptCount: $('promptCount'),
      newChatWrap: $('newChatWrap'),
      newChatEnabled: $('newChatEnabled'),
      newChatEvery: $('newChatEvery'),
      downloadWrap: $('downloadWrap'),
      downloadEnabled: $('downloadEnabled'),
      generationTimeoutMs: $('generationTimeoutMs'),
      idleSettleMs: $('idleSettleMs'),
      submitTimeoutMs: $('submitTimeoutMs'),
      maxSubmitRetries: $('maxSubmitRetries'),
      retryEnabled: $('retryEnabled'),
      maxPromptRetries: $('maxPromptRetries'),
      reloadTimedOutChat: $('reloadTimedOutChat'),
      runMessage: $('runMessage'),
      progressText: $('progressText'),
      progressFill: $('progressFill'),
      optionsButton: $('optionsButton'),
      stopButton: $('stopButton'),
      startButton: $('startButton'),
      clearLogs: $('clearLogs'),
      logs: $('logs')
    });
  }

  function setFormFromSettings(settings, options) {
    const merged = utils.deepMerge(root.DEFAULT_SETTINGS || {}, settings || {});
    const focused = document.activeElement;
    const preserveFocused = options?.preserveFocused === true;
    const setValue = (element, value) => {
      if (!element || (preserveFocused && focused === element)) return;
      element.value = value;
    };
    const setChecked = (element, value) => {
      if (!element || (preserveFocused && focused === element)) return;
      element.checked = Boolean(value);
    };
    activeSettings = merged;
    setValue(elements.promptMode, merged.promptParsingMode || 'lines');
    setValue(elements.promptSeparator, merged.promptSeparator || '---');
    setValue(elements.cooldownMs, merged.cooldownMs ?? 15000);
    setValue(elements.logLevel, merged.logLevel === 'trace' ? 'verbose' : (merged.logLevel || 'info'));
    setChecked(elements.newChatEnabled, merged.newChat?.enabled);
    setValue(elements.newChatEvery, merged.newChat?.every || 50);
    setChecked(elements.downloadEnabled, merged.download?.enabled);
    setValue(elements.generationTimeoutMs, merged.generationTimeoutMs ?? 300000);
    setValue(elements.idleSettleMs, merged.idleSettleMs ?? 750);
    setValue(elements.submitTimeoutMs, merged.submitTimeoutMs ?? 25000);
    setValue(elements.maxSubmitRetries, merged.maxSubmitRetries ?? 3);
    setChecked(elements.retryEnabled, merged.retry?.enabled === true);
    setValue(elements.maxPromptRetries, merged.retry?.maxPromptRetries ?? 0);
    setChecked(elements.reloadTimedOutChat, merged.recovery?.reloadTimedOutChat !== false);
    updateSeparatorVisibility();
  }

  function settingsFromForm() {
    return {
      logLevel: elements.logLevel.value,
      cooldownMs: Math.max(0, Number(elements.cooldownMs.value || 0)),
      promptParsingMode: elements.promptMode.value,
      promptSeparator: elements.promptSeparator.value || '---',
      generationTimeoutMs: Math.max(1000, Number(elements.generationTimeoutMs.value || 300000)),
      idleSettleMs: Math.max(0, Number(elements.idleSettleMs.value || 0)),
      submitTimeoutMs: Math.max(1000, Number(elements.submitTimeoutMs.value || 25000)),
      maxSubmitRetries: Math.max(1, Number(elements.maxSubmitRetries.value || 3)),
      retry: {
        ...(activeSettings?.retry || {}),
        enabled: Boolean(elements.retryEnabled.checked),
        maxPromptRetries: Math.max(0, Number(elements.maxPromptRetries.value || 0))
      },
      recovery: {
        ...(activeSettings?.recovery || {}),
        enabled: true,
        reloadTimedOutChat: Boolean(elements.reloadTimedOutChat.checked)
      },
      newChat: {
        enabled: Boolean(elements.newChatEnabled.checked),
        every: Math.max(1, Number(elements.newChatEvery.value || 1))
      },
      download: {
        ...(activeSettings?.download || {}),
        enabled: Boolean(elements.downloadEnabled.checked)
      }
    };
  }

  function parsePromptText() {
    return root.PromptParser.parsePrompts(elements.promptText.value, {
      mode: elements.promptMode.value,
      separator: elements.promptSeparator.value || '---'
    });
  }

  function updatePromptCount() {
    const count = parsePromptText().length;
    elements.promptCount.textContent = `${count} prompt${count === 1 ? '' : 's'}`;
  }

  function updateSeparatorVisibility() {
    elements.separatorWrap.classList.toggle('hidden', elements.promptMode.value !== 'separator');
  }

  function updateCapabilityUi(capabilities) {
    activeCapabilities = capabilities || {};
    const hasNewChat = Boolean(activeCapabilities.hasNewChat);
    const hasDownload = Boolean(activeCapabilities.hasDownload && activeCapabilities.hasImageSelector);
    elements.newChatWrap.classList.toggle('hidden', !hasNewChat);
    elements.downloadWrap.classList.toggle('hidden', !hasDownload);
    if (!hasNewChat) elements.newChatEnabled.checked = false;
    if (!hasDownload) elements.downloadEnabled.checked = false;
  }

  function setSiteUi(site, capabilities) {
    activeSite = site;
    const supported = Boolean(capabilities?.supported);
    const siteName = site?.siteName || site?.name || capabilities?.siteName || 'Unsupported site';
    elements.siteSummary.textContent = supported ? `${siteName} detected` : 'Open a configured site to start automation';
    elements.startButton.disabled = !supported;
    updateCapabilityUi(capabilities);
  }

  function appendLog(entry) {
    const div = document.createElement('div');
    div.className = `log-entry ${entry.level || 'info'}`;
    const time = entry.time ? new Date(entry.time).toLocaleTimeString() : new Date().toLocaleTimeString();
    const eventCode = entry.event || entry.meta?.event || '';
    const eventName = eventCode ? ` [${eventCode}]` : '';
    div.textContent = `${time} ${String(entry.level || 'info').toUpperCase()}${eventName} ${entry.message || ''}`;
    elements.logs.prepend(div);
    while (elements.logs.children.length > 80) elements.logs.lastElementChild.remove();
  }

  function updateRunState(state) {
    if (!state) return;
    const status = state.status || 'idle';
    if (state.runId) activeRunId = state.runId;
    elements.statusPill.textContent = status;
    elements.statusPill.className = `pill ${status}`;
    elements.runMessage.textContent = state.message || 'Ready';
    const total = Number(state.total || 0);
    const processed = Math.min(total, Math.max(0, Number(state.processedCount ?? state.completedCount ?? 0)));
    const successful = Math.max(0, Number(state.successfulCount || 0));
    const failed = Math.max(0, Number(state.failedCount || 0));
    elements.progressText.textContent = `${processed}/${total} · ${successful} ok · ${failed} failed`;
    const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    elements.progressFill.style.width = `${percent}%`;

    const busy = ['preparing', 'running', 'cooldown', 'recovering', 'retrying', 'stopping'].includes(status);
    elements.startButton.disabled = busy || !activeCapabilities?.supported;
    elements.stopButton.disabled = !busy;
  }

  async function loadActiveContext() {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    activeTab = tabs[0] || null;
    activeSettings = await repository.getSettings();
    setFormFromSettings(activeSettings);

    try {
      const response = await sendToActiveTab({ type: messageTypes.GET_STATE });
      activeSettings = response.settings || activeSettings;
      setFormFromSettings(activeSettings);
      setSiteUi(response.site, response.capabilities);
      activeRunId = response.logRunId || response.checkpoint?.runId || response.state?.runId || activeRunId;
      if (Array.isArray(response.logs)) {
        elements.logs.textContent = '';
        for (const entry of response.logs.slice(-80)) appendLog(entry);
      }
      updateRunState(response.state);
    } catch (err) {
      const configs = await repository.getSiteConfigs();
      const site = activeTab?.url ? root.SiteResolver.resolveSiteConfig(configs, activeTab.url) : null;
      const capabilities = root.SiteResolver.getCapabilities(site);
      setSiteUi(root.SiteResolver.summarizeConfig(site), capabilities);
      elements.runMessage.textContent = capabilities.supported
        ? 'Refresh the page once after installing/reloading the extension.'
        : 'This URL is not configured yet.';
      appendLog({ level: 'warn', message: err.message });
    }

    updatePromptCount();
  }

  async function saveSettingsFromForm() {
    activeSettings = await repository.saveSettings(settingsFromForm());
    return activeSettings;
  }

  function scheduleSettingsSave(delay) {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    const sequence = ++settingsSaveSequence;
    settingsSaveTimer = setTimeout(async () => {
      settingsSaveTimer = null;
      try {
        const saved = await repository.saveSettings(settingsFromForm());
        if (sequence === settingsSaveSequence) activeSettings = saved;
      } catch (err) {
        if (sequence === settingsSaveSequence) appendLog({ level: 'warn', message: `Could not apply settings: ${err.message}` });
      }
    }, Math.max(0, Number(delay || 0)));
  }

  async function startRun() {
    const prompts = parsePromptText();
    updatePromptCount();
    if (!prompts.length) {
      appendLog({ level: 'warn', message: 'No prompts found.' });
      return;
    }

    const settings = await saveSettingsFromForm();
    updateRunState({ status: 'preparing', message: `Starting ${prompts.length} prompts…`, current: 0, total: prompts.length });
    try {
      const response = await sendToActiveTab({ type: messageTypes.START_RUN, prompts, settings });
      updateRunState(response.state);
      appendLog({ level: 'info', message: `Run accepted: ${prompts.length} prompts.` });
    } catch (err) {
      appendLog({ level: 'error', message: err.message });
      updateRunState({ status: 'error', message: err.message, current: 0, total: prompts.length });
    }
  }

  async function stopRun() {
    try {
      const response = await sendToActiveTab({ type: messageTypes.STOP_RUN });
      updateRunState(response.state);
      appendLog({ level: 'warn', message: 'Stop requested.' });
    } catch (err) {
      appendLog({ level: 'error', message: err.message });
    }
  }

  function bindEvents() {
    elements.promptText.addEventListener('input', updatePromptCount);
    elements.promptMode.addEventListener('change', () => { updateSeparatorVisibility(); updatePromptCount(); scheduleSettingsSave(0); });
    elements.promptSeparator.addEventListener('input', () => { updatePromptCount(); scheduleSettingsSave(100); });

    for (const id of ['cooldownMs', 'logLevel', 'newChatEnabled', 'newChatEvery', 'downloadEnabled', 'generationTimeoutMs', 'idleSettleMs', 'submitTimeoutMs', 'maxSubmitRetries', 'retryEnabled', 'maxPromptRetries', 'reloadTimedOutChat']) {
      const element = elements[id];
      const immediate = element.type === 'checkbox' || element.tagName === 'SELECT';
      element.addEventListener('input', () => scheduleSettingsSave(immediate ? 0 : 100));
      element.addEventListener('change', () => scheduleSettingsSave(0));
    }

    elements.startButton.addEventListener('click', startRun);
    elements.stopButton.addEventListener('click', stopRun);
    elements.optionsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
    elements.clearLogs.addEventListener('click', () => {
      elements.logs.textContent = '';
      if (activeRunId) repository.clearRunLogs(activeRunId).catch(() => {});
    });

    chrome.runtime.onMessage.addListener(message => {
      if (!message || message.type !== messageTypes.STATUS) return;
      if (message.url && activeTab?.url) {
        try {
          if (new URL(message.url).hostname !== new URL(activeTab.url).hostname) return;
        } catch (_) {}
      }
      if (message.event === 'log' && message.entry) appendLog(message.entry);
      if (message.state) updateRunState(message.state);
    });

    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const change = changes?.[root.STORAGE_KEYS.SETTINGS];
      if (!change?.newValue) return;
      setFormFromSettings(change.newValue, { preserveFocused: true });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    collectElements();
    elements.stopButton.disabled = true;
    bindEvents();
    loadActiveContext().catch(err => appendLog({ level: 'error', message: err.message }));
  });
})(globalThis);
