(function promptPilotOptions(global) {
  'use strict';

  const root = global.PromptPilot;
  const repository = new root.SettingsRepository();
  const utils = root.Utils;
  const elements = {};
  let settingsSaveTimer = null;
  let settingsSaveSequence = 0;

  function $(id) { return document.getElementById(id); }

  function collectElements() {
    Object.assign(elements, {
      logLevel: $('logLevel'),
      cooldownMs: $('cooldownMs'),
      generationTimeoutMs: $('generationTimeoutMs'),
      idleSettleMs: $('idleSettleMs'),
      submitTimeoutMs: $('submitTimeoutMs'),
      maxSubmitRetries: $('maxSubmitRetries'),
      loggingMaxEntries: $('loggingMaxEntries'),
      verbosePollIntervalMs: $('verbosePollIntervalMs'),
      resumeMaxAgeHours: $('resumeMaxAgeHours'),
      autoResume: $('autoResume'),
      persistLogs: $('persistLogs'),
      includeFullPromptText: $('includeFullPromptText'),
      retryEnabled: $('retryEnabled'),
      maxPromptRetries: $('maxPromptRetries'),
      retryInitialBackoffMs: $('retryInitialBackoffMs'),
      retryMaxBackoffMs: $('retryMaxBackoffMs'),
      startRetryInNewChat: $('startRetryInNewChat'),
      reloadTimedOutChat: $('reloadTimedOutChat'),
      maxReloadCyclesPerAttempt: $('maxReloadCyclesPerAttempt'),
      reopenTimeoutMs: $('reopenTimeoutMs'),
      postReloadObservationMs: $('postReloadObservationMs'),
      resumeObservationMs: $('resumeObservationMs'),
      submitWithEnterFallback: $('submitWithEnterFallback'),
      waitForImageAfterSubmit: $('waitForImageAfterSubmit'),
      adaptiveDomSearch: $('adaptiveDomSearch'),
      panelWidth: $('panelWidth'),
      panelAutoOpenOnSupportedSites: $('panelAutoOpenOnSupportedSites'),
      promptParsingMode: $('promptParsingMode'),
      promptSeparator: $('promptSeparator'),
      downloadQuality: $('downloadQuality'),
      downloadFolder: $('downloadFolder'),
      exifMaxChars: $('exifMaxChars'),
      filenameTemplate: $('filenameTemplate'),
      captureTimeoutMs: $('captureTimeoutMs'),
      downloadOperationTimeoutMs: $('downloadOperationTimeoutMs'),
      clickNativeButton: $('clickNativeButton'),
      captureNativeDownload: $('captureNativeDownload'),
      fallbackToPreviewImage: $('fallbackToPreviewImage'),
      geminiCreateImage: $('geminiCreateImage'),
      geminiEnsurePro: $('geminiEnsurePro'),
      siteConfigJson: $('siteConfigJson'),
      validateConfig: $('validateConfig'),
      resetConfig: $('resetConfig'),
      resetSettings: $('resetSettings'),
      saveSettings: $('saveSettings'),
      statusText: $('statusText')
    });
  }

  function setStatus(text, kind) {
    elements.statusText.textContent = text;
    elements.statusText.style.color = kind === 'error' ? '#b91c1c' : kind === 'success' ? '#047857' : '#64748b';
  }

  function fillSettings(settings) {
    elements.logLevel.value = settings.logLevel === 'trace' ? 'verbose' : (settings.logLevel || 'info');
    elements.cooldownMs.value = settings.cooldownMs ?? 15000;
    elements.generationTimeoutMs.value = settings.generationTimeoutMs ?? 300000;
    elements.idleSettleMs.value = settings.idleSettleMs ?? 750;
    elements.submitTimeoutMs.value = settings.submitTimeoutMs ?? 25000;
    elements.maxSubmitRetries.value = settings.maxSubmitRetries ?? 3;
    elements.loggingMaxEntries.value = settings.logging?.maxEntries ?? 2000;
    elements.verbosePollIntervalMs.value = settings.logging?.verbosePollIntervalMs ?? 2000;
    elements.resumeMaxAgeHours.value = settings.resumeMaxAgeHours ?? 24;
    elements.autoResume.checked = settings.autoResume !== false;
    elements.persistLogs.checked = settings.logging?.persist !== false;
    elements.includeFullPromptText.checked = Boolean(settings.logging?.includeFullPromptText);
    elements.retryEnabled.checked = settings.retry?.enabled === true;
    elements.maxPromptRetries.value = settings.retry?.maxPromptRetries ?? 0;
    elements.retryInitialBackoffMs.value = settings.retry?.initialBackoffMs ?? 5000;
    elements.retryMaxBackoffMs.value = settings.retry?.maxBackoffMs ?? 60000;
    elements.startRetryInNewChat.checked = settings.retry?.startRetryInNewChat !== false;
    elements.reloadTimedOutChat.checked = settings.recovery?.reloadTimedOutChat !== false;
    elements.maxReloadCyclesPerAttempt.value = settings.recovery?.maxReloadCyclesPerAttempt ?? 2;
    elements.reopenTimeoutMs.value = settings.recovery?.reopenTimeoutMs ?? 30000;
    elements.postReloadObservationMs.value = settings.recovery?.postReloadObservationMs ?? 45000;
    elements.resumeObservationMs.value = settings.recovery?.resumeObservationMs ?? 30000;
    elements.submitWithEnterFallback.checked = Boolean(settings.submitWithEnterFallback);
    elements.waitForImageAfterSubmit.checked = Boolean(settings.waitForImageAfterSubmit);
    elements.adaptiveDomSearch.checked = settings.adaptiveDomSearch !== false;
    elements.panelWidth.value = settings.panel?.width || 448;
    elements.panelAutoOpenOnSupportedSites.checked = Boolean(settings.panel?.autoOpenOnSupportedSites);
    elements.promptParsingMode.value = settings.promptParsingMode || 'lines';
    elements.promptSeparator.value = settings.promptSeparator || '---';
    elements.downloadQuality.value = settings.download?.quality ?? 0.92;
    elements.downloadFolder.value = settings.download?.folder || 'PromptPilot';
    elements.exifMaxChars.value = settings.download?.exifMaxChars || 10000;
    elements.filenameTemplate.value = settings.download?.filenameTemplate || '{index}-{slug}.jpg';
    elements.captureTimeoutMs.value = settings.download?.captureTimeoutMs || 25000;
    elements.downloadOperationTimeoutMs.value = settings.download?.operationTimeoutMs || 90000;
    elements.clickNativeButton.checked = settings.download?.clickNativeButton !== false;
    elements.captureNativeDownload.checked = settings.download?.captureNativeDownload !== false;
    elements.fallbackToPreviewImage.checked = Boolean(settings.download?.fallbackToPreviewImage);
    elements.geminiCreateImage.checked = Boolean(settings.siteOptions?.gemini?.enableCreateImageMode);
    elements.geminiEnsurePro.checked = Boolean(settings.siteOptions?.gemini?.ensureProMode);
  }

  function settingsFromForm() {
    return {
      logLevel: elements.logLevel.value,
      cooldownMs: Math.max(0, Number(elements.cooldownMs.value || 0)),
      generationTimeoutMs: Math.max(1000, Number(elements.generationTimeoutMs.value || 300000)),
      idleSettleMs: Math.max(0, Number(elements.idleSettleMs.value || 0)),
      submitTimeoutMs: Math.max(1000, Number(elements.submitTimeoutMs.value || 25000)),
      maxSubmitRetries: Math.max(1, Number(elements.maxSubmitRetries.value || 3)),
      autoResume: Boolean(elements.autoResume.checked),
      resumeMaxAgeHours: Math.min(168, Math.max(1, Number(elements.resumeMaxAgeHours.value || 24))),
      logging: {
        persist: Boolean(elements.persistLogs.checked),
        maxEntries: Math.min(5000, Math.max(100, Number(elements.loggingMaxEntries.value || 2000))),
        verbosePollIntervalMs: Math.max(250, Number(elements.verbosePollIntervalMs.value || 2000)),
        includeFullPromptText: Boolean(elements.includeFullPromptText.checked)
      },
      retry: {
        enabled: Boolean(elements.retryEnabled.checked),
        maxPromptRetries: Math.max(0, Number(elements.maxPromptRetries.value || 0)),
        initialBackoffMs: Math.max(0, Number(elements.retryInitialBackoffMs.value || 0)),
        maxBackoffMs: Math.max(0, Number(elements.retryMaxBackoffMs.value || 0)),
        startRetryInNewChat: Boolean(elements.startRetryInNewChat.checked)
      },
      recovery: {
        enabled: true,
        reloadTimedOutChat: Boolean(elements.reloadTimedOutChat.checked),
        maxReloadCyclesPerAttempt: Math.max(1, Number(elements.maxReloadCyclesPerAttempt.value || 0)),
        reopenTimeoutMs: Math.max(5000, Number(elements.reopenTimeoutMs.value || 30000)),
        postReloadObservationMs: Math.max(5000, Number(elements.postReloadObservationMs.value || 45000)),
        resumeObservationMs: Math.max(5000, Number(elements.resumeObservationMs.value || 30000))
      },
      submitWithEnterFallback: Boolean(elements.submitWithEnterFallback.checked),
      waitForImageAfterSubmit: Boolean(elements.waitForImageAfterSubmit.checked),
      adaptiveDomSearch: Boolean(elements.adaptiveDomSearch.checked),
      panel: {
        dockSide: 'right',
        width: Math.min(760, Math.max(320, Number(elements.panelWidth.value || 448))),
        autoOpenOnSupportedSites: Boolean(elements.panelAutoOpenOnSupportedSites.checked)
      },
      promptParsingMode: elements.promptParsingMode.value,
      promptSeparator: elements.promptSeparator.value || '---',
      download: {
        quality: Math.min(1, Math.max(0.1, Number(elements.downloadQuality.value || 0.92))),
        folder: elements.downloadFolder.value || 'PromptPilot',
        exifMaxChars: Math.min(12000, Math.max(256, Number(elements.exifMaxChars.value || 10000))),
        filenameTemplate: elements.filenameTemplate.value || '{index}-{slug}.jpg',
        captureTimeoutMs: Math.max(5000, Number(elements.captureTimeoutMs.value || 25000)),
        operationTimeoutMs: Math.max(10000, Number(elements.downloadOperationTimeoutMs.value || 90000)),
        clickNativeButton: Boolean(elements.clickNativeButton.checked),
        captureNativeDownload: Boolean(elements.captureNativeDownload.checked),
        fallbackToPreviewImage: Boolean(elements.fallbackToPreviewImage.checked)
      },
      siteOptions: {
        gemini: {
          enableCreateImageMode: Boolean(elements.geminiCreateImage.checked),
          ensureProMode: Boolean(elements.geminiEnsurePro.checked)
        }
      }
    };
  }

  function parseSiteConfigs() {
    let configs;
    try {
      configs = JSON.parse(elements.siteConfigJson.value);
    } catch (err) {
      throw new Error(`Invalid JSON: ${err.message}`);
    }
    if (!Array.isArray(configs)) throw new Error('Site selector configuration must be a JSON array.');
    for (const config of configs) {
      if (!config.id || !config.name) throw new Error('Every config needs id and name.');
      if (!config.selectors?.input?.length) throw new Error(`${config.id} needs selectors.input.`);
      if (!config.selectors?.submit?.length && !config.selectors?.submitTextPatterns?.length) throw new Error(`${config.id} needs submit selectors or submitTextPatterns.`);
    }
    return configs;
  }

  async function load() {
    const settings = await repository.getSettings();
    const configs = await repository.getSiteConfigs();
    fillSettings(settings);
    elements.siteConfigJson.value = JSON.stringify(configs, null, 2);
    setStatus('Ready');
  }

  async function saveAll() {
    try {
      const settings = settingsFromForm();
      const configs = parseSiteConfigs();
      await repository.saveSettings(settings);
      await repository.saveSiteConfigs(configs);
      setStatus('Settings saved.', 'success');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  function scheduleLiveSettingsSave(delay) {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    const sequence = ++settingsSaveSequence;
    settingsSaveTimer = setTimeout(async () => {
      settingsSaveTimer = null;
      try {
        await repository.saveSettings(settingsFromForm());
        if (sequence === settingsSaveSequence) setStatus('Settings applied immediately to active tabs.', 'success');
      } catch (err) {
        if (sequence === settingsSaveSequence) setStatus(err.message, 'error');
      }
    }, Math.max(0, Number(delay || 0)));
  }

  async function resetSettings() {
    const settings = await repository.resetSettings();
    fillSettings(settings);
    setStatus('Settings reset to defaults.', 'success');
  }

  async function resetConfig() {
    const configs = await repository.resetSiteConfigs();
    elements.siteConfigJson.value = JSON.stringify(configs, null, 2);
    setStatus('Site selector configuration restored to defaults.', 'success');
  }

  function bind() {
    elements.saveSettings.addEventListener('click', saveAll);
    elements.resetSettings.addEventListener('click', () => resetSettings().catch(err => setStatus(err.message, 'error')));
    elements.resetConfig.addEventListener('click', () => resetConfig().catch(err => setStatus(err.message, 'error')));
    elements.validateConfig.addEventListener('click', () => {
      try {
        const configs = parseSiteConfigs();
        setStatus(`Configuration is valid. ${configs.length} site configs found.`, 'success');
      } catch (err) {
        setStatus(err.message, 'error');
      }
    });

    elements.siteConfigJson.addEventListener('input', () => setStatus('Unsaved selector configuration changes.'));

    for (const element of document.querySelectorAll('input, select')) {
      const immediate = element.type === 'checkbox' || element.tagName === 'SELECT';
      element.addEventListener('input', () => {
        setStatus('Applying settings…');
        scheduleLiveSettingsSave(immediate ? 0 : 150);
      });
      element.addEventListener('change', () => {
        setStatus('Applying settings…');
        scheduleLiveSettingsSave(0);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    collectElements();
    bind();
    load().catch(err => setStatus(err.message, 'error'));
  });
})(globalThis);
