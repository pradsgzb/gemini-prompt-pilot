(function attachPromptPilotPromptParser(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});

  function parsePrompts(text, options) {
    const opts = options || {};
    const raw = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!raw) return [];

    if (opts.mode === 'blocks') {
      return raw.split(/\n\s*\n+/).map(value => value.trim()).filter(Boolean);
    }

    if (opts.mode === 'separator') {
      const separator = String(opts.separator || '---').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\n\\s*${separator}\\s*\\n`, 'g');
      return raw.split(regex).map(value => value.trim()).filter(Boolean);
    }

    return raw.split('\n').map(value => value.trim()).filter(Boolean);
  }

  root.PromptParser = Object.freeze({ parsePrompts });
})(globalThis);
