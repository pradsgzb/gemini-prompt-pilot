(function attachPromptPilotRunCheckpoint(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const statuses = root.RUN_STATUS;

  const ACTIVE_STATUSES = new Set([
    statuses.PREPARING,
    statuses.RUNNING,
    statuses.COOLDOWN,
    statuses.RECOVERING,
    statuses.RETRYING,
    statuses.STOPPING,
    'preparing',
    'running',
    'cooldown',
    'recovering',
    'retrying',
    'stopping'
  ]);

  function normalizePrompt(prompt) {
    if (typeof prompt === 'string') return prompt;
    if (prompt && typeof prompt === 'object') return String(prompt.text ?? prompt.prompt ?? '');
    return String(prompt || '');
  }

  function createJob(prompt, index, runId) {
    const text = normalizePrompt(prompt);
    return {
      id: `${runId}:prompt:${index + 1}`,
      index,
      number: index + 1,
      prompt: text,
      promptHash: utils.hashText(text),
      status: 'pending',
      phase: 'pending',
      attempt: 0,
      submitAttempts: 0,
      recoveryCycles: 0,
      startedAt: null,
      submittedAt: null,
      completedAt: null,
      failedAt: null,
      updatedAt: new Date().toISOString(),
      chatContextBeforeSubmit: null,
      chatContext: null,
      baseline: null,
      submissionEvidence: null,
      submissionArmedAt: null,
      submissionDispatchedAt: null,
      scheduledNewChatOpenedAt: null,
      lastOutcome: null,
      lastError: null,
      attempts: []
    };
  }

  function currentAttempt(job) {
    if (!job?.attempts?.length) return null;
    return job.attempts[job.attempts.length - 1] || null;
  }

  function compactSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const imageItems = (snapshot.images?.items || []).slice(-8).map(item => ({
      contentSignature: item?.contentSignature || item?.signature || null,
      stableSource: utils.truncate(item?.stableSource || '', 320),
      width: Number(item?.width || 0),
      height: Number(item?.height || 0)
    }));
    return {
      capturedAt: snapshot.capturedAt || null,
      url: utils.truncate(snapshot.url || '', 600),
      pathKey: utils.truncate(snapshot.pathKey || '', 500),
      documentVisibility: snapshot.documentVisibility || null,
      imageCount: Number(snapshot.images?.count || 0),
      responseCount: Number(snapshot.responses?.count || 0),
      errorCount: Number(snapshot.errors?.count || 0),
      lastResponseSignature: snapshot.responses?.lastSignature || null,
      recentImages: imageItems
    };
  }

  function compactEvidence(evidence) {
    if (!evidence || typeof evidence !== 'object') return null;
    return {
      sameDocument: Boolean(evidence.sameDocument),
      comparisonMode: evidence.comparisonMode || null,
      newImageCount: Number(evidence.newImages?.length || 0),
      newResponseCount: Number(evidence.newResponses?.length || 0),
      newErrorCount: Number(evidence.newErrors?.length || 0),
      baselineImageCount: Number(evidence.baselineImageCount || 0),
      currentImageCount: Number(evidence.currentImageCount || 0),
      imageCountDelta: Number(evidence.imageCountDelta || 0),
      imageCountIncreased: Boolean(evidence.imageCountIncreased),
      current: compactSnapshot(evidence.current),
      newImages: (evidence.newImages || []).slice(-8).map(item => ({
        contentSignature: item?.contentSignature || item?.signature || null,
        stableSource: utils.truncate(item?.stableSource || '', 320),
        width: Number(item?.width || 0),
        height: Number(item?.height || 0)
      })),
      newResponses: (evidence.newResponses || []).slice(-8).map(item => ({
        contentSignature: item?.contentSignature || item?.signature || null,
        text: utils.truncate(item?.text || '', 240)
      })),
      newErrors: (evidence.newErrors || []).slice(-8).map(item => ({
        contentSignature: item?.contentSignature || item?.signature || null,
        text: utils.truncate(item?.text || '', 240)
      }))
    };
  }

  function compactOutcome(outcome) {
    if (!outcome || typeof outcome !== 'object') return outcome || null;
    return {
      status: outcome.status || null,
      reason: utils.truncate(outcome.reason || '', 1200),
      failureType: outcome.failureType || null,
      elapsedMs: Number(outcome.elapsedMs || 0),
      sawBusy: Boolean(outcome.sawBusy),
      sawNewImage: Boolean(outcome.sawNewImage),
      sawImageCountIncrease: Boolean(outcome.sawImageCountIncrease),
      sawResponseChange: Boolean(outcome.sawResponseChange),
      stillBusy: Boolean(outcome.stillBusy),
      composerReady: Boolean(outcome.composerReady),
      snapshot: compactSnapshot(outcome.snapshot),
      evidence: compactEvidence(outcome.evidence),
      error: outcome.error ? utils.errorToObject(outcome.error) : null
    };
  }

  function compactSubmissionEvidence(evidence) {
    if (!evidence || typeof evidence !== 'object') return evidence || null;
    return {
      accepted: evidence.accepted ?? null,
      ambiguous: Boolean(evidence.ambiguous),
      method: evidence.method || null,
      clickAttempt: Number(evidence.clickAttempt || 0),
      promptConsumed: Boolean(evidence.promptConsumed),
      sawBusy: Boolean(evidence.sawBusy),
      sawResponseChange: Boolean(evidence.sawResponseChange),
      sawNewImage: Boolean(evidence.sawNewImage),
      elapsedMs: Number(evidence.elapsedMs || 0),
      reason: utils.truncate(evidence.reason || '', 500),
      armedAt: evidence.armedAt || null,
      dispatchedAt: evidence.dispatchedAt || null
    };
  }

  class RunCheckpoint {
    constructor(repository, logger, options) {
      this.repository = repository;
      this.logger = logger;
      this.tabId = options?.tabId ?? null;
      this.data = null;
      this.writeChain = Promise.resolve();
    }

    static isResumable(data) {
      return Boolean(
        data?.resumable !== false
        && ACTIVE_STATUSES.has(data?.status)
        && Array.isArray(data?.jobs)
        && Number(data.currentIndex || 0) < data.jobs.length
      );
    }

    static isFresh(data, maxAgeHours) {
      if (!data?.updatedAt) return false;
      const updated = Date.parse(data.updatedAt);
      if (!Number.isFinite(updated)) return false;
      const hours = Math.max(0.25, Number(maxAgeHours || 24));
      return Date.now() - updated <= hours * 60 * 60 * 1000;
    }

    static belongsToTab(data, tabContext) {
      if (!data || !tabContext) return false;
      if (data.owner?.tabId == null || tabContext.tabId == null) return true;
      return Number(data.owner.tabId) === Number(tabContext.tabId);
    }

    create(prompts, settings, config, owner) {
      const runId = utils.randomId('run');
      const jobs = (Array.isArray(prompts) ? prompts : [])
        .map(normalizePrompt)
        .filter(prompt => prompt.trim())
        .map((prompt, index) => createJob(prompt, index, runId));
      const now = new Date().toISOString();
      this.tabId = owner?.tabId ?? this.tabId;
      this.data = {
        schemaVersion: 4,
        extensionVersion: root.VERSION,
        runId,
        owner: {
          tabId: owner?.tabId ?? null,
          windowId: owner?.windowId ?? null,
          siteId: config?.id || null,
          origin: (() => {
            try { return new URL(owner?.url || global.location?.href || '').origin; } catch (_) { return null; }
          })()
        },
        status: statuses.PREPARING,
        phase: 'preparing',
        resumable: true,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        stoppedAt: null,
        suspendedAt: null,
        currentIndex: 0,
        // completedCount is retained for backward compatibility and now means processed count.
        completedCount: 0,
        processedCount: 0,
        successfulCount: 0,
        failedCount: 0,
        total: jobs.length,
        pageUrl: owner?.url || global.location?.href || null,
        settings: utils.clone(settings || {}),
        jobs,
        lastError: null,
        lastEvent: 'run.created'
      };
      return this.data;
    }

    resume(data) {
      if (!data || !Array.isArray(data.jobs)) throw new Error('The stored run checkpoint is invalid.');
      this.data = utils.clone(data);
      this.tabId = this.data.owner?.tabId ?? this.tabId;
      this.data.schemaVersion = Math.max(4, Number(this.data.schemaVersion || 1));
      this.data.extensionVersion = root.VERSION;
      this.data.updatedAt = new Date().toISOString();
      this.data.lastEvent = 'run.resumed';
      this.data.resumable = true;
      for (const job of this.data.jobs) {
        if (!Array.isArray(job.attempts)) job.attempts = [];
        if (job.chatContextBeforeSubmit === undefined) job.chatContextBeforeSubmit = null;
        if (job.submissionArmedAt === undefined) job.submissionArmedAt = null;
        if (job.submissionDispatchedAt === undefined) job.submissionDispatchedAt = null;
        if (job.scheduledNewChatOpenedAt === undefined) job.scheduledNewChatOpenedAt = null;
        if (job.failedAt === undefined) job.failedAt = null;
      }
      const processedFromJobs = this.data.jobs.filter(job => ['completed', 'failed'].includes(job.status)).length;
      const successfulFromJobs = this.data.jobs.filter(job => job.status === 'completed').length;
      const failedFromJobs = this.data.jobs.filter(job => job.status === 'failed').length;
      this.data.processedCount = Math.max(Number(this.data.processedCount || 0), Number(this.data.completedCount || 0), processedFromJobs, Number(this.data.currentIndex || 0));
      this.data.completedCount = this.data.processedCount;
      this.data.successfulCount = Math.max(Number(this.data.successfulCount || 0), successfulFromJobs);
      this.data.failedCount = Math.max(Number(this.data.failedCount || 0), failedFromJobs);
      return this.data;
    }

    get currentJob() {
      return this.data?.jobs?.[this.data.currentIndex] || null;
    }

    promptPreview(job, settings) {
      const chars = Math.max(40, Number(settings?.logging?.promptPreviewChars || 180));
      if (settings?.logging?.includeFullPromptText) return job?.prompt || '';
      return utils.truncate(job?.prompt || '', chars);
    }

    publicState(message, patch) {
      const job = this.currentJob;
      return {
        status: this.data?.status || statuses.IDLE,
        phase: this.data?.phase || 'idle',
        runId: this.data?.runId || null,
        current: job ? job.index + 1 : (this.data?.completedCount || 0),
        total: this.data?.total || 0,
        completedCount: this.data?.completedCount || 0,
        processedCount: this.data?.processedCount || this.data?.completedCount || 0,
        successfulCount: this.data?.successfulCount || 0,
        failedCount: this.data?.failedCount || 0,
        currentPrompt: job?.prompt || null,
        currentPromptHash: job?.promptHash || null,
        promptAttempt: job?.attempt || 0,
        recoveryCycles: job?.recoveryCycles || 0,
        lastError: this.data?.lastError || job?.lastError || null,
        message: message || null,
        updatedAt: this.data?.updatedAt || new Date().toISOString(),
        ...(patch || {})
      };
    }

    patchRun(patch, eventName) {
      if (!this.data) throw new Error('Run checkpoint has not been initialized.');
      Object.assign(this.data, utils.clone(patch || {}));
      this.data.updatedAt = new Date().toISOString();
      if (eventName) this.data.lastEvent = eventName;
      return this.data;
    }

    patchJob(patch, eventName) {
      const job = this.currentJob;
      if (!job) throw new Error('No current prompt exists in the run checkpoint.');
      Object.assign(job, utils.clone(patch || {}));
      job.updatedAt = new Date().toISOString();
      this.data.updatedAt = job.updatedAt;
      if (eventName) {
        job.lastEvent = eventName;
        this.data.lastEvent = eventName;
      }
      return job;
    }

    async persist(snapshot) {
      if (this.tabId != null && this.repository?.saveActiveRun) {
        return this.repository.saveActiveRun(this.tabId, snapshot);
      }
      return this.repository.saveRunState(snapshot);
    }

    async save(eventName, options) {
      if (!this.data) return null;
      const opts = options || {};
      const required = opts.required === true;
      const maxAttempts = required ? Math.max(1, Number(opts.maxAttempts || 4)) : 1;
      if (eventName) this.data.lastEvent = eventName;
      this.data.pageUrl = global.location?.href || this.data.pageUrl;
      this.data.updatedAt = new Date().toISOString();
      const snapshot = utils.clone(this.data);
      this.writeChain = this.writeChain
        .catch(() => null)
        .then(async () => {
          let lastError = null;
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
              await this.persist(snapshot);
              this.logger?.verbose?.('Saved durable run checkpoint.', {
                reason: eventName || snapshot.lastEvent,
                runId: snapshot.runId,
                tabId: this.tabId,
                status: snapshot.status,
                phase: snapshot.phase,
                currentIndex: snapshot.currentIndex,
                completedCount: snapshot.completedCount,
                promptStatus: snapshot.jobs?.[snapshot.currentIndex]?.status || null,
                required,
                persistenceAttempt: attempt
              }, 'checkpoint.saved');
              return snapshot;
            } catch (error) {
              lastError = error;
              this.logger?.warn?.('Durable checkpoint write failed.', {
                reason: eventName || snapshot.lastEvent,
                runId: snapshot.runId,
                required,
                persistenceAttempt: attempt,
                persistenceAttempts: maxAttempts,
                error
              }, 'checkpoint.write_attempt_failed');
              if (attempt < maxAttempts) await utils.sleep(Math.min(1200, 150 * Math.pow(2, attempt - 1)));
            }
          }

          if (required) {
            const error = new Error(`Could not persist the required durable checkpoint after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'} (${eventName || snapshot.lastEvent || 'unknown event'}). The unsafe navigation or irreversible operation was blocked; prompt-level failure handling can continue the queue.`);
            error.code = 'CHECKPOINT_PERSISTENCE_FAILED';
            error.cause = lastError;
            error.meta = {
              reason: eventName || snapshot.lastEvent,
              runId: snapshot.runId,
              tabId: this.tabId,
              currentIndex: snapshot.currentIndex,
              completedCount: snapshot.completedCount
            };
            this.logger?.error?.(error.message, { ...error.meta, error: lastError }, 'checkpoint.required_write_failed');
            throw error;
          }

          this.logger?.warn?.('Could not save the durable run checkpoint; the active in-page run will continue, but reload recovery may be unavailable.', {
            reason: eventName || snapshot.lastEvent,
            error: lastError
          }, 'checkpoint.save_failed');
          return snapshot;
        });
      return this.writeChain;
    }

    async beginJob() {
      const job = this.currentJob;
      if (!job) return null;
      const now = new Date().toISOString();
      this.patchRun({ status: statuses.RUNNING, phase: 'preparing-prompt', lastError: null }, 'prompt.begin');
      this.patchJob({
        status: job.status === 'retrying' ? 'retrying' : 'running',
        phase: 'preparing',
        startedAt: job.startedAt || now,
        lastError: null
      }, 'prompt.begin');
      await this.save('prompt.begin');
      return job;
    }

    async beginAttempt() {
      const job = this.currentJob;
      const attempt = Number(job?.attempt || 0) + 1;
      const now = new Date().toISOString();
      this.patchRun({ status: statuses.RUNNING, phase: 'attempt-started', lastError: null }, 'prompt.attempt_started');
      const attempts = Array.isArray(job.attempts) ? job.attempts.slice(-49) : [];
      attempts.push({
        attempt,
        startedAt: now,
        submittedAt: null,
        completedAt: null,
        status: 'running',
        failureType: null,
        reason: null
      });
      this.patchJob({
        status: 'running',
        phase: 'attempt-started',
        attempt,
        attempts,
        submitAttempts: 0,
        recoveryCycles: 0,
        submittedAt: null,
        submissionEvidence: null,
        submissionArmedAt: null,
        submissionDispatchedAt: null,
        lastOutcome: null,
        lastError: null
      }, 'prompt.attempt_started');
      await this.save('prompt.attempt_started');
      return attempt;
    }


    async markSubmissionArmed(context) {
      const now = new Date().toISOString();
      const job = this.currentJob;
      const attempts = utils.clone(job.attempts || []);
      const attempt = attempts[attempts.length - 1];
      if (attempt) {
        attempt.status = 'submission-armed';
        attempt.submissionArmedAt = now;
      }
      this.patchRun({ status: statuses.RUNNING, phase: 'submission-armed' }, 'prompt.submission_armed');
      this.patchJob({
        status: 'submission-armed',
        phase: 'submission-armed',
        submissionArmedAt: now,
        attempts,
        chatContextBeforeSubmit: context?.chatContextBeforeSubmit || job.chatContextBeforeSubmit,
        chatContext: context?.chatContext || job.chatContext,
        baseline: context?.baseline || job.baseline,
        submissionEvidence: context?.submissionEvidence || job.submissionEvidence || null
      }, 'prompt.submission_armed');
      await this.save('prompt.submission_armed');
    }

    async markSubmissionDispatched(context) {
      const now = new Date().toISOString();
      const job = this.currentJob;
      const attempts = utils.clone(job.attempts || []);
      const attempt = attempts[attempts.length - 1];
      if (attempt) {
        attempt.status = 'submission-dispatched';
        attempt.submissionDispatchedAt = now;
      }
      this.patchRun({ status: statuses.RUNNING, phase: 'submission-dispatched' }, 'prompt.submission_dispatched');
      this.patchJob({
        status: 'submission-dispatched',
        phase: 'submission-dispatched',
        submissionDispatchedAt: now,
        attempts,
        chatContextBeforeSubmit: context?.chatContextBeforeSubmit || job.chatContextBeforeSubmit,
        chatContext: context?.chatContext || job.chatContext,
        baseline: context?.baseline || job.baseline,
        submissionEvidence: context?.submissionEvidence || job.submissionEvidence || null
      }, 'prompt.submission_dispatched');
      await this.save('prompt.submission_dispatched');
    }



    async markSubmitted(context) {
      const now = new Date().toISOString();
      const job = this.currentJob;
      const attempts = utils.clone(job.attempts || []);
      const attempt = attempts[attempts.length - 1];
      if (attempt) {
        attempt.status = 'submitted';
        attempt.submittedAt = now;
      }
      this.patchRun({ status: statuses.RUNNING, phase: 'waiting-for-generation' }, 'prompt.submitted');
      this.patchJob({
        status: 'submitted',
        phase: 'waiting-for-generation',
        submittedAt: now,
        attempts,
        chatContextBeforeSubmit: context?.chatContextBeforeSubmit || job.chatContextBeforeSubmit,
        chatContext: context?.chatContext || job.chatContext,
        baseline: context?.baseline || job.baseline,
        submissionEvidence: context?.submissionEvidence || null
      }, 'prompt.submitted');
      await this.save('prompt.submitted');
    }

    async markRecovering(reason) {
      const job = this.currentJob;
      this.patchRun({ status: statuses.RECOVERING, phase: 'recovering', lastError: reason || null }, 'prompt.recovering');
      this.patchJob({
        status: 'recovering',
        phase: 'recovering',
        recoveryCycles: Number(job.recoveryCycles || 0) + 1,
        lastError: reason || null
      }, 'prompt.recovering');
      await this.save('prompt.recovering');
    }

    async markRetry(reason, outcome) {
      const job = this.currentJob;
      const attempts = utils.clone(job.attempts || []);
      const attempt = attempts[attempts.length - 1];
      if (attempt) {
        attempt.status = 'failed';
        attempt.completedAt = new Date().toISOString();
        attempt.failureType = outcome?.failureType || null;
        attempt.reason = reason || null;
      }
      this.patchRun({ status: statuses.RETRYING, phase: 'retrying', lastError: reason || null }, 'prompt.retry_scheduled');
      this.patchJob({
        status: 'retrying',
        phase: 'retrying',
        attempts,
        lastError: reason || null,
        // Once an attempt is scheduled for retry, its large baseline is no longer needed.
        // Keeping only compact evidence prevents chrome.storage quota failures on long batches.
        baseline: null,
        submissionEvidence: compactSubmissionEvidence(job.submissionEvidence),
        lastOutcome: compactOutcome(outcome)
      }, 'prompt.retry_scheduled');
      await this.save('prompt.retry_scheduled');
    }

    advanceAfterOutcome(job, now, eventName) {
      const processedCount = Math.max(Number(this.data.processedCount || this.data.completedCount || 0), job.index + 1);
      this.data.processedCount = processedCount;
      this.data.completedCount = processedCount;
      this.data.currentIndex = job.index + 1;
      this.data.status = this.data.currentIndex >= this.data.total ? statuses.COMPLETED : statuses.RUNNING;
      this.data.phase = this.data.currentIndex >= this.data.total ? 'completed' : 'between-prompts';
      this.data.lastError = null;
      this.data.updatedAt = now;
      this.data.lastEvent = eventName;
    }

    async markComplete(outcome) {
      const job = this.currentJob;
      if (!job) return null;
      const completedJob = utils.clone(job);
      const now = new Date().toISOString();
      const attempts = utils.clone(job.attempts || []);
      const attempt = attempts[attempts.length - 1];
      if (attempt) {
        attempt.status = 'completed';
        attempt.completedAt = now;
        attempt.reason = outcome?.reason || null;
      }
      this.patchJob({
        status: 'completed',
        phase: 'completed',
        completedAt: now,
        failedAt: null,
        attempts,
        baseline: null,
        submissionEvidence: compactSubmissionEvidence(job.submissionEvidence),
        lastOutcome: compactOutcome(outcome),
        lastError: null
      }, 'prompt.completed');
      this.data.successfulCount = Number(this.data.successfulCount || 0) + 1;
      this.advanceAfterOutcome(job, now, 'prompt.completed');
      await this.save('prompt.completed');
      return completedJob;
    }

    async markFailedAndAdvance(outcome) {
      const job = this.currentJob;
      if (!job) return null;
      const failedJob = utils.clone(job);
      const now = new Date().toISOString();
      const reason = outcome?.reason || 'Prompt failed without a reported reason.';
      const attempts = utils.clone(job.attempts || []);
      const attempt = attempts[attempts.length - 1];
      if (attempt) {
        attempt.status = 'failed';
        attempt.completedAt = now;
        attempt.failureType = outcome?.failureType || null;
        attempt.reason = reason;
      }
      this.patchJob({
        status: 'failed',
        phase: 'failed',
        completedAt: now,
        failedAt: now,
        attempts,
        baseline: null,
        submissionEvidence: compactSubmissionEvidence(job.submissionEvidence),
        lastOutcome: compactOutcome(outcome),
        lastError: reason
      }, 'prompt.failed_continued');
      this.data.failedCount = Number(this.data.failedCount || 0) + 1;
      this.advanceAfterOutcome(job, now, 'prompt.failed_continued');
      await this.save('prompt.failed_continued');
      return failedJob;
    }

    async finish() {
      const now = new Date().toISOString();
      const successfulCount = this.data.jobs.filter(job => job.status === 'completed').length;
      const failedCount = this.data.jobs.filter(job => job.status === 'failed').length;
      this.patchRun({
        status: statuses.COMPLETED,
        phase: 'completed',
        resumable: false,
        completedAt: now,
        completedCount: this.data.total,
        processedCount: this.data.total,
        successfulCount,
        failedCount,
        currentIndex: this.data.total,
        lastError: null
      }, 'run.completed');
      await this.save('run.completed');
    }

    async suspend(reason) {
      const now = new Date().toISOString();
      this.patchRun({
        status: statuses.RECOVERING,
        phase: 'suspended-for-reload',
        resumable: true,
        suspendedAt: now,
        lastError: null,
        suspendReason: reason || 'content-script-reload'
      }, 'run.suspended');
      await this.save('run.suspended');
    }

    async stop() {
      const now = new Date().toISOString();
      this.patchRun({
        status: statuses.STOPPED,
        phase: 'stopped',
        resumable: false,
        stoppedAt: now,
        lastError: null
      }, 'run.stopped');
      if (this.currentJob && !['completed', 'failed'].includes(this.currentJob.status)) {
        this.patchJob({ status: 'stopped', phase: 'stopped' }, 'run.stopped');
      }
      await this.save('run.stopped');
    }

    async fail(error) {
      const message = error?.message || String(error || 'Unknown error');
      this.patchRun({
        status: statuses.ERROR,
        phase: 'error',
        resumable: false,
        lastError: message
      }, 'run.failed');
      if (this.currentJob && !['completed', 'failed'].includes(this.currentJob.status)) {
        this.patchJob({ status: 'error', phase: 'error', lastError: message }, 'run.failed');
      }
      await this.save('run.failed');
    }
  }

  root.RunCheckpoint = RunCheckpoint;
})(globalThis);
