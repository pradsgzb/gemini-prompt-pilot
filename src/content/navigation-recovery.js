(function attachPromptPilotNavigationRecovery(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const dom = root.Dom;

  function comparableUrl(value) {
    try {
      const url = new URL(value, global.location?.href || undefined);
      url.hash = '';
      return `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`;
    } catch (_) {
      return String(value || '').replace(/#.*$/, '').replace(/\/$/, '');
    }
  }

  function pathKey(value) {
    try {
      const url = new URL(value, global.location?.href || undefined);
      return `${url.pathname.replace(/\/$/, '')}${url.search}`;
    } catch (_) {
      return String(value || '').replace(/^https?:\/\/[^/]+/i, '').replace(/#.*$/, '').replace(/\/$/, '');
    }
  }

  function isLikelyPersistentConversationPath(config, value) {
    const key = pathKey(value);
    if (!key) return false;
    if (config?.id === 'gemini') return /^\/app\/[^/?#]+/i.test(key);
    if (config?.id === 'chatgpt') return /^\/c\/[^/?#]+/i.test(key);
    return !/^\/?(?:app)?\/?(?:\?.*)?$/i.test(key);
  }

  class NavigationRecovery {
    constructor(config, settings, logger, signal, callbacks) {
      this.config = config || {};
      this.settings = settings || {};
      this.logger = logger;
      this.signal = signal;
      this.waitForInputReady = callbacks?.waitForInputReady;
      this.runPreRunSteps = callbacks?.runPreRunSteps;
      this.checkpoint = callbacks?.checkpoint;
    }

    assertNotStopped() {
      if (this.signal?.aborted) throw new Error('Stopped by user.');
    }

    getNumberSetting(path, fallback, minimum) {
      const value = Number(utils.getByPath(this.settings || {}, path, fallback));
      const normalized = Number.isFinite(value) ? value : Number(fallback || 0);
      return Math.max(Number(minimum || 0), normalized);
    }

    async sleepForSetting(path, fallback, minimum) {
      const started = Date.now();
      while (true) {
        this.assertNotStopped();
        const duration = this.getNumberSetting(path, fallback, minimum || 0);
        const elapsed = Date.now() - started;
        if (elapsed >= duration) return;
        await utils.sleepWithSignal(Math.min(250, Math.max(1, duration - elapsed)), this.signal);
      }
    }

    conversationLinkSelectors() {
      return Array.from(new Set([
        ...(this.config.selectors?.conversationLinks || []),
        ...(this.settings.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.conversationLinks || []) : []),
        'a[href]'
      ]));
    }

    captureChatContext(options) {
      const url = global.location?.href || '';
      const key = pathKey(url);
      const candidates = dom.findAll(this.conversationLinkSelectors(), {
        predicate: element => {
          const href = element.href || element.getAttribute?.('href') || '';
          if (!href || dom.isUnsafeSubmitControl(element)) return false;
          try { return new URL(href, url).origin === new URL(url).origin; } catch (_) { return false; }
        }
      });
      const exact = candidates.find(link => pathKey(link.href || link.getAttribute?.('href')) === key);
      const context = {
        capturedAt: new Date().toISOString(),
        url,
        comparableUrl: comparableUrl(url),
        pathKey: key,
        persistent: isLikelyPersistentConversationPath(this.config, url),
        title: document.title || '',
        historyHref: exact?.href || exact?.getAttribute?.('href') || null,
        historyLabel: exact ? dom.accessibleName(exact).slice(0, 300) : null
      };
      if (!options?.silent) {
        this.logger?.debug?.('Captured chat navigation context.', {
          context,
          exactHistoryLink: dom.describeElement?.(exact)
        }, 'recovery.chat_context_captured');
      }
      return context;
    }

    async captureSubmittedChatContext(beforeContext, timeoutOverride) {
      const resolveTimeout = () => {
        const resolved = typeof timeoutOverride === 'function'
          ? timeoutOverride()
          : timeoutOverride != null
            ? timeoutOverride
            : this.getNumberSetting('recovery.captureConversationTimeoutMs', 15000, 1000);
        const numeric = Number(resolved);
        return Math.max(1000, Number.isFinite(numeric) ? numeric : 15000);
      };
      const started = Date.now();
      let stableSince = null;
      let last = this.captureChatContext();
      const beforePath = beforeContext?.pathKey || '';
      let timeout = resolveTimeout();

      while (true) {
        this.assertNotStopped();
        timeout = resolveTimeout();
        if (Date.now() - started >= timeout) break;
        last = this.captureChatContext({ silent: true });
        const changedToPersistent = last.persistent && (!beforePath || last.pathKey !== beforePath);
        const remainedPersistent = last.persistent && beforeContext?.persistent && last.pathKey === beforePath;
        // A root-level New chat link is not a recoverable conversation identity. Require
        // the URL itself to be persistent before accepting a matching history link.
        const hasHistoryIdentity = Boolean(last.persistent && last.historyHref && last.pathKey);
        const acceptable = changedToPersistent || remainedPersistent || hasHistoryIdentity;
        if (acceptable) {
          if (stableSince == null) stableSince = Date.now();
          if (Date.now() - stableSince >= 600) {
            this.logger?.info?.('Captured persistent chat identity after prompt submission.', {
              beforeContext,
              submittedContext: last,
              elapsedMs: Date.now() - started
            }, 'recovery.submitted_chat_captured');
            return last;
          }
        } else {
          stableSince = null;
        }
        await utils.sleepWithSignal(Math.min(250, Math.max(1, timeout - (Date.now() - started))), this.signal);
      }

      this.logger?.warn?.('A persistent conversation URL was not confirmed after submission. Recovery will use the best available current URL; if the attempt cannot be verified, the prompt will be logged as failed and the queue will continue according to the finite retry policy.', {
        beforeContext,
        fallbackContext: last,
        timeoutMs: timeout
      }, 'recovery.submitted_chat_capture_timeout');
      return last;
    }

    findNewChatButton() {
      const selectors = this.config.selectors?.newChat || [];
      const direct = dom.findFirst(selectors, {
        predicate: element => {
          const control = dom.buttonLike(element) || element;
          if (dom.isDisabled(control) || dom.isUnsafeSubmitControl(control)) return false;
          const name = dom.accessibleName(control);
          const href = control.href || control.getAttribute?.('href') || '';
          const exactGeminiNewChat = this.config.id === 'gemini' && /\/app\/?(?:[?#].*)?$/i.test(href);
          const exactChatGptNewChat = this.config.id === 'chatgpt' && /^\/?(?:[?#].*)?$/i.test(href);
          return /new\s+(chat|thread|conversation)|start\s+(a\s+)?new/i.test(name) || exactGeminiNewChat || exactChatGptNewChat;
        }
      });
      if (direct) return dom.buttonLike(direct) || direct;
      return dom.findByText(['button', 'a', '[role="button"]'], ['new chat', 'new thread', 'new conversation', 'start new chat'], {
        excludeTextPatterns: ['stop', 'cancel', 'pause', 'abort', 'delete'],
        predicate: element => !dom.isDisabled(dom.buttonLike(element) || element) && !dom.isUnsafeSubmitControl(element)
      });
    }

    async openNewChat(reason, options) {
      this.assertNotStopped();
      // Opening a New chat can replace the current document. Without automatic checkpoint
      // resume, that navigation could strand the rest of the queue. Treat this recovery path as
      // unavailable and let the caller continue in the current chat or fail/advance the prompt.
      if (this.settings.autoResume === false) {
        const error = new Error('Automatic New-chat navigation is disabled because automatic checkpoint resume is off.');
        error.code = 'RECOVERY_AUTO_RESUME_REQUIRED';
        throw error;
      }
      const opts = options || {};
      const before = this.captureChatContext();
      const button = this.findNewChatButton();
      if (!button) throw new Error('Could not find a positively identified, safe New chat control.');

      this.logger?.info?.('Opening New chat for recovery/retry without touching Stop or Cancel.', {
        reason,
        before,
        button: dom.describeElement?.(button)
      }, 'recovery.new_chat_begin');
      const clicked = dom.safeClick(button, {
        logger: this.logger,
        purpose: 'open-new-chat',
        throwOnUnsafe: true
      });
      if (!clicked) throw new Error('The New chat control was found but could not be clicked safely.');

      const timeoutProvider = () => this.getNumberSetting('recovery.reopenTimeoutMs', 30000, 1000);
      await dom.waitFor(() => {
        const current = this.captureChatContext({ silent: true });
        return current.pathKey !== before.pathKey || current.comparableUrl !== before.comparableUrl;
      }, {
        timeout: timeoutProvider,
        interval: 250,
        name: 'New chat navigation to leave the current conversation',
        signal: this.signal
      });

      if (typeof this.waitForInputReady === 'function') await this.waitForInputReady(timeoutProvider);
      await this.sleepForSetting('recovery.settleMs', 1200, 0);
      if (opts.prepare !== false && typeof this.runPreRunSteps === 'function') await this.runPreRunSteps();
      const after = this.captureChatContext();
      this.logger?.info?.('New chat opened successfully.', { before, after, reason }, 'recovery.new_chat_opened');
      return { before, after };
    }

    findOriginalChatLink(context) {
      if (!context?.url && !context?.pathKey) return null;
      const targetComparable = comparableUrl(context.url || context.historyHref || '');
      const targetPath = context.pathKey || pathKey(context.url || context.historyHref || '');
      const links = dom.findAll(this.conversationLinkSelectors(), {
        predicate: element => {
          if (dom.isUnsafeSubmitControl(element)) return false;
          const href = element.href || element.getAttribute?.('href') || '';
          if (!href) return false;
          try { return new URL(href, global.location?.href || '').origin === new URL(context.url).origin; } catch (_) { return false; }
        }
      });

      const exact = links.find(link => comparableUrl(link.href || link.getAttribute?.('href')) === targetComparable)
        || links.find(link => pathKey(link.href || link.getAttribute?.('href')) === targetPath);
      if (exact) return exact;

      if (context.historyLabel) {
        const wanted = utils.normalizeText(context.historyLabel).toLowerCase();
        return links.find(link => utils.normalizeText(dom.accessibleName(link)).toLowerCase() === wanted) || null;
      }
      return null;
    }

    async reopenOriginalChat(context) {
      this.assertNotStopped();
      if (!context?.url && !context?.pathKey) throw new Error('The original chat identity was not captured.');
      if (pathKey(global.location?.href || '') === context.pathKey) {
        if (typeof this.waitForInputReady === 'function') await this.waitForInputReady();
        return { reopened: true, method: 'already-open', url: global.location?.href || '' };
      }

      const timeoutProvider = () => this.getNumberSetting('recovery.reopenTimeoutMs', 30000, 1000);
      const link = await dom.waitFor(() => this.findOriginalChatLink(context), {
        timeout: () => Math.min(timeoutProvider(), 15000),
        interval: 300,
        name: 'the exact original chat in the conversation list',
        signal: this.signal
      }).catch(() => null);

      if (link) {
        this.logger?.info?.('Reopening the timed-out original chat from the conversation list.', {
          target: context,
          link: dom.describeElement?.(link)
        }, 'recovery.original_chat_click');
        const clicked = dom.safeClick(link, {
          logger: this.logger,
          purpose: 'reopen-original-chat-after-timeout',
          throwOnUnsafe: true
        });
        if (!clicked) throw new Error('The original chat link was found but could not be clicked safely.');

        await dom.waitFor(() => pathKey(global.location?.href || '') === context.pathKey, {
          timeout: timeoutProvider,
          interval: 250,
          name: 'the original chat URL to reopen',
          signal: this.signal
        });
        if (typeof this.waitForInputReady === 'function') await this.waitForInputReady(timeoutProvider);
        await this.sleepForSetting('recovery.settleMs', 1200, 0);
        this.logger?.info?.('Original timed-out chat reopened.', {
          url: global.location?.href || '',
          targetPath: context.pathKey
        }, 'recovery.original_chat_reopened');
        return { reopened: true, method: 'conversation-link', url: global.location?.href || '' };
      }

      if (this.settings.recovery?.requireOriginalChatReopen) {
        throw new Error('The exact original timed-out chat was not present in the conversation list.');
      }
      if (this.settings.recovery?.hardReloadFallback === false) {
        throw new Error('The exact original chat link was not found and direct same-origin navigation fallback is disabled.');
      }
      if (!context?.url || !context?.persistent) {
        throw new Error('The original chat did not have a confirmed persistent URL, so it cannot be safely reopened.');
      }

      if (this.settings.autoResume === false) {
        const error = new Error('Direct original-chat navigation is disabled because automatic checkpoint resume is off.');
        error.code = 'RECOVERY_AUTO_RESUME_REQUIRED';
        throw error;
      }

      this.logger?.warn?.('Original chat link was not found; using bounded same-origin tab navigation. The durable checkpoint will resume the same prompt if the page reloads.', {
        targetUrl: context.url
      }, 'recovery.direct_navigation_fallback');
      // A full-page navigation destroys this content-script instance. Require a committed
      // checkpoint before crossing that boundary; if storage is unavailable, fail this recovery
      // path and let the prompt-level retry-or-continue policy proceed without losing the queue.
      await this.checkpoint?.save?.('recovery.before_direct_navigation', { required: true });
      await utils.chromeRuntimeRequest({
        type: root.MESSAGE_TYPES.NAVIGATE_TAB,
        url: context.url
      }, timeoutProvider());

      // For SPA navigation this resolves in the current content script. For a full reload,
      // pagehide aborts the active runner and the replacement content script resumes from the
      // checkpoint. If navigation is accepted but never occurs, this bounded wait fails instead
      // of leaving the queue on a never-resolving promise.
      await dom.waitFor(() => pathKey(global.location?.href || '') === context.pathKey, {
        timeout: timeoutProvider,
        interval: 250,
        name: 'bounded direct navigation to the original chat',
        signal: this.signal
      });
      if (typeof this.waitForInputReady === 'function') await this.waitForInputReady(timeoutProvider);
      await this.sleepForSetting('recovery.settleMs', 1200, 0);
      return { reopened: true, method: 'direct-navigation', url: global.location?.href || '' };
    }

    async reloadTimedOutChat(context, reason) {
      this.assertNotStopped();
      const original = context?.persistent ? context : await this.captureSubmittedChatContext(context, 3000);
      if (!original?.persistent) {
        throw new Error('Timeout recovery could not confirm a persistent original chat URL. The prompt will follow the configured retry-or-continue policy.');
      }
      this.logger?.warn?.('Generation timed out. Starting non-destructive chat reload recovery.', {
        reason,
        originalChat: original
      }, 'recovery.timeout_reload_begin');
      await this.openNewChat(reason, { prepare: false });
      const result = await this.reopenOriginalChat(original);
      this.logger?.info?.('Timeout reload navigation completed. The original attempt will be observed before any retry.', {
        result,
        originalChat: original
      }, 'recovery.timeout_reload_complete');
      return result;
    }
  }

  root.NavigationRecovery = NavigationRecovery;
})(globalThis);
