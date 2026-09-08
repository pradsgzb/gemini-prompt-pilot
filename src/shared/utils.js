(function attachPromptPilotUtils(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  function clone(value) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (_) {}
    }
    return JSON.parse(JSON.stringify(value));
  }

  function deepMerge(base, patch) {
    const output = clone(base || {});
    if (!isPlainObject(patch)) return output;

    for (const [key, value] of Object.entries(patch)) {
      if (isPlainObject(value) && isPlainObject(output[key])) {
        output[key] = deepMerge(output[key], value);
      } else if (Array.isArray(value)) {
        output[key] = clone(value);
      } else if (value !== undefined) {
        output[key] = value;
      }
    }
    return output;
  }

  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds || 0)));
  }

  function sleepWithSignal(milliseconds, signal) {
    const duration = Math.max(0, Number(milliseconds || 0));
    if (!signal) return sleep(duration);
    if (signal.aborted) return Promise.reject(new Error('Stopped by user.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener?.('abort', onAbort);
        resolve();
      }, duration);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener?.('abort', onAbort);
        reject(new Error('Stopped by user.'));
      };
      signal.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(value, maxLength) {
    const text = String(value || '');
    if (!maxLength || text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 16))}… [truncated]`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function toRegExp(pattern, flags) {
    if (pattern instanceof RegExp) return pattern;
    try {
      return new RegExp(String(pattern || ''), flags || 'i');
    } catch (_) {
      return /$a/;
    }
  }

  function getByPath(object, path, fallback) {
    if (!path) return fallback;
    const parts = String(path).split('.').filter(Boolean);
    let current = object;
    for (const part of parts) {
      if (current == null || !Object.prototype.hasOwnProperty.call(current, part)) return fallback;
      current = current[part];
    }
    return current === undefined ? fallback : current;
  }

  function setByPath(object, path, value) {
    const parts = String(path).split('.').filter(Boolean);
    let current = object;
    while (parts.length > 1) {
      const key = parts.shift();
      if (!isPlainObject(current[key])) current[key] = {};
      current = current[key];
    }
    current[parts[0]] = value;
    return object;
  }

  function padNumber(value, width) {
    return String(value).padStart(width || 3, '0');
  }

  function sanitizeFilename(value, fallback) {
    const cleaned = String(value || fallback || 'image')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/[\x00-\x1F\x7F]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    return cleaned || fallback || 'image';
  }

  function slugify(value, fallback) {
    const slug = sanitizeFilename(value, fallback || 'prompt')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70);
    return slug || fallback || 'prompt';
  }

  function templateFilename(template, context) {
    const data = context || {};
    return String(template || '{index}-{slug}.jpg')
      .replace(/\{index\}/g, data.index || '')
      .replace(/\{site\}/g, data.site || '')
      .replace(/\{slug\}/g, data.slug || '')
      .replace(/\{timestamp\}/g, data.timestamp || '')
      .replace(/\{ext\}/g, data.ext || 'jpg');
  }

  function nowTimestamp() {
    const date = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function randomId(prefix) {
    const cryptoObject = global.crypto;
    if (cryptoObject?.randomUUID) return `${prefix || 'id'}-${cryptoObject.randomUUID()}`;
    const bytes = new Uint8Array(12);
    try { cryptoObject?.getRandomValues?.(bytes); } catch (_) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    const suffix = Array.from(bytes).map(value => value.toString(16).padStart(2, '0')).join('');
    return `${prefix || 'id'}-${Date.now().toString(36)}-${suffix}`;
  }

  function hashText(value) {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function dataUrlToBytes(dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('Invalid data URL.');
    const mime = match[1] || 'application/octet-stream';
    const isBase64 = Boolean(match[2]);
    const payload = match[3] || '';
    const bytes = isBase64
      ? base64ToBytes(payload)
      : new TextEncoder().encode(decodeURIComponent(payload));
    return { mime, bytes };
  }

  function bytesToDataUrl(bytes, mime) {
    return `data:${mime || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
  }


  function errorToObject(error) {
    if (!error) return null;
    return {
      name: error.name || 'Error',
      code: error.code || null,
      message: error.message || String(error),
      stack: error.stack || null,
      retryable: error.retryable !== false,
      meta: error.meta || null
    };
  }

  function getChromeRuntimeId() {
    try {
      return global.chrome?.runtime?.id || null;
    } catch (_) {
      return null;
    }
  }

  function hasUsableExtensionContext() {
    return Boolean(getChromeRuntimeId());
  }

  function getChromeLastErrorMessage() {
    try {
      return global.chrome?.runtime?.lastError?.message || '';
    } catch (err) {
      return err?.message || String(err || '');
    }
  }

  function isExtensionContextInvalidatedError(error) {
    const text = String(error?.message || error || '');
    return /extension context invalidated|context invalidated|extension has been reloaded|receiving end does not exist|message port closed|message channel closed/i.test(text);
  }

  function createExtensionContextError(action) {
    const error = new Error(
      `Prompt Pilot's extension context was refreshed while this page was still open during ${action || 'an extension action'}. ` +
      'Refresh this tab or click the toolbar icon again to inject the current content script.'
    );
    error.code = 'PROMPT_PILOT_CONTEXT_INVALIDATED';
    return error;
  }

  function safeChromeSendMessage(message) {
    if (!hasUsableExtensionContext()) return false;
    try {
      global.chrome.runtime.sendMessage(message, () => {
        // Swallow popup-closed/no-receiver/context-invalidated errors; automation should continue.
        try { void global.chrome.runtime.lastError; } catch (_) {}
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function chromeRuntimeRequest(message, timeoutMs) {
    const timeout = Math.max(1000, Number(timeoutMs || 15000));
    if (!hasUsableExtensionContext()) return Promise.reject(createExtensionContextError('runtime messaging'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Timed out after ${timeout}ms waiting for the extension service worker.`));
      }, timeout);

      try {
        global.chrome.runtime.sendMessage(message, response => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const errorMessage = getChromeLastErrorMessage();
          if (errorMessage) {
            const error = new Error(errorMessage);
            if (isExtensionContextInvalidatedError(error)) reject(createExtensionContextError('runtime messaging'));
            else reject(error);
            return;
          }
          if (response?.ok === false) {
            reject(new Error(response.error || 'Extension request failed.'));
            return;
          }
          resolve(response || {});
        });
      } catch (error) {
        clearTimeout(timer);
        if (isExtensionContextInvalidatedError(error)) reject(createExtensionContextError('runtime messaging'));
        else reject(error);
      }
    });
  }

  root.Utils = Object.freeze({
    isPlainObject,
    clone,
    deepMerge,
    sleep,
    sleepWithSignal,
    normalizeText,
    truncate,
    escapeHtml,
    escapeRegex,
    toRegExp,
    getByPath,
    setByPath,
    padNumber,
    sanitizeFilename,
    slugify,
    templateFilename,
    nowTimestamp,
    randomId,
    hashText,
    bytesToBase64,
    base64ToBytes,
    dataUrlToBytes,
    bytesToDataUrl,
    errorToObject,
    getChromeRuntimeId,
    hasUsableExtensionContext,
    getChromeLastErrorMessage,
    isExtensionContextInvalidatedError,
    createExtensionContextError,
    safeChromeSendMessage,
    chromeRuntimeRequest
  });
})(globalThis);
