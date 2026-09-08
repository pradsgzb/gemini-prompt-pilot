/* global importScripts, chrome */
importScripts(
  '/src/shared/constants.js',
  '/src/shared/default-settings.js',
  '/src/shared/site-configs.js',
  '/src/shared/utils.js',
  '/src/shared/logger.js',
  '/src/shared/settings-repository.js'
);

(function promptPilotServiceWorker(global) {
  'use strict';

  const root = global.PromptPilot;
  const messageTypes = root.MESSAGE_TYPES;
  const logger = new root.Logger('PromptPilot:ServiceWorker', 'info');
  const repository = new root.SettingsRepository();
  const nativeDownloadCaptureRequests = new Map();

  const CONTENT_SCRIPT_FILES = Object.freeze([
    'src/shared/constants.js',
    'src/shared/default-settings.js',
    'src/shared/site-configs.js',
    'src/shared/utils.js',
    'src/shared/logger.js',
    'src/shared/settings-repository.js',
    'src/content/dom.js',
    'src/content/prompt-parser.js',
    'src/content/site-resolver.js',
    'src/content/image-converter.js',
    'src/content/run-checkpoint.js',
    'src/content/generation-monitor.js',
    'src/content/navigation-recovery.js',
    'src/content/automation-runner.js',
    'src/content/page-panel.js',
    'src/content/content-main.js'
  ]);

  const SUPPORTED_URL_PATTERNS = Object.freeze([
    'https://gemini.google.com/*',
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://seaart.ai/*',
    'https://www.seaart.ai/*',
    'https://perplexity.ai/*',
    'https://www.perplexity.ai/*'
  ]);

  function downloadDataUrl(dataUrl, filename, saveAs = false, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, isError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (isError) reject(value);
        else resolve(value);
      };
      const timeoutId = setTimeout(() => finish(new Error(`Chrome download request timed out after ${timeoutMs} ms.`), true), timeoutMs);
      chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: Boolean(saveAs),
        conflictAction: 'uniquify'
      }, downloadId => {
        const error = chrome.runtime.lastError;
        if (error) finish(new Error(error.message), true);
        else finish(downloadId, false);
      });
    });
  }

  async function fetchImageAsDataUrl(url, timeoutMs = 45000) {
    if (!url || !/^https?:/i.test(url)) throw new Error('Service worker can only fetch http(s) image URLs.');
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(5000, Number(timeoutMs || 45000)));
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Image fetch failed with HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const bytes = new Uint8Array(await response.arrayBuffer());
      return root.Utils.bytesToDataUrl(bytes, contentType);
    } catch (error) {
      if (timedOut) throw new Error(`Service-worker image fetch timed out after ${timeoutMs} ms.`);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }


  function navigateSenderTab(sender, targetUrl) {
    return new Promise((resolve, reject) => {
      const tabId = sender?.tab?.id;
      const currentUrl = sender?.tab?.url || '';
      if (!tabId) {
        reject(new Error('Could not identify the requesting tab for navigation recovery.'));
        return;
      }
      let target;
      let current;
      try {
        target = new URL(targetUrl);
        current = new URL(currentUrl);
      } catch (_) {
        reject(new Error('Invalid recovery navigation URL.'));
        return;
      }
      if (!/^https:$/.test(target.protocol) || target.origin !== current.origin) {
        reject(new Error('Recovery navigation is restricted to the current supported site origin.'));
        return;
      }
      try {
        chrome.tabs.update(tabId, { url: target.href }, tab => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve({ tabId, url: tab?.url || target.href });
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function openOptionsPage() {
    return new Promise(resolve => {
      try { chrome.runtime.openOptionsPage(() => resolve(true)); }
      catch (_) { resolve(false); }
    });
  }

  function sendMessageToTab(tabId, message) {
    return new Promise(resolve => {
      if (!tabId) {
        resolve({ ok: false, error: 'No active tab id.' });
        return;
      }
      try {
        chrome.tabs.sendMessage(tabId, message, response => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: error.message });
          else resolve({ ok: true, response });
        });
      } catch (err) {
        resolve({ ok: false, error: err.message || String(err) });
      }
    });
  }

  function executeScriptFile(tabId, file) {
    return new Promise((resolve, reject) => {
      try {
        chrome.scripting.executeScript({
          target: { tabId },
          files: [file]
        }, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(true);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function executeScriptFunction(tabId, func, args) {
    return new Promise((resolve, reject) => {
      try {
        chrome.scripting.executeScript({
          target: { tabId },
          func,
          args: args || []
        }, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(true);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function resetExistingContentScript(tabId) {
    await executeScriptFunction(tabId, (stateKey, panelHostId) => {
      try {
        const existing = globalThis[stateKey];
        if (existing && typeof existing.cleanup === 'function') existing.cleanup('programmatic reinjection');
      } catch (_) {}
      try { document.getElementById(panelHostId)?.remove(); } catch (_) {}
      try { delete globalThis[stateKey]; } catch (_) { try { globalThis[stateKey] = null; } catch (__) {} }
    }, ['__PROMPT_PILOT_CONTENT_MAIN_STATE__', '__prompt_pilot_page_panel__']);
  }

  async function injectContentScripts(tabId) {
    await resetExistingContentScript(tabId).catch(() => {});
    for (const file of CONTENT_SCRIPT_FILES) {
      await executeScriptFile(tabId, file);
    }
    await root.Utils.sleep(150);
    return true;
  }

  function isInjectableUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  function clearActionBadge(tabId) {
    try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (_) {}
  }

  function showTemporaryActionError(tabId, title) {
    try { chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }); } catch (_) {}
    try { chrome.action.setBadgeText({ tabId, text: '!' }); } catch (_) {}
    try { chrome.action.setTitle({ tabId, title: title || 'Prompt Pilot could not open on this page.' }); } catch (_) {}
    setTimeout(() => {
      try { chrome.action.setBadgeText({ tabId, text: '' }); } catch (_) {}
      try { chrome.action.setTitle({ tabId, title: 'Prompt Pilot - open docked panel' }); } catch (_) {}
    }, 5000);
  }

  function isHealthyContentPing(ping) {
    return Boolean(
      ping?.ok &&
      ping.response?.ok !== false &&
      ping.response?.pong &&
      ping.response?.version === root.VERSION &&
      ping.response?.contextHealthy !== false
    );
  }

  async function ensureContentScriptReady(tabId) {
    const ping = await sendMessageToTab(tabId, { type: messageTypes.PING });
    if (isHealthyContentPing(ping)) return true;

    const reason = ping.ok
      ? `version/context mismatch (${ping.response?.version || 'unknown'} → ${root.VERSION})`
      : (ping.error || 'not connected');
    logger.info(`Content script not ready; injecting current Prompt Pilot files. ${reason}`.trim());
    await injectContentScripts(tabId);

    const secondPing = await sendMessageToTab(tabId, { type: messageTypes.PING });
    if (isHealthyContentPing(secondPing)) return true;
    throw new Error(secondPing.error || secondPing.response?.error || 'Prompt Pilot content script did not respond after injection.');
  }

  async function handleActionClick(tab) {
    if (!tab?.id) return;

    if (!isInjectableUrl(tab.url)) {
      showTemporaryActionError(tab.id, 'Prompt Pilot can run on normal http/https web pages. Open Gemini, ChatGPT, SeaArt, Perplexity, or another supported site.');
      await openOptionsPage();
      return;
    }

    try {
      clearActionBadge(tab.id);
      await ensureContentScriptReady(tab.id);
      const result = await sendMessageToTab(tab.id, { type: messageTypes.SHOW_PANEL });
      if (!result.ok || result.response?.ok === false) {
        throw new Error(result.error || result.response?.error || 'The panel did not respond.');
      }
    } catch (err) {
      logger.warn(`Could not open docked panel: ${err.message}`);
      showTemporaryActionError(tab.id, `Prompt Pilot could not open here: ${err.message}`);
    }
  }

  function cleanExpiredCaptures() {
    const now = Date.now();
    for (const [token, request] of nativeDownloadCaptureRequests.entries()) {
      if (request.expiresAt <= now) nativeDownloadCaptureRequests.delete(token);
    }
  }

  function armNativeDownloadCapture(message, sender) {
    const token = message.token;
    if (!token) throw new Error('Missing native download capture token.');
    const timeoutMs = Math.max(5000, Number(message.timeoutMs || 25000));
    const request = {
      token,
      tabId: sender?.tab?.id || null,
      startedAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
      // Reliability build: never cancel the browser's native download. The EXIF JPEG,
      // when requested, is saved as an additional file instead of replacing it.
      cancelOriginal: false,
      allowUnknown: message.allowUnknown !== false
    };
    nativeDownloadCaptureRequests.set(token, request);
    setTimeout(cleanExpiredCaptures, timeoutMs + 1000);
    return { armed: true, token };
  }

  function disarmNativeDownloadCapture(token) {
    if (!token) return { disarmed: false };
    return { disarmed: nativeDownloadCaptureRequests.delete(token) };
  }

  function looksLikeImageDownload(item, request) {
    const url = String(item.finalUrl || item.url || '');
    const filename = String(item.filename || '');
    const mime = String(item.mime || '');
    if (/^blob:/i.test(url) || /^data:image\//i.test(url)) return true;
    if (/^image\//i.test(mime)) return true;
    if (/\.(png|jpe?g|webp|avif|gif)([?#].*)?$/i.test(url)) return true;
    if (/\.(png|jpe?g|webp|avif|gif)$/i.test(filename)) return true;
    return Boolean(request.allowUnknown);
  }

  function findCaptureRequestForDownload(item) {
    cleanExpiredCaptures();
    const now = Date.now();
    const requests = Array.from(nativeDownloadCaptureRequests.values())
      .filter(request => request.startedAt <= now && request.expiresAt > now)
      .filter(request => looksLikeImageDownload(item, request))
      .sort((a, b) => b.startedAt - a.startedAt);
    return requests[0] || null;
  }

  async function notifyNativeDownloadCaptured(item, request) {
    nativeDownloadCaptureRequests.delete(request.token);
    const payload = {
      id: item.id,
      url: item.url || '',
      finalUrl: item.finalUrl || item.url || '',
      mime: item.mime || '',
      filename: item.filename || '',
      fileSize: item.fileSize || item.totalBytes || 0,
      startTime: item.startTime || new Date().toISOString()
    };

    await sendMessageToTab(request.tabId, {
      type: messageTypes.NATIVE_DOWNLOAD_CAPTURED,
      token: request.token,
      item: payload,
      canceledOriginal: request.cancelOriginal
    });
  }

  async function handleMessage(message, sender) {
    if (!message || !message.type) return null;

    switch (message.type) {
      case messageTypes.DOWNLOAD_DATA_URL: {
        if (!message.dataUrl || !message.filename) throw new Error('Missing dataUrl or filename for download.');
        const downloadId = await downloadDataUrl(message.dataUrl, message.filename, message.saveAs, 30000);
        return { downloadId };
      }
      case messageTypes.FETCH_IMAGE_AS_DATA_URL: {
        const dataUrl = await fetchImageAsDataUrl(message.url);
        return { dataUrl };
      }
      case messageTypes.ARM_NATIVE_DOWNLOAD_CAPTURE:
        return armNativeDownloadCapture(message, sender);
      case messageTypes.DISARM_NATIVE_DOWNLOAD_CAPTURE:
        return disarmNativeDownloadCapture(message.token);
      case messageTypes.GET_TAB_CONTEXT:
        return {
          tabId: sender?.tab?.id ?? null,
          windowId: sender?.tab?.windowId ?? null,
          url: sender?.tab?.url || sender?.url || ''
        };
      case messageTypes.NAVIGATE_TAB:
        return navigateSenderTab(sender, message.url);
      case messageTypes.OPEN_OPTIONS: {
        const opened = await openOptionsPage();
        return { opened };
      }
      case messageTypes.PING:
        return { pong: true, version: root.VERSION };
      default:
        return null;
    }
  }

  function querySupportedTabs() {
    return new Promise(resolve => {
      try {
        chrome.tabs.query({ url: SUPPORTED_URL_PATTERNS }, tabs => {
          const error = chrome.runtime.lastError;
          if (error) resolve([]);
          else resolve(tabs || []);
        });
      } catch (_) {
        resolve([]);
      }
    });
  }

  async function refreshSupportedTabsAfterInstall() {
    const tabs = await querySupportedTabs();
    const uniqueTabs = Array.from(new Map(tabs.filter(tab => tab?.id && isInjectableUrl(tab.url)).map(tab => [tab.id, tab])).values());
    for (const tab of uniqueTabs) {
      try {
        await injectContentScripts(tab.id);
      } catch (err) {
        logger.debug?.(`Could not refresh Prompt Pilot content script on tab ${tab.id}: ${err.message}`);
      }
    }
  }

  chrome.runtime.onInstalled.addListener(() => {
    repository.saveSettings({}).catch(err => logger.warn(`Could not initialize settings: ${err.message}`));
    refreshSupportedTabsAfterInstall().catch(err => logger.warn(`Could not refresh supported tabs: ${err.message}`));
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(result => sendResponse({ ok: true, ...(result || {}) }))
      .catch(err => {
        logger.warn(err.message || String(err));
        sendResponse({ ok: false, error: err.message || String(err) });
      });
    return true;
  });

  chrome.action.onClicked.addListener(tab => {
    handleActionClick(tab).catch(err => logger.warn(`Toolbar action failed: ${err.message}`));
  });

  chrome.downloads.onCreated.addListener(item => {
    try {
      if (!item || item.byExtensionId === chrome.runtime.id) return;
      const request = findCaptureRequestForDownload(item);
      if (!request) return;
      notifyNativeDownloadCaptured(item, request).catch(err => logger.warn(`Could not notify native download capture: ${err.message}`));
    } catch (err) {
      logger.warn(`Native download capture failed: ${err.message}`);
    }
  });
})(globalThis);
