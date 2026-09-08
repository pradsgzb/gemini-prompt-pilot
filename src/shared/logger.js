(function attachPromptPilotLogger(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const levels = root.LOG_LEVELS || { error: 0, warn: 1, info: 2, debug: 3, verbose: 4, trace: 4 };

  function normalizedLevel(level) {
    return level === 'trace' ? 'verbose' : (levels[level] !== undefined ? level : 'info');
  }

  function truncateString(value, maxLength = 8000) {
    const text = String(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}… [truncated ${text.length - maxLength} chars]`;
  }

  function serialize(value, depth, seen) {
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return truncateString(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (value instanceof Error) return root.Utils?.errorToObject?.(value) || { name: value.name, message: value.message, stack: value.stack };
    if (typeof Element !== 'undefined' && value instanceof Element) {
      return root.Dom?.describeElement?.(value) || `[Element ${value.tagName || 'unknown'}]`;
    }
    if (depth <= 0) return '[MaxDepth]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      const output = value.slice(0, 60).map(item => serialize(item, depth - 1, seen));
      if (value.length > 60) output.push(`[+${value.length - 60} more items]`);
      return output;
    }
    const output = {};
    const entries = Object.entries(value);
    for (const [key, item] of entries.slice(0, 80)) output[key] = serialize(item, depth - 1, seen);
    if (entries.length > 80) output.__truncatedKeys = entries.length - 80;
    return output;
  }

  function safeMeta(meta) {
    if (meta == null) return null;
    try { return serialize(meta, 5, new WeakSet()); }
    catch (_) { return { serializationError: true, value: String(meta) }; }
  }

  class Logger {
    constructor(scope, level, sink, context) {
      this.scope = scope || 'PromptPilot';
      this.level = normalizedLevel(level || 'info');
      this.sink = typeof sink === 'function' ? sink : null;
      this.context = safeMeta(context || {}) || {};
      this.sequence = 0;
      this.startedAt = Date.now();
    }

    setLevel(level) {
      const normalized = normalizedLevel(level);
      if (levels[normalized] !== undefined) this.level = normalized;
    }

    setContext(contextPatch) {
      this.context = { ...(this.context || {}), ...(safeMeta(contextPatch || {}) || {}) };
    }

    shouldLog(level) {
      const normalized = normalizedLevel(level);
      return (levels[normalized] ?? levels.info) <= (levels[this.level] ?? levels.info);
    }

    emit(level, message, meta, eventCode) {
      const normalized = normalizedLevel(level);
      if (!this.shouldLog(normalized)) return null;
      this.sequence += 1;
      const inferredEvent = eventCode || (meta && typeof meta === 'object' ? meta.event : null) || null;
      let normalizedMeta = meta;
      if (inferredEvent && meta && typeof meta === 'object' && !Array.isArray(meta)) {
        normalizedMeta = { ...meta };
        delete normalizedMeta.event;
      }
      const entry = {
        time: new Date().toISOString(),
        elapsedMs: Date.now() - this.startedAt,
        sequence: this.sequence,
        scope: this.scope,
        level: normalized,
        event: inferredEvent,
        message: String(message || ''),
        context: safeMeta(this.context),
        meta: safeMeta(normalizedMeta)
      };

      const consoleMethod = normalized === 'error' ? 'error' : normalized === 'warn' ? 'warn' : normalized === 'debug' ? 'debug' : 'log';
      const eventLabel = entry.event ? `[${entry.event}]` : '';
      try { console[consoleMethod](`[${this.scope}][${normalized.toUpperCase()}]${eventLabel} ${entry.message}`, entry.meta || ''); } catch (_) {}
      if (this.sink) {
        try { this.sink(entry); } catch (_) {}
      }
      return entry;
    }

    event(level, eventCode, message, meta) { return this.emit(level, message, meta, eventCode); }
    error(message, meta, eventCode) { return this.emit('error', message, meta, eventCode); }
    warn(message, meta, eventCode) { return this.emit('warn', message, meta, eventCode); }
    info(message, meta, eventCode) { return this.emit('info', message, meta, eventCode); }
    debug(message, meta, eventCode) { return this.emit('debug', message, meta, eventCode); }
    verbose(message, meta, eventCode) { return this.emit('verbose', message, meta, eventCode); }
    trace(message, meta, eventCode) { return this.emit('verbose', message, meta, eventCode); }
  }

  root.Logger = Logger;
})(globalThis);
