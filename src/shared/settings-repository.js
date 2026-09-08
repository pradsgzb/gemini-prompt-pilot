(function attachPromptPilotSettingsRepository(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const storageKeys = root.STORAGE_KEYS;
  const utils = root.Utils;
  const fallbackMemory = root.__SETTINGS_FALLBACK_MEMORY__ || (root.__SETTINGS_FALLBACK_MEMORY__ = {});
  const fallbackPrefix = '__promptPilot.fallback.';

  function toKeyList(keys) {
    if (Array.isArray(keys)) return keys;
    if (typeof keys === 'string') return [keys];
    if (keys && typeof keys === 'object') return Object.keys(keys);
    return Object.values(storageKeys || {});
  }

  function fallbackStorageKey(key) {
    return `${fallbackPrefix}${key}`;
  }

  function readFallback(keys) {
    const result = {};
    for (const key of toKeyList(keys)) {
      let value = fallbackMemory[key];
      try {
        const raw = global.localStorage?.getItem?.(fallbackStorageKey(key));
        if (raw != null) value = JSON.parse(raw);
      } catch (_) {}
      if (value !== undefined) result[key] = utils.clone(value);
    }
    return result;
  }

  function writeFallback(values) {
    for (const [key, value] of Object.entries(values || {})) {
      fallbackMemory[key] = utils.clone(value);
      try {
        global.localStorage?.setItem?.(fallbackStorageKey(key), JSON.stringify(value));
      } catch (_) {}
    }
  }

  function removeFallback(keys) {
    for (const key of toKeyList(keys)) {
      delete fallbackMemory[key];
      try { global.localStorage?.removeItem?.(fallbackStorageKey(key)); } catch (_) {}
    }
  }

  function chromeGet(keys) {
    return new Promise(resolve => {
      if (!utils.hasUsableExtensionContext() || !global.chrome?.storage?.local?.get) {
        resolve(readFallback(keys));
        return;
      }

      try {
        global.chrome.storage.local.get(keys, result => {
          const errorMessage = utils.getChromeLastErrorMessage();
          if (errorMessage) {
            resolve(readFallback(keys));
            return;
          }
          resolve(result || {});
        });
      } catch (err) {
        resolve(readFallback(keys));
      }
    });
  }

  function chromeSet(values) {
    return new Promise((resolve, reject) => {
      if (!utils.hasUsableExtensionContext() || !global.chrome?.storage?.local?.set) {
        writeFallback(values);
        resolve({ fallback: true });
        return;
      }

      try {
        global.chrome.storage.local.set(values, () => {
          const errorMessage = utils.getChromeLastErrorMessage();
          if (errorMessage) {
            const err = new Error(errorMessage);
            if (utils.isExtensionContextInvalidatedError(err)) {
              writeFallback(values);
              resolve({ fallback: true, error: errorMessage });
            } else {
              reject(err);
            }
            return;
          }
          resolve({ fallback: false });
        });
      } catch (err) {
        if (utils.isExtensionContextInvalidatedError(err)) {
          writeFallback(values);
          resolve({ fallback: true, error: err.message || String(err) });
        } else {
          reject(err);
        }
      }
    });
  }

  function chromeRemove(keys) {
    return new Promise((resolve, reject) => {
      removeFallback(keys);
      if (!utils.hasUsableExtensionContext() || !global.chrome?.storage?.local?.remove) {
        resolve({ fallback: true });
        return;
      }

      try {
        global.chrome.storage.local.remove(keys, () => {
          const errorMessage = utils.getChromeLastErrorMessage();
          if (errorMessage) {
            const err = new Error(errorMessage);
            if (utils.isExtensionContextInvalidatedError(err)) resolve({ fallback: true, error: errorMessage });
            else reject(err);
            return;
          }
          resolve({ fallback: false });
        });
      } catch (err) {
        if (utils.isExtensionContextInvalidatedError(err)) resolve({ fallback: true, error: err.message || String(err) });
        else reject(err);
      }
    });
  }

  function activeRunKey(tabId) {
    return `${storageKeys.ACTIVE_RUN_PREFIX}${String(tabId ?? 'unknown')}`;
  }

  function runLogKey(runId) {
    return `${storageKeys.RUN_LOG_PREFIX}${String(runId || 'unknown')}`;
  }

  function serializedBytes(value) {
    let serialized = '';
    try { serialized = JSON.stringify(value); }
    catch (_) { serialized = String(value ?? ''); }
    try { return new TextEncoder().encode(serialized).byteLength; }
    catch (_) { return serialized.length * 2; }
  }

  function trimRunLogs(entries, maxEntries, maxBytes) {
    const entryLimit = Math.max(100, Number(maxEntries || 2000));
    const byteLimit = Math.max(100000, Number(maxBytes || 1500000));
    const candidates = (Array.isArray(entries) ? entries : []).slice(-entryLimit);
    const selected = [];
    let bytes = 2; // JSON array brackets.

    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const entry = candidates[index];
      const entryBytes = serializedBytes(entry) + (selected.length ? 1 : 0);
      if (selected.length && bytes + entryBytes > byteLimit) break;
      selected.push(entry);
      bytes += entryBytes;
      if (bytes >= byteLimit) break;
    }

    selected.reverse();
    return { entries: selected, bytes: serializedBytes(selected) };
  }

  function uniqueArray(values) {
    return Array.from(new Set((values || []).filter(value => value != null)));
  }

  function mergeSelectorObjects(defaultSelectors, storedSelectors) {
    const output = utils.deepMerge(defaultSelectors || {}, storedSelectors || {});
    const keys = new Set([
      ...Object.keys(defaultSelectors || {}),
      ...Object.keys(storedSelectors || {})
    ]);
    for (const key of keys) {
      const defaults = defaultSelectors?.[key];
      const stored = storedSelectors?.[key];
      if (Array.isArray(defaults) || Array.isArray(stored)) {
        output[key] = uniqueArray([...(defaults || []), ...(stored || [])]);
      }
    }
    return output;
  }

  function mergeSiteConfigs(defaultConfigs, storedConfigs) {
    const defaults = Array.isArray(defaultConfigs) ? defaultConfigs : [];
    const stored = Array.isArray(storedConfigs) ? storedConfigs : [];
    const storedById = new Map(stored.filter(config => config?.id).map(config => [config.id, config]));
    const merged = defaults.map(defaultConfig => {
      const storedConfig = storedById.get(defaultConfig.id);
      if (!storedConfig) return utils.clone(defaultConfig);
      const output = utils.deepMerge(defaultConfig, storedConfig);
      output.selectors = mergeSelectorObjects(defaultConfig.selectors, storedConfig.selectors);
      return output;
    });
    for (const storedConfig of stored) {
      if (storedConfig?.id && !defaults.some(defaultConfig => defaultConfig.id === storedConfig.id)) {
        merged.push(utils.clone(storedConfig));
      }
    }
    return merged;
  }

  function migrateStoredSettings(storedSettings) {
    const stored = utils.clone(storedSettings || {});
    const schemaVersion = Math.max(1, Number(stored.settingsSchemaVersion || 1));
    let changed = false;

    if (schemaVersion < 2) {
      // v1 treated zero retries as unlimited and could therefore remain on one failed prompt
      // forever. v2 is deliberately fail-soft: no retries unless the user explicitly requests
      // a positive retry count, and every terminal failure advances to the next queue item.
      const storedRetryCount = Math.max(0, Number(stored.retry?.maxPromptRetries || 0));
      stored.retry = utils.deepMerge(stored.retry || {}, storedRetryCount > 0
        ? {
            enabled: stored.retry?.enabled !== false,
            maxPromptRetries: storedRetryCount
          }
        : {
            enabled: false,
            maxPromptRetries: 0
          });
      stored.failureHandling = utils.deepMerge(root.DEFAULT_SETTINGS?.failureHandling || {}, stored.failureHandling || {});
      if (stored.idleSettleMs == null || Number(stored.idleSettleMs) === 3500) stored.idleSettleMs = 750;
      stored.settingsSchemaVersion = 2;
      changed = true;
    }

    return {
      settings: utils.deepMerge(root.DEFAULT_SETTINGS, stored),
      changed
    };
  }

  class SettingsRepository {
    async getSettings() {
      const result = await chromeGet(storageKeys.SETTINGS);
      const migration = migrateStoredSettings(result[storageKeys.SETTINGS] || {});
      if (migration.changed) {
        try { await chromeSet({ [storageKeys.SETTINGS]: migration.settings }); } catch (_) {}
      }
      return migration.settings;
    }

    async saveSettings(settingsPatch) {
      const current = await this.getSettings();
      const merged = utils.deepMerge(current, settingsPatch || {});
      await chromeSet({ [storageKeys.SETTINGS]: merged });
      return merged;
    }

    async resetSettings() {
      await chromeRemove(storageKeys.SETTINGS);
      return this.getSettings();
    }

    async getSiteConfigs() {
      const result = await chromeGet(storageKeys.SITE_CONFIGS);
      const configs = result[storageKeys.SITE_CONFIGS];
      if (Array.isArray(configs) && configs.length > 0) {
        return mergeSiteConfigs(root.DEFAULT_SITE_CONFIGS || [], configs);
      }
      return utils.clone(root.DEFAULT_SITE_CONFIGS || []);
    }

    async saveSiteConfigs(siteConfigs) {
      if (!Array.isArray(siteConfigs)) throw new Error('Site configs must be an array.');
      for (const config of siteConfigs) {
        if (!config || !config.id || !config.name || !config.selectors) {
          throw new Error('Every site config needs id, name and selectors.');
        }
      }
      await chromeSet({ [storageKeys.SITE_CONFIGS]: utils.clone(siteConfigs) });
      return this.getSiteConfigs();
    }

    async resetSiteConfigs() {
      await chromeRemove(storageKeys.SITE_CONFIGS);
      return this.getSiteConfigs();
    }

    async getRunState() {
      const result = await chromeGet(storageKeys.RUN_STATE);
      return result[storageKeys.RUN_STATE] || null;
    }

    async saveRunState(runState) {
      const result = await chromeSet({ [storageKeys.RUN_STATE]: runState || null });
      if (result?.fallback) {
        const error = new Error('Chrome extension storage is unavailable, so the durable run checkpoint could not be committed.');
        error.code = 'DURABLE_STORAGE_UNAVAILABLE';
        throw error;
      }
      return runState || null;
    }

    async clearRunState() {
      await chromeRemove(storageKeys.RUN_STATE);
      return null;
    }

    async getActiveRun(tabId) {
      const key = activeRunKey(tabId);
      const result = await chromeGet(key);
      return result[key] || null;
    }

    async saveActiveRun(tabId, runState) {
      const key = activeRunKey(tabId);
      const result = await chromeSet({ [key]: runState || null });
      if (result?.fallback) {
        const error = new Error('Chrome extension storage is unavailable, so the durable per-tab run checkpoint could not be committed.');
        error.code = 'DURABLE_STORAGE_UNAVAILABLE';
        error.meta = { tabId: tabId ?? null, storageKey: key };
        throw error;
      }
      return runState || null;
    }

    async clearActiveRun(tabId) {
      await chromeRemove(activeRunKey(tabId));
      return true;
    }

    async getRunLogs(runId) {
      const key = runLogKey(runId);
      const result = await chromeGet(key);
      return Array.isArray(result[key]) ? result[key] : [];
    }

    async getRunLogIndex() {
      const result = await chromeGet(storageKeys.RUN_LOG_INDEX);
      return Array.isArray(result[storageKeys.RUN_LOG_INDEX]) ? result[storageKeys.RUN_LOG_INDEX] : [];
    }

    async updateRunLogIndex(runId, stats, maxPersistedRuns) {
      const runLimit = Math.max(1, Number(maxPersistedRuns || 8));
      const now = new Date().toISOString();
      const index = (await this.getRunLogIndex())
        .filter(item => item?.runId && item.runId !== runId)
        .map(item => ({ ...item }));
      const nextSequence = index.reduce((maximum, item) => Math.max(maximum, Number(item.sequence || 0)), 0) + 1;
      index.push({
        runId,
        key: runLogKey(runId),
        updatedAt: now,
        sequence: nextSequence,
        entries: Number(stats?.entries || 0),
        bytes: Number(stats?.bytes || 0)
      });
      index.sort((left, right) => (
        Number(right.sequence || 0) - Number(left.sequence || 0)
        || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
      ));
      const retained = index.slice(0, runLimit);
      const removed = index.slice(runLimit);
      if (removed.length) await chromeRemove(removed.map(item => item.key || runLogKey(item.runId)));
      await chromeSet({ [storageKeys.RUN_LOG_INDEX]: retained });
      return retained;
    }

    async appendRunLogs(runId, entries, maxEntries, maxBytes, maxPersistedRuns) {
      const additions = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
      if (!additions.length) return this.getRunLogs(runId);
      const key = runLogKey(runId);
      const current = await this.getRunLogs(runId);
      const trimmed = trimRunLogs(
        [...current, ...utils.clone(additions)],
        maxEntries,
        maxBytes
      );
      await chromeSet({ [key]: trimmed.entries });
      await this.updateRunLogIndex(runId, {
        entries: trimmed.entries.length,
        bytes: trimmed.bytes
      }, maxPersistedRuns);
      return trimmed.entries;
    }

    async clearRunLogs(runId) {
      await chromeRemove(runLogKey(runId));
      const index = (await this.getRunLogIndex()).filter(item => item?.runId !== runId);
      await chromeSet({ [storageKeys.RUN_LOG_INDEX]: index });
      return [];
    }
  }

  root.SettingsRepository = SettingsRepository;
})(globalThis);
