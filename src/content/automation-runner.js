(function attachPromptPilotAutomationRunner(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const dom = root.Dom;
  const imageConverter = root.ImageConverter;
  const statuses = root.RUN_STATUS;

  function pathKey(value) {
    try {
      const url = new URL(value, global.location?.href || undefined);
      return `${url.pathname.replace(/\/$/, '')}${url.search}`;
    } catch (_) {
      return String(value || '').replace(/^https?:\/\/[^/]+/i, '').replace(/#.*$/, '').replace(/\/$/, '');
    }
  }

  class AutomationRunner {
    constructor(config, settings, logger, onStatus, options) {
      this.config = config;
      this.settings = settings || {};
      this.logger = logger;
      this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
      this.repository = options?.repository || new root.SettingsRepository();
      this.tabContext = options?.tabContext || {};
      this.resumeCheckpoint = options?.resumeCheckpoint || null;
      this.abortController = new AbortController();
      this.suspendRequested = false;
      this.checkpoint = new root.RunCheckpoint(this.repository, this.logger, { tabId: this.tabContext?.tabId ?? null });
      this.abortReason = null;
      this.monitor = null;
      this.recovery = null;
      this.lastExecutionStateKey = '';
      this.state = {
        status: statuses.IDLE,
        siteId: config?.id || null,
        siteName: config?.name || 'Unsupported site',
        current: 0,
        total: 0,
        completedCount: 0,
        processedCount: 0,
        successfulCount: 0,
        failedCount: 0,
        message: 'Idle',
        phase: 'idle',
        lastError: null,
        startedAt: null,
        updatedAt: new Date().toISOString()
      };
    }

    stop() {
      if (this.signal.aborted) return;
      this.abortReason = 'user-stop';
      this.state.status = statuses.STOPPING;
      this.state.phase = 'stopping';
      this.state.message = 'Stopping Prompt Pilot without canceling the website generation…';
      this.emit(this.state.message, {
        status: statuses.STOPPING,
        phase: 'stopping'
      });
      this.logger?.warn?.('User requested Stop. Prompt Pilot is aborting its own waits only; it will not click the website Stop/Cancel control.', {
        event: 'run.stop_requested'
      });
      // Make the durable run non-resumable before aborting, so a coincident page reload cannot
      // resurrect an intentionally stopped run.
      try { this.checkpoint?.stop?.().catch(() => {}); } catch (_) {}
      this.abortController.abort();
    }

    get signal() {
      return this.abortController.signal;
    }

    suspendForReload(reason) {
      if (this.signal.aborted) return;
      this.suspendRequested = true;
      this.abortReason = reason || 'content-script-reload';
      this.logger?.warn?.('The content script is being replaced or the page is navigating. The durable checkpoint remains resumable.', {
        reason: this.abortReason
      }, 'run.suspend_requested');
      // Patch storage immediately, before aborting asynchronous waits. This closes the small
      // reinjection race where the replacement content script could start before the old runner's
      // catch handler executes.
      try { this.checkpoint?.suspend?.(this.abortReason).catch(() => {}); } catch (_) {}
      this.abortController.abort();
    }

    emit(message, patch) {
      this.state = utils.deepMerge(this.state, patch || {});
      this.state.message = message || this.state.message;
      this.state.updatedAt = new Date().toISOString();
      this.onStatus(utils.clone(this.state));
    }

    emitCheckpoint(message, patch) {
      const publicState = this.checkpoint?.data ? this.checkpoint.publicState(message, patch) : {};
      this.emit(message, publicState);
    }

    assertNotStopped() {
      if (this.signal.aborted) throw new Error('Stopped by user.');
    }

    setPromptLogContext(job, phase) {
      this.logger?.setContext?.({
        runId: this.checkpoint?.data?.runId || null,
        siteId: this.config?.id || null,
        promptNumber: job ? job.index + 1 : null,
        promptTotal: this.checkpoint?.data?.total || 0,
        promptId: job?.id || null,
        promptHash: job?.promptHash || null,
        attempt: job?.attempt || 0,
        phase: phase || job?.phase || this.checkpoint?.data?.phase || null
      });
    }

    promptLogMeta(job, extra) {
      return {
        promptId: job?.id || null,
        promptNumber: job ? job.index + 1 : null,
        promptHash: job?.promptHash || null,
        promptPreview: this.checkpoint.promptPreview(job, this.settings),
        attempt: job?.attempt || 0,
        recoveryCycles: job?.recoveryCycles || 0,
        ...(extra || {})
      };
    }

    pageLikelyContainsPrompt(prompt) {
      const normalizedPrompt = utils.normalizeText(prompt).toLowerCase();
      if (!normalizedPrompt) return false;
      let pageText = '';
      try { pageText = utils.normalizeText(document.body?.innerText || document.body?.textContent || '').toLowerCase(); }
      catch (_) { return false; }
      if (!pageText) return false;
      const anchors = [
        normalizedPrompt.slice(0, Math.min(120, normalizedPrompt.length)),
        normalizedPrompt.length > 160 ? normalizedPrompt.slice(-100) : ''
      ].filter(value => value.length >= Math.min(16, normalizedPrompt.length));
      return anchors.some(anchor => pageText.includes(anchor));
    }

    diagnosticSnapshot(label) {
      const input = (() => { try { return this.getInput(); } catch (_) { return null; } })();
      const execution = (() => {
        try {
          const state = this.getExecutionState(input);
          return {
            busy: Boolean(state.busy),
            inputReady: Boolean(state.inputReady),
            readyForEntry: Boolean(state.readyForEntry),
            readyToSubmit: Boolean(state.readyToSubmit),
            reason: state.reason || null,
            input: dom.describeElement?.(state.input),
            submitButton: dom.describeElement?.(state.submitButton),
            observedStopControl: dom.describeElement?.(state.stopControl),
            thinkingOverlay: dom.describeElement?.(state.thinkingOverlay)
          };
        } catch (error) {
          return { error: utils.errorToObject(error) };
        }
      })();
      const chat = (() => {
        try { return this.recovery?.captureChatContext?.({ silent: true }) || null; }
        catch (_) { return null; }
      })();
      const generation = (() => {
        try {
          const snapshot = this.monitor?.snapshot?.();
          return snapshot ? {
            pathKey: snapshot.pathKey || null,
            documentVisibility: snapshot.documentVisibility || null,
            imageCount: Number(snapshot.images?.count || 0),
            responseCount: Number(snapshot.responses?.count || 0),
            errorCount: Number(snapshot.errors?.count || 0),
            lastResponseSignature: snapshot.responses?.lastSignature || null
          } : null;
        } catch (error) {
          return { error: utils.errorToObject(error) };
        }
      })();
      return {
        label: label || null,
        capturedAt: new Date().toISOString(),
        url: global.location?.href || '',
        title: document.title || '',
        visibility: document.visibilityState || 'unknown',
        online: global.navigator?.onLine ?? null,
        chat,
        execution,
        generation
      };
    }

    inputContainsExpectedPrompt(input, expectedText) {
      const expected = utils.normalizeText(expectedText);
      if (!expected) return true;
      const current = utils.normalizeText(dom.getInputText(input));
      return current === expected || current.includes(expected.slice(0, Math.min(120, expected.length)));
    }

    siteOption(path, fallback) {
      const siteOptions = this.settings.siteOptions?.[this.config.id] || {};
      return utils.getByPath(siteOptions, path, fallback);
    }

    getSetting(path, fallback) {
      return utils.getByPath(this.settings || {}, path, fallback);
    }

    getNumberSetting(path, fallback, minimum, maximum) {
      const value = Number(this.getSetting(path, fallback));
      const normalized = Number.isFinite(value) ? value : Number(fallback || 0);
      const minimumValue = Number.isFinite(Number(minimum)) ? Number(minimum) : 0;
      const maximumValue = Number.isFinite(Number(maximum)) ? Number(maximum) : Number.POSITIVE_INFINITY;
      return Math.min(maximumValue, Math.max(minimumValue, normalized));
    }

    updateSettings(settingsOrPatch, options) {
      const replace = options?.replace === true;
      this.settings = replace
        ? utils.deepMerge(root.DEFAULT_SETTINGS || {}, settingsOrPatch || {})
        : utils.deepMerge(this.settings || {}, settingsOrPatch || {});
      if (this.monitor) this.monitor.settings = this.settings;
      if (this.recovery) this.recovery.settings = this.settings;
      this.logger?.setLevel?.(this.settings.logging?.level || this.settings.logLevel || 'info');

      if (this.checkpoint?.data) {
        this.checkpoint.patchRun({ settings: utils.clone(this.settings) }, 'run.settings_updated');
        this.checkpoint.save('run.settings_updated').catch(() => {});
      }
      this.emit(this.state.message, { settingsUpdatedAt: new Date().toISOString() });
      this.logger?.debug?.('Live automation settings were applied to the active run.', {
        event: 'settings.live_applied',
        generationTimeoutMs: this.settings.generationTimeoutMs,
        readyTimeoutMs: this.settings.readyTimeoutMs,
        submitTimeoutMs: this.settings.submitTimeoutMs,
        cooldownMs: this.settings.cooldownMs,
        idleSettleMs: this.settings.idleSettleMs,
        maxSubmitRetries: this.settings.maxSubmitRetries,
        retry: this.settings.retry
      });
      return utils.clone(this.settings);
    }

    canRetryCurrentJob(job) {
      const retrySettings = this.settings.retry || {};
      const retriesAllowed = Math.floor(this.getNumberSetting('retry.maxPromptRetries', 0, 0));
      const rawAttemptsCompleted = Number(job?.attempt || 1);
      const attemptsCompleted = Math.max(1, Number.isFinite(rawAttemptsCompleted) ? rawAttemptsCompleted : 1);
      return retrySettings.enabled === true && retriesAllowed > 0 && attemptsCompleted <= retriesAllowed;
    }

    configureComponents() {
      this.monitor = new root.GenerationMonitor(
        this.config,
        this.settings,
        this.logger,
        this.signal,
        () => this.getExecutionState()
      );
      this.recovery = new root.NavigationRecovery(
        this.config,
        this.settings,
        this.logger,
        this.signal,
        {
          waitForInputReady: timeout => this.waitForInputReady(timeout),
          runPreRunSteps: () => this.runPreRunSteps(),
          checkpoint: this.checkpoint
        }
      );
    }

    async start(prompts) {
      if (!this.config) throw new Error('This website is not configured.');
      let queue = Array.isArray(prompts) ? prompts.filter(prompt => String(prompt || '').trim()) : [];

      if (this.resumeCheckpoint) {
        this.checkpoint.resume(this.resumeCheckpoint);
        queue = this.checkpoint.data.jobs.map(job => job.prompt);
      } else {
        this.checkpoint.create(queue, this.settings, this.config, {
          ...this.tabContext,
          url: global.location?.href || this.tabContext?.url || null
        });
        await this.checkpoint.save('run.created');
      }

      // The currently displayed settings win over settings captured by an older checkpoint.
      this.settings = utils.deepMerge(this.checkpoint.data.settings || {}, this.settings || {});
      this.checkpoint.patchRun({ settings: utils.clone(this.settings) }, 'run.settings_synchronized');
      await this.checkpoint.save('run.settings_synchronized');
      this.configureComponents();
      this.state.total = this.checkpoint.data.total;
      this.state.startedAt = this.checkpoint.data.startedAt;
      this.state.completedCount = this.checkpoint.data.completedCount || 0;
      this.state.processedCount = this.checkpoint.data.processedCount || this.checkpoint.data.completedCount || 0;
      this.state.successfulCount = this.checkpoint.data.successfulCount || 0;
      this.state.failedCount = this.checkpoint.data.failedCount || 0;
      this.emitCheckpoint(
        this.resumeCheckpoint
          ? `Resuming run ${this.checkpoint.data.runId} at prompt ${this.checkpoint.data.currentIndex + 1}/${this.checkpoint.data.total}.`
          : `Parsed ${this.checkpoint.data.total} prompts.`,
        { status: statuses.PREPARING, phase: this.resumeCheckpoint ? 'resuming' : 'preparing' }
      );

      if (!this.checkpoint.data.total) {
        this.emit('No prompts found. Paste one prompt per line or adjust parsing mode.', { status: statuses.IDLE, phase: 'idle' });
        return this.state;
      }

      try {
        this.logger?.info?.(this.resumeCheckpoint ? 'Resuming durable prompt queue.' : 'Starting durable prompt queue.', {
          event: this.resumeCheckpoint ? 'run.resumed' : 'run.started',
          runId: this.checkpoint.data.runId,
          total: this.checkpoint.data.total,
          currentIndex: this.checkpoint.data.currentIndex,
          site: this.config.name,
          tabContext: this.tabContext
        });

        try {
          await this.preparePageForRunReliably();
        } catch (setupError) {
          this.logger?.warn?.('Initial page setup did not complete. Prompt processing will continue and each affected prompt will be logged as failed rather than halting the queue.', {
            event: 'setup.failed_continuing',
            error: setupError,
            diagnostic: this.diagnosticSnapshot('setup-failed-continuing')
          });
        }

        while (this.checkpoint.data.currentIndex < this.checkpoint.data.total) {
          this.assertNotStopped();
          const job = this.checkpoint.currentJob;
          this.setPromptLogContext(job, job.phase);
          try {
            await this.processCurrentJob(job);
          } catch (error) {
            if (/Stopped by user/i.test(error.message)) throw error;
            this.logger?.error?.('An unexpected prompt-level automation error was contained. The failed prompt will be logged and the queue will continue.', {
              event: 'prompt.unhandled_error_contained',
              ...this.promptLogMeta(job),
              error,
              diagnostic: this.diagnosticSnapshot('prompt-unhandled-error')
            });
            await this.failJobAndContinue(job, {
              status: 'failed',
              failureType: error.code || 'unhandled-prompt-error',
              reason: error.message || String(error),
              error: utils.errorToObject(error)
            });
          }

          if (this.checkpoint.data.currentIndex < this.checkpoint.data.total) {
            await this.cooldown(this.checkpoint.data.processedCount || this.checkpoint.data.completedCount, this.checkpoint.data.total);
          }
        }

        return await this.finishRunWithSummary();
      } catch (error) {
        if (this.suspendRequested || (this.abortReason && this.abortReason !== 'user-stop')) {
          await this.checkpoint.suspend(this.abortReason || 'content-script-reload');
          this.emit('Run suspended for page reload; it will resume automatically from the durable checkpoint.', {
            status: statuses.RECOVERING,
            phase: 'suspended-for-reload'
          });
          return this.state;
        }
        if (this.abortReason === 'user-stop' || /Stopped by user/i.test(error.message)) {
          await this.checkpoint.stop();
          this.emit('Stopped. The website generation was left untouched.', {
            status: statuses.STOPPED,
            phase: 'stopped',
            lastError: null
          });
          this.logger?.warn?.('Run stopped by user. No website Stop/Cancel control was clicked.', { event: 'run.stopped' });
          return this.state;
        }

        this.logger?.error?.('A run-level error escaped prompt isolation. Every remaining prompt will be recorded as failed so the queue still reaches its terminal state.', {
          event: 'run.error_contained',
          error,
          diagnostic: this.diagnosticSnapshot('run-error-contained')
        });
        await this.failRemainingPrompts(error);
        return this.finishRunWithSummary();
      }
    }

    async finishRunWithSummary() {
      await this.checkpoint.finish();
      const successful = Number(this.checkpoint.data.successfulCount || 0);
      const failed = Number(this.checkpoint.data.failedCount || 0);
      const total = Number(this.checkpoint.data.total || 0);
      const summary = `Processed all ${total} prompts: ${successful} succeeded and ${failed} failed.`;
      this.emit(summary, {
        status: statuses.COMPLETED,
        phase: 'completed',
        current: total,
        total,
        completedCount: total,
        processedCount: total,
        successfulCount: successful,
        failedCount: failed,
        currentPrompt: null,
        lastError: null
      });
      this.logger?.info?.(summary, {
        event: 'run.completed',
        runId: this.checkpoint.data.runId,
        total,
        successful,
        failed
      });
      return this.state;
    }

    async failRemainingPrompts(error) {
      const reason = error?.message || String(error || 'Unexpected run-level error.');
      while (this.checkpoint.data.currentIndex < this.checkpoint.data.total) {
        const job = this.checkpoint.currentJob;
        await this.checkpoint.markFailedAndAdvance({
          status: 'failed',
          failureType: error?.code || 'run-level-error',
          reason: `Prompt could not be processed after a run-level error: ${reason}`,
          error: utils.errorToObject(error)
        });
        this.logger?.error?.('Prompt recorded as failed after a contained run-level error.', {
          event: 'prompt.failed_after_run_error',
          ...this.promptLogMeta(job),
          reason
        });
      }
    }

    async preparePageForRun() {
      const currentJob = this.checkpoint.currentJob;
      if (this.shouldResumeSubmittedJob(currentJob)) {
        this.logger?.info?.('A submitted prompt is being resumed. Skipping both the input-ready and idle-composer gates so the existing generation can be observed immediately.', {
          ...this.promptLogMeta(currentJob),
          jobStatus: currentJob.status,
          jobPhase: currentJob.phase
        }, 'resume.skip_composer_gates');
        return;
      }

      this.checkpoint.patchRun({ status: statuses.PREPARING, phase: 'waiting-for-input' }, 'run.waiting_for_input');
      await this.checkpoint.save('run.waiting_for_input');
      this.emitCheckpoint(`Waiting for ${this.config.name} prompt input.`, {
        status: statuses.PREPARING,
        phase: 'waiting-for-input'
      });
      await this.waitForInputReady(() => this.getNumberSetting('generationTimeoutMs', 300000, 1000));

      this.emitCheckpoint(`Waiting for ${this.config.name} to be idle before setup.`, {
        status: statuses.PREPARING,
        phase: 'waiting-for-ready'
      });
      await this.waitForPromptEntryReady(
        this.checkpoint.data.currentIndex,
        this.checkpoint.data.total,
        () => this.getNumberSetting('generationTimeoutMs', 300000, 1000)
      );
      await this.runPreRunSteps();
    }

    async preparePageForRunReliably() {
      let cycle = 0;
      while (true) {
        this.assertNotStopped();
        try {
          await this.preparePageForRun();
          if (cycle > 0) {
            this.logger?.info?.('The page recovered and is ready to continue the queue.', {
              event: 'setup.recovered',
              cycle,
              diagnostic: this.diagnosticSnapshot('setup-recovered')
            });
          }
          return;
        } catch (error) {
          this.assertNotStopped();
          cycle += 1;
          const configuredRetries = this.settings.retry?.enabled === true
            ? Math.floor(this.getNumberSetting('retry.maxPromptRetries', 0, 0))
            : 0;
          if (cycle > configuredRetries) {
            error.code = error.code || 'PAGE_SETUP_FAILED';
            throw error;
          }

          this.checkpoint.patchRun({
            status: statuses.RECOVERING,
            phase: 'setup-retry',
            lastError: error.message || String(error)
          }, 'run.setup_retry');
          await this.checkpoint.save('run.setup_retry');
          const initialBackoff = this.getNumberSetting('retry.initialBackoffMs', 5000, 0);
          const maxBackoff = Math.max(initialBackoff, this.getNumberSetting('retry.maxBackoffMs', 60000, 0));
          const backoffMs = Math.min(maxBackoff, initialBackoff * Math.pow(2, Math.max(0, cycle - 1)));
          this.emitCheckpoint(`Page setup was not ready. Retry ${cycle}/${configuredRetries} starts in ${Math.ceil(backoffMs / 1000)}s.`, {
            status: statuses.RECOVERING,
            phase: 'setup-retry',
            setupRetryCycle: cycle,
            setupRetryBackoffMs: backoffMs,
            lastError: error.message || String(error)
          });
          this.logger?.warn?.('Page setup/readiness failed. Retrying before prompt processing.', {
            event: 'setup.retry_scheduled',
            cycle,
            retryLimit: configuredRetries,
            backoffMs,
            error,
            diagnostic: this.diagnosticSnapshot('setup-retry')
          });

          const backoffStarted = Date.now();
          while (true) {
            this.assertNotStopped();
            const initial = this.getNumberSetting('retry.initialBackoffMs', 5000, 0);
            const maximum = Math.max(initial, this.getNumberSetting('retry.maxBackoffMs', 60000, 0));
            const currentBackoff = Math.min(maximum, initial * Math.pow(2, Math.max(0, cycle - 1)));
            const elapsed = Date.now() - backoffStarted;
            if (elapsed >= currentBackoff) break;
            await utils.sleepWithSignal(Math.min(250, Math.max(1, currentBackoff - elapsed)), this.signal);
          }
          if ((this.config.selectors?.newChat || []).length) {
            try {
              await this.recovery.openNewChat(`Recovering page readiness before prompt ${this.checkpoint.data.currentIndex + 1}`, { prepare: false });
            } catch (navigationError) {
              this.logger?.warn?.('Safe New chat recovery was unavailable during page setup retry.', {
                event: 'setup.new_chat_recovery_failed',
                cycle,
                error: navigationError,
                diagnostic: this.diagnosticSnapshot('setup-new-chat-failed')
              });
            }
          }
        }
      }
    }

    async processCurrentJob(job) {
      const resumeSubmittedJob = this.shouldResumeSubmittedJob(job);
      if (!resumeSubmittedJob) await this.checkpoint.beginJob();
      this.setPromptLogContext(job, resumeSubmittedJob ? 'resume-observation' : 'preparing');

      if (resumeSubmittedJob) {
        let resumedOutcome;
        try {
          resumedOutcome = await this.resumeInterruptedJob(job);
        } catch (error) {
          if (/Stopped by user/i.test(error.message)) throw error;
          resumedOutcome = {
            status: 'failed',
            failureType: error.code || 'resume-verification-error',
            reason: `Interrupted-prompt verification failed: ${error.message}`,
            error: utils.errorToObject(error)
          };
          this.logger?.warn?.('Interrupted-prompt verification failed.', {
            event: 'resume.verification_error',
            ...this.promptLogMeta(job),
            error,
            diagnostic: this.diagnosticSnapshot('resume-verification-error')
          });
        }
        if (resumedOutcome?.status === 'completed') {
          await this.completeJob(job, resumedOutcome);
          return;
        }
        const resumedAction = await this.handleFailedOutcome(job, resumedOutcome || {
          status: 'failed',
          reason: 'The interrupted attempt could not be verified after resume.'
        });
        if (resumedAction === 'advanced') return;
      }

      while (true) {
        this.assertNotStopped();
        job = this.checkpoint.currentJob;
        const attempt = await this.checkpoint.beginAttempt();
        this.setPromptLogContext(job, 'attempt-started');
        this.emitCheckpoint(`Processing prompt ${job.index + 1}/${this.checkpoint.data.total}, attempt ${attempt}.`, {
          status: statuses.RUNNING,
          phase: 'attempt-started',
          promptAttempt: attempt
        });
        this.logger?.info?.(`Starting prompt attempt ${attempt}.`, {
          event: 'prompt.attempt_started',
          ...this.promptLogMeta(job)
        });

        try {
          await this.maybeStartScheduledNewChat(job);
          const baseline = this.monitor.snapshot();
          const chatContextBeforeSubmit = this.recovery.captureChatContext();
          this.checkpoint.patchJob({
            baseline,
            chatContextBeforeSubmit,
            chatContext: chatContextBeforeSubmit,
            phase: 'baseline-captured'
          }, 'prompt.baseline_captured');
          await this.checkpoint.save('prompt.baseline_captured');

          const submissionEvidence = await this.submitPromptReliably(
            job.prompt,
            job.index,
            this.checkpoint.data.total,
            baseline,
            job
          );

          await this.checkpoint.markSubmitted({
            baseline,
            chatContextBeforeSubmit,
            chatContext: chatContextBeforeSubmit,
            submissionEvidence
          });
          const chatContext = await this.recovery.captureSubmittedChatContext(chatContextBeforeSubmit);
          this.checkpoint.patchJob({ chatContext }, 'prompt.chat_context_updated');
          await this.checkpoint.save('prompt.chat_context_updated');
          job = this.checkpoint.currentJob;
          this.setPromptLogContext(job, 'waiting-for-generation');

          const outcome = await this.observeCurrentAttempt(job, baseline, {
            timeoutSettingPath: 'generationTimeoutMs',
            timeoutFallback: 300000,
            minimumTimeout: 1000,
            phase: 'generation'
          });

          let resolved = outcome;
          if (outcome.status === 'timeout') {
            resolved = this.canRetryCurrentJob(job)
              ? await this.recoverTimedOutAttempt(job, baseline, outcome)
              : { ...outcome, status: 'failed', failureType: outcome.failureType || 'generation-timeout' };
          }

          if (resolved.status === 'completed') {
            await this.completeJob(job, resolved);
            return;
          }

          const action = await this.handleFailedOutcome(job, resolved);
          if (action === 'advanced') return;
        } catch (error) {
          if (/Stopped by user/i.test(error.message)) throw error;
          this.logger?.warn?.('Prompt attempt failed. The outcome will be logged and either retried within the configured limit or advanced.', {
            event: 'prompt.attempt_error',
            ...this.promptLogMeta(job),
            error
          });
          const action = await this.handleFailedOutcome(job, {
            status: 'failed',
            failureType: error.code || 'automation-error',
            reason: error.message || String(error),
            error: utils.errorToObject(error)
          });
          if (action === 'advanced') return;
        }
      }
    }

    async handleFailedOutcome(job, outcome) {
      this.assertNotStopped();
      if (this.canRetryCurrentJob(job)) {
        await this.prepareRetry(job, outcome);
        return 'retry';
      }
      await this.failJobAndContinue(job, outcome);
      return 'advanced';
    }

    async failJobAndContinue(job, outcome) {
      const reason = outcome?.reason || 'The site did not produce a verified image for this prompt.';
      const failedNumber = job.index + 1;
      await this.checkpoint.markFailedAndAdvance({
        ...outcome,
        status: 'failed',
        reason
      });
      const nextNumber = this.checkpoint.data.currentIndex + 1;
      const hasNext = this.checkpoint.data.currentIndex < this.checkpoint.data.total;
      this.emitCheckpoint(
        hasNext
          ? `Prompt ${failedNumber}/${this.checkpoint.data.total} failed: ${reason} Continuing with prompt ${nextNumber}/${this.checkpoint.data.total}.`
          : `Prompt ${failedNumber}/${this.checkpoint.data.total} failed: ${reason} All prompts have now been processed.`,
        {
          status: hasNext ? statuses.RUNNING : statuses.COMPLETED,
          phase: 'prompt-failed-continued',
          current: hasNext ? nextNumber : this.checkpoint.data.total,
          completedCount: this.checkpoint.data.completedCount,
          processedCount: this.checkpoint.data.processedCount,
          successfulCount: this.checkpoint.data.successfulCount,
          failedCount: this.checkpoint.data.failedCount,
          currentPrompt: null,
          lastError: null
        }
      );
      this.logger?.error?.('Prompt failed and was advanced so the remaining queue can continue.', {
        event: 'prompt.failed_continued',
        ...this.promptLogMeta(job),
        failureType: outcome?.failureType || null,
        reason,
        processedCount: this.checkpoint.data.processedCount,
        successfulCount: this.checkpoint.data.successfulCount,
        failedCount: this.checkpoint.data.failedCount,
        nextIndex: this.checkpoint.data.currentIndex
      });

      if (hasNext) await this.prepareComposerAfterFailure(job, reason);
    }

    async prepareComposerAfterFailure(job, reason) {
      try {
        const state = this.getExecutionState();
        if (state.inputReady || state.readyForEntry) return;
        await this.waitForPromptEntryReady(
          this.checkpoint.data.currentIndex,
          this.checkpoint.data.total,
          () => this.getNumberSetting('failureHandling.composerRecoveryTimeoutMs', 8000, 1000)
        );
        return;
      } catch (error) {
        if (/Stopped by user/i.test(error.message)) throw error;
        this.logger?.warn?.('The composer remained blocked after a failed prompt.', {
          event: 'prompt.failure_composer_blocked',
          ...this.promptLogMeta(job),
          reason,
          error
        });
      }

      if (this.settings.failureHandling?.openNewChatWhenComposerIsBlocked !== false && (this.config.selectors?.newChat || []).length) {
        try {
          await this.recovery.openNewChat(`Continuing after failed prompt ${job.index + 1}`, { prepare: false });
          await this.runPreRunSteps();
        } catch (error) {
          if (/Stopped by user/i.test(error.message)) throw error;
          this.logger?.warn?.('Could not open a fresh chat after the failed prompt. The next prompt will perform its own readiness check.', {
            event: 'prompt.failure_new_chat_unavailable',
            ...this.promptLogMeta(job),
            error
          });
        }
      }
    }

    shouldResumeSubmittedJob(job) {
      return Boolean(
        this.resumeCheckpoint
        && job
        && job.baseline
        && ['submission-armed', 'submission-dispatched', 'submitted', 'recovering'].includes(job.status)
        && ['submission-armed', 'submission-dispatched', 'waiting-for-generation', 'recovering'].includes(job.phase)
      );
    }

    async resumeInterruptedJob(job) {
      this.setPromptLogContext(job, 'resume-observation');
      this.emitCheckpoint(`Checking interrupted prompt ${job.index + 1}/${this.checkpoint.data.total} before any retry.`, {
        status: statuses.RECOVERING,
        phase: 'resume-observation'
      });
      this.logger?.warn?.('A durable checkpoint shows that this prompt reached or may have reached the irreversible submission boundary. Prompt Pilot will verify the existing chat before resubmitting anything.', {
        event: 'resume.submitted_prompt_detected',
        ...this.promptLogMeta(job),
        jobStatus: job.status,
        jobPhase: job.phase,
        currentUrl: global.location?.href || '',
        originalChat: job.chatContext,
        diagnostic: this.diagnosticSnapshot('resume-begin')
      });

      const currentContext = this.recovery.captureChatContext({ silent: true });
      const storedPersistentContext = job.chatContext?.persistent
        ? job.chatContext
        : (job.chatContextBeforeSubmit?.persistent ? job.chatContextBeforeSubmit : null);

      if (storedPersistentContext?.pathKey && currentContext.pathKey !== storedPersistentContext.pathKey) {
        try {
          await this.recovery.reopenOriginalChat(storedPersistentContext);
        } catch (error) {
          this.logger?.warn?.('Could not reopen the exact original chat during resume. The attempt will be treated as unverified and will follow the configured finite retry-or-continue policy.', {
            event: 'resume.reopen_failed',
            error,
            originalChat: storedPersistentContext,
            diagnostic: this.diagnosticSnapshot('resume-reopen-failed')
          });
          return {
            status: 'failed',
            failureType: 'resume-original-chat-unavailable',
            reason: `The exact original chat could not be reopened after interruption: ${error.message}`
          };
        }
      } else if (!storedPersistentContext && currentContext.persistent) {
        const checkpointPath = pathKey(this.checkpoint.data.pageUrl || '');
        const currentMatchesCheckpoint = Boolean(checkpointPath && checkpointPath === currentContext.pathKey);
        const promptVisible = this.pageLikelyContainsPrompt(job.prompt);
        if (!currentMatchesCheckpoint && !promptVisible) {
          this.logger?.warn?.('The interrupted prompt had no confirmed persistent chat identity, and the current page cannot be safely correlated to it. It will follow the configured finite retry-or-continue policy instead of risking a false completion.', {
            event: 'resume.chat_identity_unverified',
            ...this.promptLogMeta(job),
            checkpointPageUrl: this.checkpoint.data.pageUrl || null,
            currentContext,
            diagnostic: this.diagnosticSnapshot('resume-identity-unverified')
          });
          return {
            status: 'failed',
            failureType: 'resume-chat-identity-unverified',
            reason: 'The current chat could not be safely correlated with the interrupted prompt.'
          };
        }
        this.checkpoint.patchJob({ chatContext: currentContext }, 'resume.chat_context_adopted');
        await this.checkpoint.save('resume.chat_context_adopted');
        job = this.checkpoint.currentJob;
        this.logger?.info?.('Adopted the current persistent chat identity for interrupted-prompt verification.', {
          event: 'resume.chat_context_adopted',
          ...this.promptLogMeta(job),
          currentMatchesCheckpoint,
          promptVisible,
          chatContext: currentContext
        });
      }

      const outcome = await this.observeCurrentAttempt(job, job.baseline, {
        timeoutSettingPath: 'recovery.resumeObservationMs',
        timeoutFallback: 30000,
        minimumTimeout: 5000,
        phase: 'resume-observation'
      });
      if (outcome.status !== 'timeout') return outcome;

      try {
        return await this.recoverTimedOutAttempt(job, job.baseline, outcome);
      } catch (error) {
        this.logger?.warn?.('The interrupted attempt timed out and its original chat could not be reloaded safely. It will follow the configured finite retry-or-continue policy.', {
          event: 'resume.timeout_recovery_unavailable',
          ...this.promptLogMeta(job),
          error,
          diagnostic: this.diagnosticSnapshot('resume-timeout-recovery-unavailable')
        });
        return {
          ...outcome,
          status: 'failed',
          failureType: error.code || 'resume-timeout-recovery-unavailable',
          reason: `The interrupted attempt remained unverified and safe chat reload was unavailable: ${error.message}`,
          error: { name: error.name, message: error.message, stack: error.stack || null }
        };
      }
    }

    async observeCurrentAttempt(job, baseline, options) {
      const timeoutProvider = typeof options?.timeout === 'function'
        ? options.timeout
        : options?.timeoutSettingPath
          ? () => this.getNumberSetting(options.timeoutSettingPath, options.timeoutFallback || 300000, options.minimumTimeout || 1000)
          : options?.timeout != null
            ? () => Math.max(Number(options.minimumTimeout || 1000), Number(options.timeout || 0))
            : () => this.getNumberSetting('generationTimeoutMs', 300000, 1000);
      const requireImage = this.settings.waitForImageAfterSubmit !== false || Boolean(this.settings.download?.enabled);
      this.emitCheckpoint(`Waiting for verified completion of prompt ${job.index + 1}/${this.checkpoint.data.total}.`, {
        status: options?.phase === 'resume-observation' ? statuses.RECOVERING : statuses.RUNNING,
        phase: options?.phase || 'waiting-for-generation'
      });
      const outcome = await this.monitor.observe(baseline, {
        timeout: timeoutProvider,
        requireImage,
        idleSettleMs: () => this.getNumberSetting('idleSettleMs', 750, 0),
        noImageFailureGraceMs: () => this.getNumberSetting('noImageFailureGraceMs', 8000, 500),
        pollIntervalMs: () => this.getNumberSetting('pollIntervalMs', 500, 100),
        expectedPathKey: job.chatContext?.persistent ? job.chatContext.pathKey : null
      });
      this.logger?.info?.(`Generation observation ended with status: ${outcome.status}.`, {
        event: `generation.${outcome.status}`,
        ...this.promptLogMeta(job),
        outcome: {
          status: outcome.status,
          reason: outcome.reason,
          elapsedMs: outcome.elapsedMs,
          sawBusy: outcome.sawBusy,
          sawNewImage: outcome.sawNewImage,
          sawImageCountIncrease: outcome.sawImageCountIncrease,
          sawResponseChange: outcome.sawResponseChange,
          stillBusy: outcome.stillBusy,
          composerReady: outcome.composerReady,
          baselineImageCount: outcome.evidence?.baselineImageCount,
          currentImageCount: outcome.evidence?.currentImageCount,
          imageCountDelta: outcome.evidence?.imageCountDelta
        }
      });
      return outcome;
    }

    async recoverTimedOutAttempt(job, baseline, timeoutOutcome) {
      if (this.getSetting('recovery.enabled', true) === false || this.getSetting('recovery.reloadTimedOutChat', true) === false) {
        return {
          ...timeoutOutcome,
          status: 'failed',
          failureType: 'timeout-recovery-disabled',
          reason: `${timeoutOutcome.reason} Timeout reload recovery is disabled.`
        };
      }
      if (this.getSetting('autoResume', true) === false) {
        return {
          ...timeoutOutcome,
          status: 'failed',
          failureType: 'timeout-recovery-auto-resume-disabled',
          reason: `${timeoutOutcome.reason} Navigation-based timeout recovery was skipped because automatic checkpoint resume is disabled.`
        };
      }

      let lastOutcome = timeoutOutcome;
      let cycle = 1;
      let cyclesAttempted = 0;
      while (cycle <= this.getNumberSetting('recovery.maxReloadCyclesPerAttempt', 2, 1)) {
        this.assertNotStopped();
        const maxCycles = this.getNumberSetting('recovery.maxReloadCyclesPerAttempt', 2, 1);
        cyclesAttempted = cycle;
        await this.checkpoint.markRecovering(timeoutOutcome.reason);
        this.setPromptLogContext(job, 'recovering');
        this.emitCheckpoint(`Timeout recovery ${cycle}/${maxCycles}: New chat → reopen original chat.`, {
          status: statuses.RECOVERING,
          phase: 'timeout-reload',
          recoveryCycle: cycle,
          recoveryCycleTotal: maxCycles
        });
        this.logger?.warn?.(`Starting timeout reload cycle ${cycle}/${maxCycles}.`, {
          event: 'recovery.cycle_started',
          ...this.promptLogMeta(job),
          cycle,
          maxCycles,
          timeoutOutcome: {
            reason: timeoutOutcome.reason,
            sawBusy: timeoutOutcome.sawBusy,
            sawNewImage: timeoutOutcome.sawNewImage,
            sawResponseChange: timeoutOutcome.sawResponseChange,
            stillBusy: timeoutOutcome.stillBusy
          }
        });

        await this.recovery.reloadTimedOutChat(job.chatContext || this.recovery.captureChatContext(), timeoutOutcome.reason);
        lastOutcome = await this.observeCurrentAttempt(job, baseline, {
          timeoutSettingPath: 'recovery.postReloadObservationMs',
          timeoutFallback: 45000,
          minimumTimeout: 5000,
          phase: 'post-reload-observation'
        });

        if (lastOutcome.status === 'completed') {
          this.logger?.info?.('The original chat completed after non-destructive timeout reload recovery.', {
            event: 'recovery.completed_original_attempt',
            ...this.promptLogMeta(job),
            cycle
          });
          return lastOutcome;
        }
        if (lastOutcome.status === 'failed') {
          this.logger?.warn?.('The reopened original chat reported a failed/no-image result. The outcome will follow the configured retry-or-continue policy.', {
            event: 'recovery.original_attempt_failed',
            ...this.promptLogMeta(job),
            cycle,
            reason: lastOutcome.reason
          });
          return lastOutcome;
        }

        this.logger?.warn?.('The original chat still did not reach verified completion after reload observation.', {
          event: 'recovery.cycle_inconclusive',
          ...this.promptLogMeta(job),
          cycle,
          outcome: lastOutcome
        });
        cycle += 1;
      }

      return {
        ...lastOutcome,
        status: 'failed',
        failureType: 'timeout-after-reload',
        reason: `The prompt remained unresolved after ${cyclesAttempted} non-destructive chat reload cycle${cyclesAttempted === 1 ? '' : 's'}.`
      };
    }

    async prepareRetry(job, outcome) {
      this.assertNotStopped();
      if (!this.canRetryCurrentJob(job)) return false;
      const retriesAllowed = Math.floor(this.getNumberSetting('retry.maxPromptRetries', 0, 0));
      const rawAttemptsCompleted = Number(job.attempt || 1);
      const attemptsCompleted = Math.max(1, Number.isFinite(rawAttemptsCompleted) ? rawAttemptsCompleted : 1);

      await this.checkpoint.markRetry(outcome?.reason || 'Prompt attempt failed.', outcome || null);
      this.setPromptLogContext(job, 'retrying');
      const backoffMs = this.retryBackoffDuration(job);
      this.logger?.warn?.('Scheduling a configured retry for the same prompt.', {
        event: 'prompt.retry_scheduled',
        ...this.promptLogMeta(job),
        reason: outcome?.reason || 'Unknown failure',
        failureType: outcome?.failureType || null,
        backoffMs,
        retriesAllowed,
        attemptsCompleted
      });

      await this.retryBackoff(job);

      if (this.settings.retry?.startRetryInNewChat !== false && (this.config.selectors?.newChat || []).length) {
        try {
          await this.recovery.openNewChat(`Retrying failed prompt ${job.index + 1}, attempt ${attemptsCompleted + 1}`);
        } catch (error) {
          this.logger?.warn?.('Could not open a fresh chat for retry; the same prompt will retry in the current chat after readiness checks.', {
            event: 'prompt.retry_new_chat_failed',
            ...this.promptLogMeta(job),
            error
          });
        }
      }
      return true;
    }

    async completeJob(job, outcome) {
      this.setPromptLogContext(job, 'completing');
      if (this.settings.download?.enabled) {
        try {
          await this.downloadGeneratedImage(job.prompt, job.index, this.checkpoint.data.total);
        } catch (error) {
          if (/Stopped by user/i.test(error.message || '')) throw error;
          // Image creation has already been verified. A download subsystem defect must never
          // resubmit the prompt, mark the image generation as failed, or halt the remaining queue.
          this.logger?.warn?.(`Generation succeeded, but the optional download step failed: ${error.message}`, {
            event: 'download.unexpected_failure_contained',
            ...this.promptLogMeta(job),
            error
          });
        }
      }
      await this.checkpoint.markComplete(outcome);
      this.emitCheckpoint(`Prompt ${job.index + 1}/${this.checkpoint.data.total} completed.`, {
        status: this.checkpoint.data.currentIndex >= this.checkpoint.data.total ? statuses.COMPLETED : statuses.RUNNING,
        phase: 'prompt-completed',
        current: this.checkpoint.data.currentIndex,
        completedCount: this.checkpoint.data.completedCount,
        processedCount: this.checkpoint.data.processedCount,
        successfulCount: this.checkpoint.data.successfulCount,
        failedCount: this.checkpoint.data.failedCount,
        currentPrompt: null,
        lastError: null
      });
      this.logger?.info?.('Prompt reached verified completion and the queue advanced by one item.', {
        event: 'prompt.completed',
        ...this.promptLogMeta(job),
        outcome: {
          reason: outcome?.reason,
          elapsedMs: outcome?.elapsedMs,
          sawBusy: outcome?.sawBusy,
          sawNewImage: outcome?.sawNewImage,
          sawImageCountIncrease: outcome?.sawImageCountIncrease,
          sawResponseChange: outcome?.sawResponseChange,
          baselineImageCount: outcome?.evidence?.baselineImageCount,
          currentImageCount: outcome?.evidence?.currentImageCount,
          imageCountDelta: outcome?.evidence?.imageCountDelta
        },
        nextIndex: this.checkpoint.data.currentIndex
      });
    }

    retryBackoffDuration(job) {
      const initialBackoff = this.getNumberSetting('retry.initialBackoffMs', 5000, 0);
      const maxBackoff = Math.max(initialBackoff, this.getNumberSetting('retry.maxBackoffMs', 60000, 0));
      const rawAttemptsCompleted = Number(job?.attempt || 1);
      const attemptsCompleted = Math.max(1, Number.isFinite(rawAttemptsCompleted) ? rawAttemptsCompleted : 1);
      return Math.min(maxBackoff, initialBackoff * Math.pow(2, Math.max(0, attemptsCompleted - 1)));
    }

    async retryBackoff(job) {
      const started = Date.now();
      while (true) {
        this.assertNotStopped();
        const currentBackoffMs = this.retryBackoffDuration(job);
        const elapsed = Date.now() - started;
        if (elapsed >= currentBackoffMs) return;
        const remaining = Math.max(0, currentBackoffMs - elapsed);
        this.emitCheckpoint(`Retrying prompt ${job.index + 1}/${this.checkpoint.data.total} in ${Math.ceil(remaining / 1000)}s.`, {
          status: statuses.RETRYING,
          phase: 'retry-backoff',
          retryRemainingMs: remaining,
          retryTotalMs: currentBackoffMs
        });
        await utils.sleepWithSignal(Math.min(500, remaining || 1), this.signal);
      }
    }

    async waitForInputReady(timeoutOverride) {
      const timeoutProvider = typeof timeoutOverride === 'function'
        ? timeoutOverride
        : timeoutOverride != null
          ? () => Number(timeoutOverride)
          : () => this.getNumberSetting('readyTimeoutMs', 30000, 1000);
      return dom.waitFor(() => this.getInput(), {
        timeout: timeoutProvider,
        interval: () => this.getNumberSetting('pollIntervalMs', 500, 100),
        name: `${this.config.name} prompt input`,
        signal: this.signal
      });
    }

    getInput() {
      if (this.settings.adaptiveDomSearch !== false || this.config.adaptiveSelectors) {
        return dom.findLikelyPromptInput(this.config);
      }
      return dom.findFirst(this.config.selectors?.input || [], {
        predicate: element => !dom.isDisabled(element)
      });
    }

    getSearchScopes(input) {
      return dom.nearestSearchScopes(input, this.config.selectors?.inputContainers || []);
    }

    getConfiguredSubmitButton(input, excludePatterns) {
      const selectors = this.config.selectors || {};
      const exclude = excludePatterns || (dom.mergeSubmitExcludePatterns ? dom.mergeSubmitExcludePatterns(selectors) : (selectors.submitExcludeTextPatterns || []));
      const predicate = element => dom.isSafeSubmitControl(element, exclude);
      const scopes = this.getSearchScopes(input);

      for (const scope of scopes) {
        const direct = dom.findFirst(selectors.submit || [], { root: scope, predicate });
        if (direct) return dom.buttonLike(direct) || direct;
        const byText = dom.findByText(['button', 'a', '[role="button"]', '[role="menuitem"]', 'input[type="submit"]', 'mat-icon', 'svg'], selectors.submitTextPatterns || [], {
          root: scope,
          excludeTextPatterns: exclude,
          predicate
        });
        if (byText && dom.isSafeSubmitControl(byText, exclude)) return byText;
      }

      if (this.settings.adaptiveDomSearch !== false || this.config.adaptiveSelectors) {
        return dom.findLikelySubmitButton(input, selectors);
      }
      return null;
    }

    getSubmitButton(input) {
      const selectors = this.config.selectors || {};
      const exclude = dom.mergeSubmitExcludePatterns ? dom.mergeSubmitExcludePatterns(selectors) : (selectors.submitExcludeTextPatterns || []);

      if (this.usesStrictComposerGate()) {
        const geminiSubmit = this.getGeminiSubmitButton(input, exclude);
        if (geminiSubmit) return geminiSubmit;
        return null;
      }

      return this.getConfiguredSubmitButton(input, exclude);
    }

    usesStrictComposerGate() {
      return this.config?.id === 'gemini';
    }

    getGeminiComposerScopes(input) {
      const scopes = [];
      const seen = new Set();
      const add = element => {
        if (!element || seen.has(element) || dom.isOwnElement?.(element)) return;
        seen.add(element);
        scopes.push(element);
      };

      const currentInput = input || this.getInput();
      const preferredContainers = [
        'input-area-v2',
        'rich-textarea',
        '[data-test-id="input-area"]',
        '[data-test-id="textarea"]',
        '.input-area-container',
        '.composer-container',
        'form'
      ];

      for (const selector of preferredContainers) {
        try { add(currentInput?.closest?.(selector)); } catch (_) {}
      }

      let ancestor = currentInput?.parentElement || null;
      for (let depth = 0; ancestor && ancestor !== document.body && depth < 10; depth += 1, ancestor = ancestor.parentElement) {
        try {
          if (ancestor.querySelector?.('[data-test-id="send-button-container"], gem-icon-button.send-button, .send-button')) add(ancestor);
        } catch (_) {}
      }

      add(currentInput?.parentElement);
      if (scopes.length) return scopes;
      return this.getSearchScopes(currentInput).filter(scope => scope !== document && !scope.matches?.('main, [role="main"]'));
    }

    getGeminiStopControl(input) {
      if (!this.usesStrictComposerGate()) return null;
      const selectors = this.config.selectors || {};
      const stopSelectors = [
        ...(selectors.stop || []),
        '[data-test-id="send-button-container"].visible gem-icon-button.send-button.stop button[aria-label*="Stop" i]',
        '[data-test-id="send-button-container"].visible gem-icon-button.send-button.stop button',
        '[data-test-id="send-button-container"].visible .send-button.stop button',
        '[data-test-id="send-button-container"] gem-icon-button.send-button.stop button[aria-label*="Stop" i]',
        '[data-test-id="send-button-container"] .send-button.stop button[aria-label*="Stop" i]',
        'gem-icon-button.send-button.stop button[aria-label*="Stop" i]',
        'gem-icon-button.send-button.stop button',
        '.send-button.stop button[aria-label*="Stop" i]',
        'button[aria-label="Stop response"]',
        'button[aria-label*="Stop response" i]',
        'button[aria-label*="Stop generating" i]',
        'button[aria-label*="Cancel response" i]'
      ];
      const predicate = element => {
        const control = dom.buttonLike(element) || element;
        const combinedName = `${dom.accessibleName(control)} ${dom.accessibleName(element)}`;
        const classIdentity = `${control?.className || ''} ${element?.className || ''}`;
        const stopWrapper = control?.closest?.('gem-icon-button.send-button.stop, .send-button.stop')
          || element?.closest?.('gem-icon-button.send-button.stop, .send-button.stop');
        return Boolean(
          control
          && dom.isVisible(control)
          && (/stop|cancel/i.test(combinedName) || /(^|\s)stop(\s|$)/i.test(classIdentity) || stopWrapper)
        );
      };

      const scopes = this.getGeminiComposerScopes(input);
      // Observation is safe even when the prompt input is temporarily absent/disabled. Use the
      // document only for detecting Stop/Cancel state; submit discovery never receives this fallback.
      if (!scopes.length) scopes.push(document);
      for (const scope of scopes) {
        const match = dom.findFirst(stopSelectors, { root: scope, predicate });
        if (match) return dom.buttonLike(match) || match;
      }
      return null;
    }

    getGeminiThinkingOverlay() {
      if (!this.usesStrictComposerGate()) return null;
      const selectors = this.config.selectors || {};
      return dom.findFirst([
        ...(selectors.thinking || []),
        'thinking-overlay',
        'thinking-overlay [data-test-id="thinking-overlay-content"]',
        '[data-test-id="thinking-overlay-content"]'
      ], { predicate: element => dom.isVisible(element) });
    }

    getGeminiSubmitButton(input, excludePatterns) {
      if (!this.usesStrictComposerGate()) return null;
      const currentInput = input || this.getInput();
      if (!currentInput || !dom.isVisible(currentInput) || dom.isDisabled(currentInput)) return null;

      const selectors = this.config.selectors || {};
      const exclude = excludePatterns || (dom.mergeSubmitExcludePatterns ? dom.mergeSubmitExcludePatterns(selectors) : (selectors.submitExcludeTextPatterns || []));
      const submitSelectors = [
        ...(selectors.readySubmit || []),
        '[data-test-id="send-button-container"].visible gem-icon-button.send-button.submit button',
        '[data-test-id="send-button-container"].visible .send-button.submit button',
        '[data-test-id="send-button-container"].visible gem-icon-button.send-button:not(.stop) button[aria-label*="Send" i]',
        '[data-test-id="send-button-container"] gem-icon-button.send-button.submit button',
        '[data-test-id="send-button-container"] .send-button.submit button',
        'gem-icon-button.send-button.submit button',
        'gem-icon-button.send-button:not(.stop) button[aria-label*="Send" i]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send message" i]',
        'button[aria-label*="Send" i]'
      ];
      const predicate = element => {
        const control = dom.buttonLike(element) || element;
        return Boolean(control && dom.isPositiveSubmitControl(control, selectors.submitTextPatterns || [], exclude));
      };

      for (const scope of this.getGeminiComposerScopes(currentInput)) {
        const match = dom.findFirst(submitSelectors, { root: scope, predicate });
        if (match) return dom.buttonLike(match) || match;
      }
      return null;
    }

    isGenericBusy() {
      const selectors = this.config.selectors || {};
      const busySelectors = [
        ...(selectors.busy || []),
        ...(this.settings.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.busy || []) : [])
      ];
      const busyTextPatterns = [
        ...(selectors.busyTextPatterns || []),
        ...(this.settings.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.busyTextPatterns || []) : [])
      ];
      const direct = dom.findFirst(busySelectors, { predicate: element => dom.isVisible(element) });
      if (direct) return true;
      const byText = dom.findByText(['button', '[role="button"]', '[aria-live]', '[role="status"]'], busyTextPatterns, {
        predicate: element => dom.isVisible(element)
      });
      return Boolean(byText);
    }

    getExecutionState(input) {
      const currentInput = input || this.getInput();
      const inputReady = Boolean(currentInput && dom.isVisible(currentInput) && !dom.isDisabled(currentInput));
      const selectors = this.config.selectors || {};
      const exclude = dom.mergeSubmitExcludePatterns ? dom.mergeSubmitExcludePatterns(selectors) : (selectors.submitExcludeTextPatterns || []);
      let result;

      if (this.usesStrictComposerGate()) {
        const thinkingOverlay = this.getGeminiThinkingOverlay();
        const stopControl = this.getGeminiStopControl(currentInput);
        // A visible Stop control is authoritative. Gemini's thinking overlay can remain mounted
        // after generation, so it must not block a visibly enabled textarea or safe Send button.
        const hardBusy = Boolean(stopControl);
        const submitButton = inputReady && !hardBusy
          ? this.getGeminiSubmitButton(currentInput, exclude)
          : null;
        const busy = Boolean(hardBusy || (thinkingOverlay && !inputReady && !submitButton));
        let reason = 'ready';
        if (stopControl) reason = 'Stop/Cancel control is visible (observed only; never clicked)';
        else if (!inputReady) reason = thinkingOverlay ? 'prompt input is not ready while generation is active' : 'prompt input is not ready';
        else if (!submitButton) reason = thinkingOverlay
          ? 'textarea is ready; waiting only for the safe Send button'
          : 'enabled safe Submit button is not visible yet';
        else if (thinkingOverlay) reason = 'ready; ignoring a stale thinking overlay';
        result = {
          busy,
          reason,
          input: currentInput,
          inputReady,
          submitButton,
          readyForEntry: inputReady && !hardBusy,
          readyToSubmit: inputReady && Boolean(submitButton) && !hardBusy,
          stopControl,
          thinkingOverlay
        };
      } else {
        const busy = this.isGenericBusy();
        const submitButton = inputReady && !busy ? this.getConfiguredSubmitButton(currentInput, exclude) : null;
        result = {
          busy,
          reason: busy ? 'busy indicator is visible' : (inputReady ? (submitButton ? 'ready' : 'enabled safe Submit button is not visible yet') : 'prompt input is not ready'),
          input: currentInput,
          inputReady,
          submitButton,
          readyForEntry: inputReady && !busy,
          readyToSubmit: inputReady && Boolean(submitButton) && !busy,
          stopControl: null,
          thinkingOverlay: null
        };
      }

      const key = `${result.busy}|${result.inputReady}|${result.readyForEntry}|${result.readyToSubmit}|${result.reason}`;
      if (key !== this.lastExecutionStateKey) {
        this.logger?.debug?.('Composer execution state changed.', {
          event: 'composer.state_changed',
          busy: result.busy,
          inputReady: result.inputReady,
          readyForEntry: result.readyForEntry,
          readyToSubmit: result.readyToSubmit,
          reason: result.reason,
          submitButton: dom.describeElement?.(result.submitButton),
          observedStopControl: dom.describeElement?.(result.stopControl),
          thinkingOverlay: dom.describeElement?.(result.thinkingOverlay)
        });
        this.lastExecutionStateKey = key;
      }
      return result;
    }

    async waitForPromptEntryReady(index, total, timeout) {
      let lastLoggedReason = '';
      let lastLogAt = 0;
      let lastVerboseAt = 0;
      return dom.waitFor(() => {
        const state = this.getExecutionState();
        if (state.readyForEntry) return state.input;
        const now = Date.now();
        if (now - lastLogAt >= 2500 && state.reason !== lastLoggedReason) {
          this.logger?.info?.(`${this.config.name} is not ready for prompt ${index + 1}/${total} (${state.reason}). The same prompt remains current.`, {
            event: 'composer.entry_wait',
            index,
            total,
            reason: state.reason
          });
          lastLoggedReason = state.reason;
          lastLogAt = now;
        }
        if (now - lastVerboseAt >= Math.max(500, Number(this.settings.logging?.verbosePollIntervalMs || 2000))) {
          this.logger?.verbose?.('Waiting for composer entry readiness.', {
            event: 'composer.entry_poll',
            index,
            total,
            state: {
              busy: state.busy,
              inputReady: state.inputReady,
              readyForEntry: state.readyForEntry,
              reason: state.reason,
              observedStopControl: dom.describeElement?.(state.stopControl)
            }
          });
          lastVerboseAt = now;
        }
        return null;
      }, {
        timeout,
        interval: () => this.getNumberSetting('pollIntervalMs', 500, 100),
        name: 'enabled prompt textarea without an active Stop/Cancel control',
        signal: this.signal
      });
    }

    async waitForSubmitReady(input, expectedPrompt, index, total, timeout) {
      let lastLoggedReason = '';
      let lastLogAt = 0;
      let lastVerboseAt = 0;
      return dom.waitFor(() => {
        const currentInput = this.getInput() || input;
        const promptStillPresent = this.inputContainsExpectedPrompt(currentInput, expectedPrompt);
        if (!promptStillPresent) return null;

        const state = this.getExecutionState(currentInput);
        if (state.readyToSubmit) return state.submitButton;
        const now = Date.now();
        if (now - lastLogAt >= 2500 && state.reason !== lastLoggedReason) {
          this.logger?.info?.(`Prompt ${index + 1}/${total} is typed but not safely submittable (${state.reason}). It will not advance.`, {
            event: 'composer.submit_wait',
            reason: state.reason
          });
          lastLoggedReason = state.reason;
          lastLogAt = now;
        }
        if (now - lastVerboseAt >= Math.max(500, Number(this.settings.logging?.verbosePollIntervalMs || 2000))) {
          this.logger?.verbose?.('Waiting for safe Submit control.', {
            event: 'composer.submit_poll',
            promptStillPresent,
            state: {
              busy: state.busy,
              readyToSubmit: state.readyToSubmit,
              reason: state.reason,
              submitButton: dom.describeElement?.(state.submitButton),
              observedStopControl: dom.describeElement?.(state.stopControl)
            }
          });
          lastVerboseAt = now;
        }
        return null;
      }, {
        timeout,
        interval: () => this.getNumberSetting('pollIntervalMs', 500, 100),
        name: 'enabled safe Submit button without an active Stop/Cancel control',
        signal: this.signal
      });
    }

    async runPreRunSteps() {
      const steps = this.config.preRunSteps || [];
      for (const step of steps) {
        this.assertNotStopped();
        const enabled = this.siteOption(step.optionPath, step.defaultEnabled);
        if (!enabled) {
          this.logger?.debug?.(`Pre-run step skipped: ${step.label}.`, { event: 'setup.step_skipped', step: step.id });
          continue;
        }

        this.emitCheckpoint(`Preparing ${step.label}…`, { status: statuses.PREPARING, phase: 'site-setup' });
        try {
          if (step.kind === 'toggle') await this.runToggleStep(step);
          else if (step.kind === 'menu-select') await this.runMenuSelectStep(step);
        } catch (error) {
          this.logger?.warn?.(`Pre-run step failed: ${step.label}. ${error.message}`, {
            event: 'setup.step_failed',
            step: step.id,
            error
          });
          if (step.optional !== true) {
            const setupError = new Error(`Required setup step "${step.label}" could not be verified: ${error.message}`);
            setupError.code = 'REQUIRED_SETUP_STEP_FAILED';
            setupError.cause = error;
            throw setupError;
          }
        }
      }
    }

    async openStepMenu(step) {
      const targetAlreadyVisible = this.findStepTarget(step);
      if (targetAlreadyVisible) return targetAlreadyVisible;
      const opener = dom.findFirst(step.openerSelectors || [], { predicate: element => !dom.isDisabled(element) && !dom.isUnsafeSubmitControl(element) });
      if (!opener) throw new Error(`Could not find safe opener for ${step.label}.`);
      if (!dom.safeClick(opener, { logger: this.logger, purpose: `setup-open-${step.id}`, throwOnUnsafe: true })) {
        throw new Error(`Could not click opener for ${step.label}.`);
      }
      await utils.sleepWithSignal(350, this.signal);
      return dom.waitFor(() => this.findStepTarget(step), {
        timeout: 8000,
        interval: 200,
        name: `${step.label} menu item`,
        signal: this.signal
      });
    }

    findStepTarget(step) {
      const direct = dom.findFirst(step.targetSelectors || [], {
        predicate: element => dom.isVisible(element) && !dom.isUnsafeSubmitControl(element)
      });
      if (direct && (!step.targetTextPatterns?.length || dom.matchesAnyText(direct, step.targetTextPatterns))) return dom.buttonLike(direct) || direct;
      return dom.findByText(step.targetSelectors || ['button', '[role="menuitem"]', '[role="option"]'], step.targetTextPatterns || [], {
        excludeTextPatterns: ['stop', 'cancel', 'pause', 'abort'],
        predicate: element => dom.isVisible(element) && !dom.isUnsafeSubmitControl(element)
      });
    }

    async closeStepMenu(step) {
      const visibleTarget = this.findStepTarget(step);
      if (!visibleTarget) return;
      const opener = dom.findFirst(step.openerSelectors || [], {
        predicate: element => !dom.isDisabled(element) && !dom.isUnsafeSubmitControl(element)
      });
      if (!opener) {
        this.logger?.debug?.(`The ${step.label} menu remained open, but its safe opener was not available for closing.`, {
          event: 'setup.menu_close_unavailable',
          step: step.id
        });
        return;
      }
      if (dom.safeClick(opener, { logger: this.logger, purpose: `setup-close-${step.id}`, throwOnUnsafe: true })) {
        await utils.sleepWithSignal(250, this.signal);
      }
    }

    async runToggleStep(step) {
      const target = await this.openStepMenu(step);
      const desired = String(step.desiredValue || 'true');
      const attr = step.checkedAttribute || 'aria-checked';
      const isChecked = element => Boolean(
        element
        && (
          element.getAttribute?.(attr) === desired
          || element.closest?.(`[${attr}="${desired}"]`)
        )
      );
      const checked = isChecked(target);
      if (!checked) {
        this.logger?.info?.(`Enabling ${step.label}.`, { event: 'setup.toggle_enable', step: step.id });
        if (!dom.safeClick(target, { logger: this.logger, purpose: `setup-toggle-${step.id}`, throwOnUnsafe: true })) {
          throw new Error(`Could not safely enable ${step.label}.`);
        }
        await utils.sleepWithSignal(step.waitAfterMs || 600, this.signal);

        let verified = isChecked(target);
        if (!verified) {
          // Menus often close after selection. Reopen and inspect the exact menu item rather than
          // assuming that a successful click changed the requested mode.
          const verificationTarget = await this.openStepMenu(step);
          verified = isChecked(verificationTarget);
        }
        if (!verified) throw new Error(`${step.label} did not report ${attr}="${desired}" after selection.`);
        this.logger?.info?.(`${step.label} was enabled and verified.`, {
          event: 'setup.toggle_verified',
          step: step.id,
          attribute: attr,
          desiredValue: desired
        });
      } else {
        this.logger?.debug?.(`${step.label} is already enabled.`, { event: 'setup.toggle_already_enabled', step: step.id });
      }
      await this.closeStepMenu(step);
    }

    async runMenuSelectStep(step) {
      const opener = dom.findFirst(step.openerSelectors || [], { predicate: element => !dom.isDisabled(element) && !dom.isUnsafeSubmitControl(element) });
      if (!opener) throw new Error(`Could not find safe picker for ${step.label}.`);
      if (dom.matchesAnyText(opener, step.targetTextPatterns || [])) {
        this.logger?.debug?.(`${step.label} already selected.`, { event: 'setup.menu_already_selected', step: step.id });
        return;
      }
      if (!dom.safeClick(opener, { logger: this.logger, purpose: `setup-picker-${step.id}`, throwOnUnsafe: true })) {
        throw new Error(`Could not safely open picker for ${step.label}.`);
      }
      await utils.sleepWithSignal(300, this.signal);
      const target = await dom.waitFor(() => this.findStepTarget(step), {
        timeout: 7000,
        interval: 200,
        name: `${step.label} option`,
        signal: this.signal
      });
      if (!dom.safeClick(target, { logger: this.logger, purpose: `setup-select-${step.id}`, throwOnUnsafe: true })) {
        throw new Error(`Could not safely select ${step.label}.`);
      }
      await utils.sleepWithSignal(step.waitAfterMs || 700, this.signal);
      await dom.waitFor(() => {
        const currentOpener = dom.findFirst(step.openerSelectors || [], {
          predicate: element => !dom.isDisabled(element) && !dom.isUnsafeSubmitControl(element)
        });
        return currentOpener && dom.matchesAnyText(currentOpener, step.targetTextPatterns || []) ? currentOpener : null;
      }, {
        timeout: 5000,
        interval: 250,
        name: `${step.label} selection to be reflected by its picker`,
        signal: this.signal
      });
      this.logger?.info?.(`Selected ${step.label}.`, { event: 'setup.menu_selected', step: step.id });
    }

    async maybeStartScheduledNewChat(job) {
      const every = Math.floor(this.getNumberSetting('newChat.every', 0, 0));
      const enabled = Boolean(this.settings.newChat?.enabled && every > 0);
      if (
        !enabled
        || job.index === 0
        || job.index % every !== 0
        || Number(job.attempt || 0) !== 1
        || job.scheduledNewChatOpenedAt
      ) return;

      if (!(this.config.selectors?.newChat || []).length) {
        this.logger?.debug?.('Scheduled New chat is enabled, but this site has no New chat selectors.', { event: 'new_chat.unsupported' });
        return;
      }

      if (this.getSetting('autoResume', true) === false) {
        // A full-page New-chat transition can destroy the active content script. Continue in the
        // current chat rather than risking an interrupted queue when checkpoint auto-resume is off.
        this.logger?.warn?.('Scheduled New chat was skipped because automatic checkpoint resume is disabled. The queue will continue in the current chat.', {
          event: 'new_chat.skipped_auto_resume_disabled',
          ...this.promptLogMeta(job),
          processedCount: Number(this.checkpoint.data.processedCount || this.checkpoint.data.completedCount || 0)
        });
        return;
      }

      // This boundary is safe after every preceding prompt has reached a terminal state
      // (successful or failed) and the processed index has advanced to this job.
      const processedCount = Number(this.checkpoint.data.processedCount || this.checkpoint.data.completedCount || 0);
      if (processedCount !== job.index) {
        throw new Error('Queue invariant failed: scheduled New chat was requested before the previous prompt reached a terminal state.');
      }

      this.emitCheckpoint(`Opening scheduled New chat before prompt ${job.index + 1}.`, {
        status: statuses.PREPARING,
        phase: 'scheduled-new-chat'
      });
      await this.recovery.openNewChat(`Scheduled boundary after ${job.index} processed prompts`);
      this.checkpoint.patchJob({
        scheduledNewChatOpenedAt: new Date().toISOString()
      }, 'prompt.scheduled_new_chat_opened');
      await this.checkpoint.save('prompt.scheduled_new_chat_opened');
    }

    async submitPromptReliably(prompt, index, total, baseline, job) {
      const getConfiguredClickRetries = () => this.getNumberSetting('maxSubmitRetries', 3, 1);
      const getSubmitTimeout = () => this.getNumberSetting('submitTimeoutMs', 25000, 1000);
      const getReadyTimeout = () => Math.max(
        this.getNumberSetting('readyTimeoutMs', 30000, 1000),
        getSubmitTimeout() * getConfiguredClickRetries()
      );
      let clickAttempt = 0;
      let lastError = null;

      this.emitCheckpoint(`Waiting for a safe composer for prompt ${index + 1}/${total}.`, {
        status: statuses.RUNNING,
        phase: 'waiting-for-ready'
      });
      const input = await this.waitForPromptEntryReady(index, total, getReadyTimeout);

      this.emitCheckpoint(`Filling prompt ${index + 1}/${total}.`, {
        status: statuses.RUNNING,
        phase: 'filling'
      });
      await dom.setInputText(input, prompt);
      await dom.waitFor(() => {
        const currentInput = this.getInput() || input;
        return this.inputContainsExpectedPrompt(currentInput, prompt);
      }, {
        timeout: () => Math.min(10000, getReadyTimeout()),
        interval: () => this.getNumberSetting('pollIntervalMs', 500, 100),
        name: 'the exact prompt text to appear in the composer',
        signal: this.signal
      });
      this.logger?.debug?.('Prompt text was placed and verified in the composer.', {
        event: 'prompt.text_verified',
        ...this.promptLogMeta(job),
        input: dom.describeElement?.(this.getInput() || input)
      });

      while (clickAttempt < getConfiguredClickRetries()) {
        this.assertNotStopped();
        clickAttempt += 1;
        this.checkpoint.patchJob({ submitAttempts: clickAttempt, phase: 'waiting-for-submit' }, 'prompt.submit_attempt');
        await this.checkpoint.save('prompt.submit_attempt');
        this.setPromptLogContext(job, 'waiting-for-submit');
        const clickLimit = getConfiguredClickRetries();
        this.emitCheckpoint(`Waiting for safe Submit control, click attempt ${clickAttempt}/${clickLimit}.`, {
          status: statuses.RUNNING,
          phase: 'waiting-for-submit',
          submitAttempt: clickAttempt
        });

        let button;
        try {
          button = await this.waitForSubmitReady(input, prompt, index, total, getSubmitTimeout);
        } catch (error) {
          lastError = error;
          this.logger?.warn?.('Safe Submit control did not become available for this click attempt.', {
            event: 'prompt.submit_control_timeout',
            ...this.promptLogMeta(job),
            clickAttempt,
            error
          });
          continue;
        }

        const latestInput = this.getInput() || input;
        if (!this.inputContainsExpectedPrompt(latestInput, prompt)) {
          lastError = new Error('Prompt text disappeared before a safe submit click could be made.');
          this.logger?.warn?.('Prompt text disappeared before submit. The runner will observe for submission evidence rather than advancing or immediately duplicating it.', {
            event: 'prompt.text_disappeared_before_click',
            ...this.promptLogMeta(job)
          });
          const evidence = await this.waitForSubmissionRegistered(latestInput, prompt, baseline, () => Math.min(5000, getSubmitTimeout()), { clicked: false });
          if (evidence.accepted) return evidence;
          await dom.setInputText(latestInput, prompt);
          continue;
        }

        const stateBeforeClick = this.getExecutionState(latestInput);
        const selectors = this.config.selectors || {};
        const exclude = dom.mergeSubmitExcludePatterns ? dom.mergeSubmitExcludePatterns(selectors) : (selectors.submitExcludeTextPatterns || []);
        const latestButton = stateBeforeClick.submitButton || button;
        if (
          !stateBeforeClick.readyToSubmit
          || !latestButton
          || !dom.isPositiveSubmitControl(latestButton, selectors.submitTextPatterns || [], exclude)
        ) {
          lastError = new Error(`Submit control was not safe at the final pre-click check: ${stateBeforeClick.reason}.`);
          this.logger?.warn?.('Final pre-click safety check rejected the submit candidate.', {
            event: 'prompt.submit_candidate_rejected',
            ...this.promptLogMeta(job),
            clickAttempt,
            state: {
              busy: stateBeforeClick.busy,
              readyToSubmit: stateBeforeClick.readyToSubmit,
              reason: stateBeforeClick.reason
            },
            candidate: dom.describeElement?.(latestButton)
          });
          await utils.sleepWithSignal(750, this.signal);
          continue;
        }

        // Write an ambiguity-safe checkpoint before the click. If this page reloads
        // at any point from here onward, the resumed runner observes the existing page
        // before it is allowed to send this prompt again.
        await this.checkpoint.markSubmissionArmed({
          baseline,
          chatContextBeforeSubmit: job.chatContextBeforeSubmit || job.chatContext,
          chatContext: job.chatContext || job.chatContextBeforeSubmit,
          submissionEvidence: {
            accepted: null,
            method: 'safe-click',
            clickAttempt,
            armedAt: new Date().toISOString()
          }
        });
        this.emitCheckpoint(`Submitting prompt ${index + 1}/${total}.`, {
          status: statuses.RUNNING,
          phase: 'submitting',
          submitAttempt: clickAttempt
        });
        this.logger?.info?.('Clicking the verified safe Submit control.', {
          event: 'prompt.submit_click',
          ...this.promptLogMeta(job),
          clickAttempt,
          control: dom.describeElement?.(latestButton)
        });
        const clicked = dom.safeSubmitClick(latestButton, {
          logger: this.logger,
          purpose: 'submit-prompt',
          includePatterns: selectors.submitTextPatterns || [],
          excludePatterns: exclude
        });
        if (!clicked) {
          lastError = new Error('The verified Submit control could not be clicked.');

          // Enter is permitted only when no native click was dispatched. It is disabled by
          // default because any second gesture after a real click could duplicate a prompt.
          if (this.settings.submitWithEnterFallback) {
            const currentInput = this.getInput() || input;
            const currentState = this.getExecutionState(currentInput);
            const promptStillPresent = this.inputContainsExpectedPrompt(currentInput, prompt);
            if (
              promptStillPresent
              && currentState.readyToSubmit
              && currentState.submitButton
              && dom.isPositiveSubmitControl(currentState.submitButton, selectors.submitTextPatterns || [], exclude)
            ) {
              await this.checkpoint.markSubmissionDispatched({
                baseline,
                chatContextBeforeSubmit: job.chatContextBeforeSubmit || job.chatContext,
                chatContext: job.chatContext || job.chatContextBeforeSubmit,
                submissionEvidence: {
                  accepted: null,
                  method: 'enter-fallback',
                  clickAttempt,
                  dispatchedAt: new Date().toISOString()
                }
              });
              this.logger?.warn?.('The native click could not be dispatched. Sending one configured Enter fallback from the verified prompt input.', {
                event: 'prompt.enter_fallback',
                ...this.promptLogMeta(job),
                clickAttempt
              });
              const enterDispatched = dom.pressEnter(currentInput);
              if (!enterDispatched) {
                lastError = new Error('The configured Enter fallback could not be dispatched.');
                continue;
              }
              const enterEvidence = await this.waitForSubmissionRegistered(currentInput, prompt, baseline, getSubmitTimeout, { clicked: false, method: 'enter' });
              if (enterEvidence.accepted) return { ...enterEvidence, clickAttempt };

              // A synthetic key gesture crossed the irreversible boundary even when the page did
              // not acknowledge it. Observe/recover before any retry rather than sending again.
              this.logger?.warn?.('Enter fallback was dispatched but not acknowledged. Treating the submission as ambiguous and observing the same attempt before any retry.', {
                event: 'prompt.enter_submission_ambiguous',
                ...this.promptLogMeta(job),
                clickAttempt,
                evidence: enterEvidence
              });
              return {
                ...enterEvidence,
                accepted: true,
                ambiguous: true,
                method: 'enter-fallback-unverified',
                clickAttempt,
                reason: 'Enter was dispatched but the site did not expose submission evidence; observation and timeout recovery are required before retry.'
              };
            }
          }
          continue;
        }

        await this.checkpoint.markSubmissionDispatched({
          baseline,
          chatContextBeforeSubmit: job.chatContextBeforeSubmit || job.chatContext,
          chatContext: job.chatContext || job.chatContextBeforeSubmit,
          submissionEvidence: {
            accepted: null,
            method: 'safe-click',
            clickAttempt,
            dispatchedAt: new Date().toISOString()
          }
        });
        const evidence = await this.waitForSubmissionRegistered(latestInput, prompt, baseline, getSubmitTimeout, { clicked: true });
        if (evidence.accepted) {
          this.logger?.info?.('Prompt submission was accepted without advancing the queue yet.', {
            event: 'prompt.submission_registered',
            ...this.promptLogMeta(job),
            clickAttempt,
            evidence
          });
          return { ...evidence, clickAttempt };
        }

        // A native click was dispatched. Never click Send or press Enter again in this attempt,
        // because a slow Gemini acknowledgement could otherwise create a duplicate prompt. The
        // generation monitor and non-destructive timeout recovery decide whether a retry is needed.
        this.logger?.warn?.('The Send click was dispatched but the site did not acknowledge it within the submission window. Observing the same attempt without issuing another submission gesture.', {
          event: 'prompt.submission_ambiguous_after_click',
          ...this.promptLogMeta(job),
          clickAttempt,
          evidence,
          diagnostic: this.diagnosticSnapshot('submission-ambiguous-after-click')
        });
        return {
          ...evidence,
          accepted: true,
          ambiguous: true,
          method: 'safe-click-unverified',
          clickAttempt,
          reason: 'A verified Send click was dispatched but the site did not expose submission evidence; observation and timeout recovery are required before retry.'
        };
      }

      const finalClickLimit = getConfiguredClickRetries();
      const error = new Error(`Could not dispatch a submission gesture for prompt ${index + 1}/${total} after ${clickAttempt}/${finalClickLimit} safe attempt${clickAttempt === 1 ? '' : 's'}. ${lastError?.message || ''}`.trim());
      error.code = 'PROMPT_SUBMISSION_FAILED';
      throw error;
    }

    async waitForSubmissionRegistered(input, prompt, baseline, timeout, options) {
      const resolveTimeout = () => {
        const resolved = typeof timeout === 'function' ? timeout() : (timeout || this.settings.submitTimeoutMs || 25000);
        const numeric = Number(resolved);
        return Math.max(250, Number.isFinite(numeric) ? numeric : 25000);
      };
      const started = Date.now();
      let promptConsumedSince = null;
      let sawBusy = false;
      let sawResponseChange = false;
      let sawNewImage = false;
      let lastVerboseAt = 0;

      while (Date.now() - started < resolveTimeout()) {
        this.assertNotStopped();
        const currentInput = this.getInput() || input;
        const promptPresent = this.inputContainsExpectedPrompt(currentInput, prompt);
        const state = this.getExecutionState(currentInput);
        const comparison = this.monitor.compare(baseline);
        sawBusy = sawBusy || state.busy;
        sawResponseChange = sawResponseChange || comparison.hasResponseChange;
        sawNewImage = sawNewImage || comparison.hasNewImage;

        if (!promptPresent && promptConsumedSince == null) promptConsumedSince = Date.now();
        if (promptPresent) promptConsumedSince = null;

        if (!promptPresent && (sawBusy || sawResponseChange || sawNewImage)) {
          return {
            accepted: true,
            ambiguous: false,
            method: options?.method || (options?.clicked ? 'click' : 'observed'),
            promptConsumed: true,
            sawBusy,
            sawResponseChange,
            sawNewImage,
            elapsedMs: Date.now() - started
          };
        }

        // Some apps clear the composer before their busy indicator or response node is mounted.
        // Once the prompt has remained absent for 1.5 seconds, treating it as accepted is safer
        // than clicking Submit again and creating a duplicate. Generation verification still must
        // succeed before the queue advances.
        if (!promptPresent && promptConsumedSince != null && Date.now() - promptConsumedSince >= 1500) {
          return {
            accepted: true,
            ambiguous: true,
            method: options?.method || (options?.clicked ? 'click' : 'observed'),
            promptConsumed: true,
            sawBusy,
            sawResponseChange,
            sawNewImage,
            elapsedMs: Date.now() - started,
            reason: 'Prompt left the composer before visible generation evidence appeared.'
          };
        }

        if (Date.now() - lastVerboseAt >= Math.max(500, Number(this.settings.logging?.verbosePollIntervalMs || 2000))) {
          this.logger?.verbose?.('Waiting for submission registration evidence.', {
            event: 'prompt.submission_poll',
            elapsedMs: Date.now() - started,
            promptPresent,
            promptConsumedForMs: promptConsumedSince == null ? 0 : Date.now() - promptConsumedSince,
            sawBusy,
            sawResponseChange,
            sawNewImage,
            execution: {
              busy: state.busy,
              readyToSubmit: state.readyToSubmit,
              reason: state.reason
            }
          });
          lastVerboseAt = Date.now();
        }
        const remaining = Math.max(1, resolveTimeout() - (Date.now() - started));
        await utils.sleepWithSignal(Math.min(this.getNumberSetting('pollIntervalMs', 500, 100), remaining), this.signal);
      }

      const currentInput = this.getInput() || input;
      return {
        accepted: false,
        ambiguous: false,
        method: options?.method || (options?.clicked ? 'click' : 'observed'),
        promptConsumed: !this.inputContainsExpectedPrompt(currentInput, prompt),
        sawBusy,
        sawResponseChange,
        sawNewImage,
        elapsedMs: Date.now() - started
      };
    }

    async downloadGeneratedImage(prompt, index, total) {
      const operationController = new AbortController();
      let timeoutId = null;
      let rejectForUserStop = null;
      const abortForUserStop = () => {
        operationController.abort();
        rejectForUserStop?.(new Error('Stopped by user.'));
      };
      if (this.signal.aborted) abortForUserStop();
      else this.signal.addEventListener('abort', abortForUserStop, { once: true });

      try {
        this.emitCheckpoint(`Downloading image ${index + 1}/${total} as JPEG.`, {
          status: statuses.RUNNING,
          phase: 'downloading'
        });
        const timeoutPromise = new Promise((_, reject) => {
          const started = Date.now();
          const checkTimeout = () => {
            const timeoutMs = this.getNumberSetting('download.operationTimeoutMs', 90000, 1000);
            const elapsed = Date.now() - started;
            if (elapsed >= timeoutMs) {
              const error = new Error(`Download operation timed out after ${timeoutMs} ms.`);
              error.code = 'DOWNLOAD_OPERATION_TIMEOUT';
              reject(error);
              operationController.abort();
              return;
            }
            timeoutId = setTimeout(checkTimeout, Math.min(250, Math.max(1, timeoutMs - elapsed)));
          };
          checkTimeout();
        });
        const userStopPromise = new Promise((_, reject) => {
          rejectForUserStop = reject;
          if (this.signal.aborted) reject(new Error('Stopped by user.'));
        });
        const result = await Promise.race([
          imageConverter.downloadLatestImage(this.config, this.settings, prompt, {
            promptIndex: index,
            total
          }, this.logger, operationController.signal),
          timeoutPromise,
          userStopPromise
        ]);
        if (result?.skipped) this.logger?.debug?.(`Download skipped: ${result.reason}`, { event: 'download.skipped', result });
        else this.logger?.info?.(`Downloaded ${result.filename}.`, { event: 'download.completed', result });
      } catch (error) {
        if (this.signal.aborted) throw new Error('Stopped by user.');
        this.logger?.warn?.(`Download failed: ${error.message}`, { event: 'download.failed', error });
        this.emitCheckpoint(`Generation completed, but download failed: ${error.message}`, { status: statuses.RUNNING, phase: 'download-failed' });
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        this.signal.removeEventListener('abort', abortForUserStop);
      }
    }

    async cooldown(completed, total) {
      if (this.getNumberSetting('cooldownMs', 0, 0) <= 0) return;

      this.checkpoint.patchRun({ status: statuses.COOLDOWN, phase: 'cooldown' }, 'run.cooldown');
      await this.checkpoint.save('run.cooldown');
      const started = Date.now();
      const nextPrompt = Math.min(total, completed + 1);
      while (true) {
        this.assertNotStopped();
        const currentCooldownMs = this.getNumberSetting('cooldownMs', 0, 0);
        const elapsed = Date.now() - started;
        if (elapsed >= currentCooldownMs) break;
        const remaining = Math.max(0, currentCooldownMs - elapsed);
        this.emitCheckpoint(`Cooldown: next prompt ${nextPrompt}/${total} in ${Math.ceil(remaining / 1000)}s.`, {
          status: statuses.COOLDOWN,
          phase: 'cooldown',
          current: completed,
          total,
          cooldownRemainingMs: remaining,
          cooldownTotalMs: currentCooldownMs,
          timerDescription: `Next prompt #${nextPrompt} / #${total} starts after this cooldown.`
        });
        await utils.sleepWithSignal(Math.min(500, remaining || 1), this.signal);
      }

      this.checkpoint.patchRun({ status: statuses.RUNNING, phase: 'preparing-next' }, 'run.cooldown_finished');
      await this.checkpoint.save('run.cooldown_finished');
      this.emitCheckpoint(`Cooldown finished. Preparing prompt ${nextPrompt}/${total}.`, {
        status: statuses.RUNNING,
        phase: 'preparing-next',
        current: nextPrompt,
        total,
        cooldownRemainingMs: 0,
        cooldownTotalMs: this.getNumberSetting('cooldownMs', 0, 0)
      });
    }

  }

  root.AutomationRunner = AutomationRunner;
})(globalThis);
