(function attachPromptPilotDom(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const PANEL_HOST_ID = '__prompt_pilot_page_panel__';
  const PANEL_COLLAPSED_ID = '__prompt_pilot_panel_tab__';

  function isOwnElement(element) {
    if (!element || !(element instanceof Element)) return false;
    if (element.id === PANEL_HOST_ID || element.id === PANEL_COLLAPSED_ID) return true;
    if (element.closest?.(`#${PANEL_HOST_ID}, #${PANEL_COLLAPSED_ID}`)) return true;
    const rootNode = element.getRootNode?.();
    return Boolean(rootNode?.host?.id === PANEL_HOST_ID || rootNode?.host?.id === PANEL_COLLAPSED_ID);
  }

  function queryAllDeep(selector, rootNode) {
    const results = [];
    const seen = new Set();
    const queue = [rootNode || document];

    while (queue.length) {
      const currentRoot = queue.shift();
      if (!currentRoot) continue;
      if (currentRoot.host && isOwnElement(currentRoot.host)) continue;

      try {
        currentRoot.querySelectorAll(selector).forEach(element => {
          if (!seen.has(element) && !isOwnElement(element)) {
            seen.add(element);
            results.push(element);
          }
        });
      } catch (err) {
        // Bad or browser-specific selectors are ignored so one config typo does not break the run.
      }

      try {
        currentRoot.querySelectorAll('*').forEach(element => {
          if (element.shadowRoot && !isOwnElement(element)) queue.push(element.shadowRoot);
        });
      } catch (_) {}
    }

    return results;
  }

  function isVisible(element) {
    if (!element || !(element instanceof Element) || isOwnElement(element)) return false;
    const style = window.getComputedStyle(element);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rects = element.getClientRects();
    if (!rects || rects.length === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function labelledText(ids) {
    return String(ids || '').split(/\s+/).map(id => {
      try { return document.getElementById(id)?.textContent || ''; } catch (_) { return ''; }
    }).join(' ');
  }

  function descendantSemanticText(element) {
    if (!element?.querySelectorAll) return '';
    const parts = [];
    const selectors = [
      'mat-icon',
      '[fonticon]',
      '[data-mat-icon-name]',
      '[data-icon]',
      '[data-lucide]',
      'svg[aria-label]',
      'svg title',
      'use[href]',
      'use[xlink\\:href]'
    ];
    try {
      element.querySelectorAll(selectors.join(',')).forEach(child => {
        parts.push(
          child.getAttribute?.('aria-label'),
          child.getAttribute?.('title'),
          child.getAttribute?.('fonticon'),
          child.getAttribute?.('data-mat-icon-name'),
          child.getAttribute?.('data-icon'),
          child.getAttribute?.('data-lucide'),
          child.getAttribute?.('href'),
          child.getAttribute?.('xlink:href'),
          child.textContent
        );
      });
    } catch (_) {}
    return parts.filter(Boolean).join(' ');
  }

  function accessibleName(element) {
    if (!element) return '';
    const parts = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('aria-labelledby') ? labelledText(element.getAttribute('aria-labelledby')) : '',
      element.getAttribute?.('title'),
      element.getAttribute?.('placeholder'),
      element.getAttribute?.('data-testid'),
      element.getAttribute?.('data-test-id'),
      element.getAttribute?.('alt'),
      element.getAttribute?.('fonticon'),
      element.getAttribute?.('data-mat-icon-name'),
      element.getAttribute?.('data-icon'),
      element.getAttribute?.('data-lucide'),
      element.getAttribute?.('class'),
      element.getAttribute?.('jslog'),
      descendantSemanticText(element),
      element.textContent
    ];
    return utils.normalizeText(parts.filter(Boolean).join(' '));
  }

  function isDisabled(element) {
    if (!element) return true;
    if (element.disabled) return true;
    for (let current = element; current && current !== document.documentElement; current = current.parentElement) {
      if (current.hasAttribute?.('disabled')) return true;
      if (current.getAttribute?.('aria-disabled') === 'true') return true;
      if (current.hasAttribute?.('inert')) return true;
      if (current.classList?.contains('disabled')) return true;
    }
    return false;
  }

  function matchesAnyText(element, patterns) {
    if (!patterns || !patterns.length) return false;
    const name = accessibleName(element);
    return patterns.some(pattern => utils.toRegExp(pattern, 'i').test(name));
  }

  function excludesAnyText(element, patterns) {
    if (!patterns || !patterns.length) return false;
    const name = accessibleName(element);
    return patterns.some(pattern => utils.toRegExp(pattern, 'i').test(name));
  }

  const HARD_UNSAFE_SUBMIT_TEXT_PATTERNS = Object.freeze([
    'stop response',
    'stop generating',
    'stop streaming',
    'stop generation',
    'cancel response',
    'cancel generation',
    'cancel generating',
    'pause response',
    'pause generation',
    '\\bstop\\b',
    '\\bcancel\\b',
    '\\bpause\\b',
    '\\babort\\b',
    '\\binterrupt\\b',
    'stop[_ -]?button',
    'stop[_ -]?circle',
    'stop[_ -]?filled',
    'cancel[_ -]?button'
  ]);

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).filter(value => value != null && value !== '')));
  }

  function mergeSubmitExcludePatterns(selectors) {
    return uniqueStrings([
      ...(root.GENERIC_SITE_SELECTORS?.submitExcludeTextPatterns || []),
      ...(selectors?.submitExcludeTextPatterns || []),
      ...HARD_UNSAFE_SUBMIT_TEXT_PATTERNS
    ]);
  }

  function buttonLike(element) {
    if (!element) return null;
    if (element.matches?.('button, a, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], input[type="button"], input[type="submit"]')) {
      return element;
    }
    return element.closest?.('button, a, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], input[type="button"], input[type="submit"]')
      || element.querySelector?.('button, a, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="option"], input[type="button"], input[type="submit"]')
      || null;
  }

  function hasDescendantIconNamed(element, names) {
    if (!element?.querySelector) return false;
    const wanted = new Set((names || []).map(name => String(name).toLowerCase()));
    try {
      return Array.from(element.querySelectorAll('mat-icon, [fonticon], [data-mat-icon-name], [data-icon], [data-lucide], svg[aria-label], svg title')).some(child => {
        const values = [
          child.getAttribute?.('fonticon'),
          child.getAttribute?.('data-mat-icon-name'),
          child.getAttribute?.('data-icon'),
          child.getAttribute?.('data-lucide'),
          child.getAttribute?.('aria-label'),
          child.getAttribute?.('title'),
          child.textContent
        ];
        return values.some(value => wanted.has(utils.normalizeText(value).toLowerCase()));
      });
    } catch (_) {
      return false;
    }
  }

  function isUnsafeSubmitControl(element) {
    if (!element) return false;
    const control = buttonLike(element) || element;
    const combinedName = `${accessibleName(control)} ${control === element ? '' : accessibleName(element)}`;
    const configuredPatterns = root.GENERIC_SITE_SELECTORS?.unsafeSubmitTextPatterns || [];
    const allPatterns = [...HARD_UNSAFE_SUBMIT_TEXT_PATTERNS, ...configuredPatterns];
    if (allPatterns.some(pattern => utils.toRegExp(pattern, 'i').test(combinedName))) return true;
    if (hasDescendantIconNamed(control, ['stop', 'cancel', 'pause'])) return true;
    return false;
  }

  function describeElement(element) {
    if (!element) return null;
    const target = buttonLike(element) || element;
    return {
      tag: String(target.tagName || '').toLowerCase(),
      id: target.id || null,
      role: target.getAttribute?.('role') || null,
      ariaLabel: target.getAttribute?.('aria-label') || null,
      title: target.getAttribute?.('title') || null,
      href: target.getAttribute?.('href') || null,
      className: typeof target.className === 'string' ? target.className.slice(0, 240) : null,
      accessibleName: accessibleName(target).slice(0, 300),
      visible: isVisible(target),
      disabled: isDisabled(target),
      unsafe: isUnsafeSubmitControl(target)
    };
  }

  function isSafeSubmitControl(element, excludePatterns) {
    const target = buttonLike(element) || element;
    return Boolean(
      target
      && isVisible(target)
      && !isDisabled(target)
      && !isUnsafeSubmitControl(target)
      && !excludesAnyText(target, uniqueStrings([...(excludePatterns || []), ...HARD_UNSAFE_SUBMIT_TEXT_PATTERNS]))
    );
  }

  function isPositiveSubmitControl(element, includePatterns, excludePatterns) {
    const target = buttonLike(element) || element;
    if (!isSafeSubmitControl(target, excludePatterns)) return false;
    const name = accessibleName(target);
    const classText = String(target.className || '');
    const explicitType = target.matches?.('button[type="submit"], input[type="submit"]');
    const positiveText = /(^|\b)(send|submit|generate|create)(\b|$)|arrow[_ -]?upward|paper[_ -]?plane|send[_ -]?button/i.test(`${name} ${classText}`);
    const positiveIcon = hasDescendantIconNamed(target, ['arrow_upward', 'send', 'paper_plane', 'north']);
    const configuredPositive = (includePatterns || []).some(pattern => utils.toRegExp(pattern, 'i').test(name));
    return Boolean(explicitType || positiveText || positiveIcon || configuredPositive);
  }

  function uniqueElements(elements) {
    const seen = new Set();
    return (elements || []).filter(element => {
      if (!element || seen.has(element)) return false;
      seen.add(element);
      return true;
    });
  }

  function findFirst(selectors, options) {
    const opts = options || {};
    const rootNode = opts.root || document;
    const predicate = typeof opts.predicate === 'function' ? opts.predicate : () => true;
    for (const selector of selectors || []) {
      const elements = queryAllDeep(selector, rootNode);
      const match = elements.find(element => isVisible(element) && predicate(element));
      if (match) return match;
    }
    return null;
  }

  function findAll(selectors, options) {
    const opts = options || {};
    const rootNode = opts.root || document;
    const predicate = typeof opts.predicate === 'function' ? opts.predicate : () => true;
    const seen = new Set();
    const output = [];
    for (const selector of selectors || []) {
      for (const element of queryAllDeep(selector, rootNode)) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (isVisible(element) && predicate(element)) output.push(element);
      }
    }
    return output;
  }

  function findByText(selectors, patterns, options) {
    const opts = options || {};
    const exclude = opts.excludeTextPatterns || [];
    const predicate = typeof opts.predicate === 'function' ? opts.predicate : () => true;
    const candidates = findAll(selectors || ['button', 'a', '[role="button"]', '[role="menuitem"]', '[role="option"]'], {
      root: opts.root || document,
      predicate: element => predicate(element)
    });

    for (const element of candidates) {
      if (excludesAnyText(element, exclude)) continue;
      if (matchesAnyText(element, patterns)) return buttonLike(element) || element;
    }
    return null;
  }

  function dispatchMouseSequence(element, eventTypes) {
    const rect = element.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const options = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    for (const type of eventTypes) {
      try { element.dispatchEvent(new MouseEvent(type, options)); } catch (_) {}
    }
  }

  function hoverElement(element) {
    if (!element) return false;
    try { element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch (_) {
      try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (__) {}
    }
    dispatchMouseSequence(element, ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'mousemove']);
    return true;
  }

  function safeClick(element, options) {
    const opts = options || {};
    if (!element) return false;
    const target = buttonLike(element) || element;
    if (isUnsafeSubmitControl(target)) {
      const description = describeElement(target);
      opts.logger?.error?.('Blocked an attempt to click a Stop/Cancel/Pause/Abort control.', {
        purpose: opts.purpose || 'unspecified',
        element: description
      }, 'SAFETY_CLICK_BLOCKED');
      const error = new Error(`Safety guard blocked an unsafe page control: ${description?.accessibleName || 'Stop/Cancel control'}.`);
      error.code = 'PROMPT_PILOT_UNSAFE_CLICK_BLOCKED';
      error.meta = description;
      if (opts.throwOnUnsafe !== false) throw error;
      return false;
    }
    if (!isVisible(target) || isDisabled(target)) {
      opts.logger?.debug?.('Page control was not clicked because it is hidden or disabled.', {
        purpose: opts.purpose || 'unspecified',
        element: describeElement(target)
      }, 'CLICK_NOT_ACTIONABLE');
      return false;
    }
    if (opts.requirePositiveSubmit && !isPositiveSubmitControl(target, opts.includePatterns || [], opts.excludePatterns || [])) {
      const description = describeElement(target);
      const error = new Error(`Control is not positively identified as Send/Submit: ${description?.accessibleName || 'unknown control'}.`);
      error.code = 'PROMPT_PILOT_NON_SUBMIT_CLICK_BLOCKED';
      error.meta = description;
      opts.logger?.error?.(error.message, { purpose: opts.purpose || 'submit', element: description }, 'SAFETY_NON_SUBMIT_BLOCKED');
      throw error;
    }

    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch (_) {
      try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (__) {}
    }
    try { target.focus?.({ preventScroll: true }); } catch (_) {}

    if (opts.requirePositiveSubmit) {
      // The Gemini Send button can mutate into Stop as soon as submission begins.
      // Perform one last synchronous identity check and then one native click only;
      // never dispatch pointerdown/mousedown events that could race with that mutation.
      if (isUnsafeSubmitControl(target) || !isPositiveSubmitControl(target, opts.includePatterns || [], opts.excludePatterns || [])) {
        const error = new Error('Submit control changed identity before click; the click was blocked.');
        error.code = 'PROMPT_PILOT_SUBMIT_CONTROL_MUTATED';
        error.meta = describeElement(target);
        opts.logger?.error?.(error.message, error.meta, 'SAFETY_SUBMIT_MUTATED');
        throw error;
      }
      try { target.click(); } catch (_) { return false; }
    } else {
      // Do not synthesize pointerdown/mousedown. Some web apps act on those early
      // events, and a control can mutate into Stop/Cancel while generation starts.
      // A single final safety check followed by one native click is deterministic.
      if (isUnsafeSubmitControl(target)) {
        const error = new Error('Control changed into Stop/Cancel before click; the click was blocked.');
        error.code = 'PROMPT_PILOT_CONTROL_MUTATED';
        error.meta = describeElement(target);
        opts.logger?.error?.(error.message, error.meta, 'SAFETY_CONTROL_MUTATED');
        throw error;
      }
      try { target.click(); } catch (_) {
        if (isUnsafeSubmitControl(target)) return false;
        try { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window })); } catch (__) { return false; }
      }
    }

    opts.logger?.debug?.('Clicked page control.', {
      purpose: opts.purpose || 'unspecified',
      element: describeElement(target)
    }, 'CLICK_PERFORMED');
    return true;
  }

  function safeSubmitClick(element, options) {
    return safeClick(element, { ...(options || {}), requirePositiveSubmit: true, throwOnUnsafe: true });
  }

  async function waitFor(factory, options) {
    const opts = options || {};
    const resolveNumber = (value, fallback, minimum) => {
      const resolved = typeof value === 'function' ? value() : (value ?? fallback);
      const numeric = Number(resolved);
      const fallbackNumeric = Number(fallback);
      return Math.max(minimum, Number.isFinite(numeric) ? numeric : (Number.isFinite(fallbackNumeric) ? fallbackNumeric : minimum));
    };
    const resolveTimeout = () => resolveNumber(opts.timeout, 30000, 0);
    const resolveInterval = () => resolveNumber(opts.interval, 250, 25);
    const name = opts.name || 'condition';
    const signal = opts.signal;
    const started = Date.now();
    let lastError = null;
    let timeout = resolveTimeout();

    while (true) {
      if (signal?.aborted) throw new Error('Stopped by user.');
      timeout = resolveTimeout();
      const elapsed = Date.now() - started;
      if (elapsed >= timeout) break;
      try {
        const value = factory();
        if (value) return value;
      } catch (err) {
        lastError = err;
      }
      const remaining = Math.max(1, timeout - (Date.now() - started));
      await utils.sleepWithSignal(Math.min(resolveInterval(), remaining), signal);
    }

    const suffix = lastError ? ` Last error: ${lastError.message}` : '';
    throw new Error(`Timed out after ${timeout} ms waiting for ${name}.${suffix}`);
  }

  function textToHtml(text) {
    const lines = String(text || '').split(/\r?\n/);
    return lines.map(line => line ? `<p>${utils.escapeHtml(line)}</p>` : '<p><br></p>').join('');
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function dispatchInputEvents(element, text) {
    const eventOptions = { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text };
    try { element.dispatchEvent(new InputEvent('beforeinput', eventOptions)); } catch (_) {}
    try { element.dispatchEvent(new InputEvent('input', eventOptions)); }
    catch (_) { element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true })); }
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    try { element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true, key: ' ', code: 'Space' })); } catch (_) {}
  }

  async function setInputText(element, text) {
    if (!element) throw new Error('No prompt input element found.');
    const value = String(text || '');
    element.focus?.();

    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      setNativeValue(element, '');
      dispatchInputEvents(element, '');
      await utils.sleep(40);
      setNativeValue(element, value);
      dispatchInputEvents(element, value);
      return;
    }

    if (element.getAttribute?.('contenteditable') === 'true' || element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      try { document.execCommand('delete', false, null); } catch (_) {}
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, value); } catch (_) {}
      await utils.sleep(80);
      const currentText = utils.normalizeText(element.innerText || element.textContent);
      const expectedStart = utils.normalizeText(value).slice(0, 40);
      if (!inserted || (expectedStart && !currentText.includes(expectedStart))) {
        element.innerHTML = textToHtml(value);
        element.classList?.remove('ql-blank');
      }
      dispatchInputEvents(element, value);
      return;
    }

    throw new Error('Prompt input is neither textarea/input nor contenteditable.');
  }

  function getInputText(element) {
    if (!element) return '';
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value || '';
    return element.innerText || element.textContent || '';
  }

  function pressEnter(element) {
    if (!element) return false;
    element.focus?.();
    const options = { bubbles: true, cancelable: true, composed: true, key: 'Enter', code: 'Enter', which: 13, keyCode: 13 };
    let ok = true;
    for (const type of ['keydown', 'keypress', 'keyup']) {
      try { element.dispatchEvent(new KeyboardEvent(type, options)); } catch (_) { ok = false; }
    }
    return ok;
  }

  function elementDocumentOrder(element) {
    const all = Array.from(document.querySelectorAll('body *'));
    return all.indexOf(element);
  }

  function imageScore(img) {
    const rect = img.getBoundingClientRect();
    const naturalArea = (img.naturalWidth || rect.width || 0) * (img.naturalHeight || rect.height || 0);
    const viewportBonus = rect.top > 0 && rect.top < window.innerHeight * 1.8 ? 1000000 : 0;
    const order = Array.prototype.indexOf.call(document.images, img);
    const domOrderBonus = Math.max(0, order) * 10;
    return naturalArea + viewportBonus + domOrderBonus;
  }

  function getLargeVisibleImages(selectors) {
    return findAll(selectors?.length ? selectors : ['img', 'picture img', 'main img'], {
      predicate: img => {
        if (!(img instanceof HTMLImageElement)) return false;
        if (!isVisible(img)) return false;
        const rect = img.getBoundingClientRect();
        const width = img.naturalWidth || rect.width;
        const height = img.naturalHeight || rect.height;
        if (width < 128 || height < 128) return false;
        const src = img.currentSrc || img.src || '';
        if (!src || /^chrome-extension:/i.test(src)) return false;
        return true;
      }
    }).sort((a, b) => imageScore(a) - imageScore(b));
  }

  function inputCandidateScore(element) {
    if (!element || isDisabled(element) || !isVisible(element)) return -Infinity;
    if (element instanceof HTMLInputElement && !/^(text|search|url|email)?$/i.test(element.type || 'text')) return -Infinity;
    const name = accessibleName(element);
    const rect = element.getBoundingClientRect();
    let score = 0;
    if (element instanceof HTMLTextAreaElement) score += 80;
    if (element.getAttribute?.('contenteditable') === 'true' || element.isContentEditable) score += 70;
    if (element.getAttribute?.('role') === 'textbox') score += 30;
    if (/prompt|message|ask|describe|what do you want|type|chat|compose/i.test(name)) score += 80;
    if (/search within|filter|comment|reply to|email|password|username|phone|otp/i.test(name)) score -= 80;
    if (/composer|prompt|input|chat|textarea|ql-editor/i.test(String(element.className || '') + ' ' + element.id)) score += 50;
    if (element.closest?.('form')) score += 15;
    if (element.closest?.('[data-testid*="composer" i], [data-test-id*="composer" i], [class*="composer" i], [class*="prompt" i], [class*="input" i]')) score += 40;
    if (rect.bottom > window.innerHeight * 0.45) score += 25;
    score += Math.min(40, rect.width / 20);
    score += Math.min(25, rect.height / 4);
    return score;
  }

  function findLikelyPromptInput(config) {
    const selectors = config?.selectors || {};
    const direct = findFirst(selectors.input || [], { predicate: element => !isDisabled(element) });
    if (direct) return direct;

    const genericSelectors = root.GENERIC_SITE_SELECTORS?.input || ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
    const candidates = uniqueElements(findAll(genericSelectors, { predicate: element => !isDisabled(element) }));
    return candidates
      .map(element => ({ element, score: inputCandidateScore(element) }))
      .filter(item => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function nearestSearchScopes(input, containerSelectors) {
    const scopes = [];
    const add = element => {
      if (element && !scopes.includes(element) && !isOwnElement(element)) scopes.push(element);
    };
    add(input?.closest?.('form'));
    for (const selector of containerSelectors || []) {
      try { add(input?.closest?.(selector)); } catch (_) {}
    }
    add(input?.parentElement);
    add(input?.closest?.('main'));
    add(document);
    return scopes.filter(Boolean);
  }

  function buttonCenterDistance(button, anchor) {
    if (!button || !anchor) return 999999;
    const a = anchor.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    return Math.hypot(ax - bx, ay - by);
  }

  function submitButtonScore(button, input, includePatterns, excludePatterns) {
    if (!isSafeSubmitControl(button, excludePatterns)) return -Infinity;
    const name = accessibleName(button);
    const rect = button.getBoundingClientRect();
    let score = 0;
    if (button.matches?.('button[type="submit"], input[type="submit"]')) score += 80;
    if (matchesAnyText(button, includePatterns)) score += 100;
    if (/send|submit|generate|create|arrow[_ -]?upward|paper[_ -]?plane|send-button/i.test(name)) score += 80;
    if (/stop|cancel|pause|interrupt|abort|feedback|share|download|copy|upload|attach|mic|voice|menu|settings|profile|apps|retry|regenerate/i.test(name)) score -= 180;
    if (rect.width > 0 && rect.height > 0 && rect.width <= 96 && rect.height <= 96) score += 25;
    score -= Math.min(80, buttonCenterDistance(button, input) / 20);
    const inputOrder = elementDocumentOrder(input);
    const buttonOrder = elementDocumentOrder(button);
    if (buttonOrder >= inputOrder && buttonOrder - inputOrder < 80) score += 15;
    return score;
  }

  function findLikelySubmitButton(input, selectors) {
    const cfg = selectors || {};
    const exclude = mergeSubmitExcludePatterns(cfg);
    const include = [
      ...(cfg.submitTextPatterns || []),
      ...(root.GENERIC_SITE_SELECTORS?.submitTextPatterns || [])
    ];
    const scopes = nearestSearchScopes(input, cfg.inputContainers || []);

    for (const scope of scopes) {
      const direct = findFirst(cfg.submit || [], { root: scope, predicate: element => isSafeSubmitControl(element, exclude) });
      if (direct) return buttonLike(direct) || direct;
      const byText = findByText(['button', 'a', '[role="button"]', '[role="menuitem"]', 'input[type="submit"]', 'mat-icon', 'svg'], include, {
        root: scope,
        excludeTextPatterns: exclude,
        predicate: element => isSafeSubmitControl(element, exclude)
      });
      if (byText) return byText;
    }

    const genericCandidates = uniqueElements(findAll([
      'button',
      'a[role="button"]',
      '[role="button"]',
      'input[type="submit"]',
      'mat-icon',
      'svg'
    ], { predicate: element => isSafeSubmitControl(element, exclude) }).map(element => buttonLike(element) || element));

    return genericCandidates
      .map(button => ({ button, score: submitButtonScore(button, input, include, exclude) }))
      .filter(item => item.score > 20)
      .sort((a, b) => b.score - a.score)[0]?.button || null;
  }

  function likelyDownloadButtonScore(button, image, textPatterns) {
    if (!button || isDisabled(button) || !isVisible(button)) return -Infinity;
    const name = accessibleName(button);
    let score = 0;
    if (matchesAnyText(button, textPatterns || [])) score += 120;
    if (/download|save[_ -]?alt|file[_ -]?download|download full|full size/i.test(name)) score += 120;
    if (/feedback|copy|share|edit|delete|close|more|menu|retry|regenerate|open|expand/i.test(name)) score -= 100;
    if (button.matches?.('a[download]')) score += 100;
    if (button.matches?.('button, a, [role="button"]')) score += 20;
    score -= Math.min(80, buttonCenterDistance(button, image) / 25);
    return score;
  }

  function cardScopesForImage(image) {
    const scopes = [];
    const add = element => {
      if (element && !scopes.includes(element) && !isOwnElement(element)) scopes.push(element);
    };
    add(image?.closest?.('[data-testid*="message" i]'));
    add(image?.closest?.('[data-test-id*="message" i]'));
    add(image?.closest?.('model-response'));
    add(image?.closest?.('message-content'));
    add(image?.closest?.('article'));
    add(image?.closest?.('[role="article"]'));
    add(image?.closest?.('[class*="message" i]'));
    add(image?.closest?.('[class*="response" i]'));
    add(image?.closest?.('[class*="image" i]'));
    add(image?.parentElement);
    add(image?.closest?.('main'));
    add(document);
    return scopes;
  }

  function findDownloadButtonForImage(image, selectors, textPatterns) {
    const genericSelectors = root.GENERIC_SITE_SELECTORS?.downloadButtons || [];
    const candidates = [];
    const seen = new Set();
    const addCandidate = element => {
      const button = buttonLike(element) || element;
      if (button && !seen.has(button) && !isOwnElement(button)) {
        seen.add(button);
        candidates.push(button);
      }
    };

    if (image) hoverElement(image.closest?.('[class*="image" i], article, [role="article"]') || image.parentElement || image);

    for (const scope of cardScopesForImage(image)) {
      for (const element of findAll([...(selectors || []), ...genericSelectors], { root: scope, predicate: element => !isDisabled(buttonLike(element) || element) })) {
        addCandidate(element);
      }
      const byText = findByText(['button', 'a', '[role="button"]', 'mat-icon', 'svg'], textPatterns || root.GENERIC_SITE_SELECTORS?.downloadTextPatterns || [], {
        root: scope,
        predicate: element => !isDisabled(buttonLike(element) || element)
      });
      if (byText) addCandidate(byText);
    }

    return candidates
      .map(button => ({ button, score: likelyDownloadButtonScore(button, image, textPatterns || root.GENERIC_SITE_SELECTORS?.downloadTextPatterns || []) }))
      .filter(item => item.score > 30)
      .sort((a, b) => b.score - a.score)[0]?.button || null;
  }

  root.Dom = Object.freeze({
    PANEL_HOST_ID,
    PANEL_COLLAPSED_ID,
    isOwnElement,
    queryAllDeep,
    isVisible,
    accessibleName,
    isDisabled,
    matchesAnyText,
    excludesAnyText,
    mergeSubmitExcludePatterns,
    isUnsafeSubmitControl,
    isSafeSubmitControl,
    isPositiveSubmitControl,
    describeElement,
    buttonLike,
    findFirst,
    findAll,
    findByText,
    hoverElement,
    safeClick,
    safeSubmitClick,
    waitFor,
    setInputText,
    getInputText,
    pressEnter,
    getLargeVisibleImages,
    findLikelyPromptInput,
    nearestSearchScopes,
    findLikelySubmitButton,
    findDownloadButtonForImage
  });
})(globalThis);
