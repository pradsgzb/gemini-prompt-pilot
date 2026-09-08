(function attachPromptPilotGenerationMonitor(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const dom = root.Dom;

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function pathKey(value) {
    try {
      const url = new URL(value, global.location?.href || undefined);
      return `${url.pathname.replace(/\/$/, '')}${url.search}`;
    } catch (_) {
      return String(value || '').replace(/^https?:\/\/[^/]+/i, '').replace(/#.*$/, '').replace(/\/$/, '');
    }
  }

  function stableImageSource(value) {
    const source = String(value || '');
    if (!source) return '';
    if (/^data:/i.test(source)) return `data:${utils.hashText(source)}`;
    if (/^blob:/i.test(source)) return 'blob:';
    try {
      const url = new URL(source, global.location?.href || undefined);
      // Signed image URLs frequently rotate query parameters when a conversation is reopened.
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return source.replace(/[?#].*$/, '');
    }
  }

  function signatureCounts(items, selector) {
    const counts = new Map();
    for (const item of items || []) {
      const signature = selector(item);
      if (!signature) continue;
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
    return counts;
  }

  function consumeOrNew(counts, signature) {
    if (!signature) return true;
    const count = counts.get(signature) || 0;
    if (count <= 0) return true;
    if (count === 1) counts.delete(signature);
    else counts.set(signature, count - 1);
    return false;
  }


  class GenerationMonitor {
    constructor(config, settings, logger, signal, getExecutionState) {
      this.config = config || {};
      this.settings = settings || {};
      this.logger = logger;
      this.signal = signal;
      this.getExecutionState = typeof getExecutionState === 'function' ? getExecutionState : () => ({ busy: false, readyForEntry: false });
      this.elementIds = new WeakMap();
      this.nextElementId = 1;
      // A persisted baseline can be compared after a full page reload. Element identity is
      // meaningful only inside one document, so every snapshot also carries a document ID.
      this.documentInstanceId = utils.randomId('document');
    }

    elementId(element) {
      if (!element) return 'none';
      if (!this.elementIds.has(element)) {
        this.elementIds.set(element, `el-${this.nextElementId}`);
        this.nextElementId += 1;
      }
      return this.elementIds.get(element);
    }

    getImages() {
      const configured = this.config.selectors?.outputImages || [];
      const generic = this.settings.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.outputImages || []) : [];
      const images = dom.getLargeVisibleImages([...configured, ...generic]);
      const responses = this.getResponseElements();
      if (!responses.length) return images;
      const scoped = images.filter(image => responses.some(response => response.contains?.(image)));
      // Prefer images attached to assistant-response containers. Fall back only when a site has
      // valid image selectors but no usable response-container structure.
      return scoped.length ? scoped : images;
    }

    getImageSnapshot() {
      const images = this.getImages();
      return {
        count: images.length,
        items: images.map(image => {
          const rect = image.getBoundingClientRect?.() || {};
          const src = image.currentSrc || image.src || '';
          const elementId = this.elementId(image);
          const width = Number(image.naturalWidth || rect.width || 0);
          const height = Number(image.naturalHeight || rect.height || 0);
          const stableSource = stableImageSource(src);
          const contentSignature = utils.hashText(`${stableSource}|${width}|${height}`);
          const liveSignature = utils.hashText(`${src}|${width}|${height}`);
          return {
            elementId,
            // Never persist signed URLs or full data URLs in checkpoints/logs. The stable source
            // plus hashes are sufficient for comparison and diagnostics.
            source: stableSource,
            stableSource,
            width,
            height,
            contentSignature,
            liveSignature,
            instanceSignature: utils.hashText(`${elementId}|${liveSignature}`),
            // Kept for diagnostics/backward compatibility; it is intentionally document-independent.
            signature: contentSignature
          };
        }).filter(item => item.stableSource || item.width || item.height)
      };
    }

    getResponseElements() {
      const configured = this.config.selectors?.responseContainers || [];
      const generic = this.settings.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.responseContainers || []) : [];
      const elements = dom.findAll([...configured, ...generic], { predicate: element => dom.isVisible(element) });
      // Nested response wrappers can describe the same answer. Keep leaf-most nodes so a
      // single assistant response is not counted several times.
      return elements.filter(element => !elements.some(other => other !== element && element.contains(other)));
    }

    elementSignature(element) {
      const rawImageSources = [];
      const stableImageSources = [];
      try {
        element.querySelectorAll?.('img').forEach(image => {
          const src = image.currentSrc || image.src || '';
          rawImageSources.push(src);
          stableImageSources.push(stableImageSource(src));
        });
      } catch (_) {}
      const text = utils.normalizeText(element.innerText || element.textContent || '').slice(0, 3000);
      const elementId = this.elementId(element);
      const stableIdentity = [
        element.tagName || '',
        element.getAttribute?.('data-testid') || '',
        element.getAttribute?.('data-test-id') || '',
        text,
        ...stableImageSources
      ].join('|');
      const liveIdentity = [
        element.getAttribute?.('data-message-id') || '',
        text,
        ...rawImageSources
      ].join('|');
      const contentSignature = utils.hashText(stableIdentity);
      const liveSignature = utils.hashText(liveIdentity);
      return {
        elementId,
        contentSignature,
        liveSignature,
        instanceSignature: utils.hashText(`${elementId}|${liveSignature}`),
        signature: contentSignature,
        text: text.slice(0, 800),
        imageSources: stableImageSources.slice(-16)
      };
    }


    getResponseSnapshot() {
      const items = this.getResponseElements().map(element => this.elementSignature(element)).slice(-100);
      return {
        count: items.length,
        items,
        signatures: items.map(item => item.contentSignature || item.signature),
        instanceSignatures: items.map(item => item.instanceSignature).filter(Boolean),
        elementIds: items.map(item => item.elementId),
        lastSignature: items[items.length - 1]?.contentSignature || items[items.length - 1]?.signature || null
      };
    }

    getErrorCandidates() {
      const configured = this.config.selectors?.errorContainers || [];
      const generic = this.settings.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.errorContainers || []) : [];
      const patterns = uniqueStrings([
        ...(this.config.selectors?.errorTextPatterns || []),
        ...(this.settings.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.errorTextPatterns || []) : [])
      ]);
      const candidates = dom.findAll([...configured, ...generic], { predicate: element => dom.isVisible(element) });
      for (const response of this.getResponseElements().slice(-6)) {
        const text = utils.normalizeText(response.innerText || response.textContent || '');
        if (patterns.some(pattern => utils.toRegExp(pattern, 'i').test(text))) candidates.push(response);
      }
      const seen = new Set();
      return candidates.filter(element => {
        if (!element || seen.has(element)) return false;
        seen.add(element);
        const text = utils.normalizeText(element.innerText || element.textContent || '');
        return Boolean(text && text.length <= 2000 && patterns.some(pattern => utils.toRegExp(pattern, 'i').test(text)));
      });
    }

    getErrorSnapshot() {
      const items = this.getErrorCandidates().map(element => {
        const text = utils.normalizeText(element.innerText || element.textContent || '').slice(0, 1600);
        const elementId = this.elementId(element);
        const contentSignature = utils.hashText(`${text}|${element.getAttribute?.('data-testid') || ''}|${element.className || ''}`);
        return {
          elementId,
          contentSignature,
          instanceSignature: utils.hashText(`${elementId}|${contentSignature}`),
          signature: contentSignature,
          text: text.slice(0, 800)
        };
      }).slice(-50);
      return {
        count: items.length,
        items,
        signatures: items.map(item => item.contentSignature || item.signature),
        instanceSignatures: items.map(item => item.instanceSignature).filter(Boolean)
      };
    }

    snapshot() {
      return {
        capturedAt: new Date().toISOString(),
        documentInstanceId: this.documentInstanceId,
        url: global.location?.href || '',
        pathKey: pathKey(global.location?.href || ''),
        documentVisibility: document.visibilityState || 'unknown',
        images: this.getImageSnapshot(),
        responses: this.getResponseSnapshot(),
        errors: this.getErrorSnapshot()
      };
    }

    compare(baseline) {
      const before = baseline || {
        images: { count: 0, items: [] },
        responses: { count: 0, signatures: [], items: [] },
        errors: { count: 0, signatures: [], items: [] }
      };
      const current = this.snapshot();
      const sameDocument = Boolean(
        before.documentInstanceId
        && current.documentInstanceId
        && before.documentInstanceId === current.documentInstanceId
      );

      const stableSignature = item => item?.contentSignature || item?.signature || null;
      // Always compare document-independent content signatures. SPA chat navigation can recreate
      // old images in the same JavaScript document and rotate signed URL query parameters; live
      // URLs or element identities would then falsely look like a newly generated result.
      const comparisonSignature = stableSignature;

      // Use multisets rather than Sets. If a prompt legitimately adds a second image with the
      // same stable URL/dimensions, the extra occurrence still counts as new. Conversely, simply
      // recreating old DOM nodes when a chat is reopened does not count as completion evidence.
      const beforeImageCounts = signatureCounts(before.images?.items || [], comparisonSignature);
      const newImages = (current.images?.items || []).filter(item => (
        consumeOrNew(beforeImageCounts, comparisonSignature(item))
      ));

      const responseFallbackItems = (before.responses?.items || []).length
        ? before.responses.items
        : (before.responses?.signatures || []).map(signature => ({ contentSignature: signature, liveSignature: signature }));
      const beforeResponseCounts = signatureCounts(responseFallbackItems, comparisonSignature);
      const newResponses = (current.responses?.items || []).filter(item => (
        consumeOrNew(beforeResponseCounts, comparisonSignature(item))
      ));

      const errorFallbackItems = (before.errors?.items || []).length
        ? before.errors.items
        : (before.errors?.signatures || []).map(signature => ({ contentSignature: signature, liveSignature: signature }));
      const beforeErrorCounts = signatureCounts(errorFallbackItems, comparisonSignature);
      const newErrors = (current.errors?.items || []).filter(item => (
        consumeOrNew(beforeErrorCounts, comparisonSignature(item))
      ));

      const baselineImageCount = Math.max(0, Number(before.images?.count || 0));
      const currentImageCount = Math.max(0, Number(current.images?.count || 0));
      const imageCountDelta = currentImageCount - baselineImageCount;
      const imageCountIncreased = imageCountDelta > 0;

      return {
        current,
        sameDocument,
        comparisonMode: 'stable-content-multiset',
        baselineImageCount,
        currentImageCount,
        imageCountDelta,
        imageCountIncreased,
        newImages,
        newResponses,
        newErrors,
        hasNewImage: imageCountIncreased || newImages.length > 0,
        hasResponseChange: newResponses.length > 0,
        hasNewError: newErrors.length > 0
      };
    }


    async observe(baseline, options) {
      const opts = options || {};
      const resolveNumber = (value, fallback, minimum) => {
        const resolved = typeof value === 'function' ? value() : (value ?? fallback);
        const numeric = Number(resolved);
        const fallbackNumeric = Number(fallback);
        return Math.max(minimum, Number.isFinite(numeric) ? numeric : (Number.isFinite(fallbackNumeric) ? fallbackNumeric : minimum));
      };
      const resolveTimeout = () => resolveNumber(opts.timeout, this.settings.generationTimeoutMs || 300000, 1000);
      const resolveIdleSettleMs = () => resolveNumber(opts.idleSettleMs, this.settings.idleSettleMs ?? 750, 0);
      const resolveNoImageFailureGraceMs = () => resolveNumber(opts.noImageFailureGraceMs, 15000, 1000);
      const resolvePollIntervalMs = () => resolveNumber(opts.pollIntervalMs, 500, 100);
      const requireImage = opts.requireImage !== false;
      const expectedPathKey = opts.expectedPathKey || null;
      const started = Date.now();
      let completionReadySince = null;
      let responseWithoutImageSince = null;
      let unexpectedPathSince = null;
      let sawBusy = false;
      let sawNewImage = false;
      let sawImageCountIncrease = false;
      let sawResponseChange = false;
      let lastStateKey = '';
      let lastVerboseAt = 0;
      let lastComparison = null;
      let timeout = resolveTimeout();

      while (true) {
        if (this.signal?.aborted) throw new Error('Stopped by user.');
        timeout = resolveTimeout();
        const elapsed = Date.now() - started;
        if (elapsed >= timeout) break;
        const execution = this.getExecutionState();
        const comparison = this.compare(baseline);
        lastComparison = comparison;
        sawBusy = sawBusy || Boolean(execution.busy);
        sawNewImage = sawNewImage || comparison.hasNewImage;
        sawImageCountIncrease = sawImageCountIncrease || comparison.imageCountIncreased;
        sawResponseChange = sawResponseChange || comparison.hasResponseChange;

        const currentPath = comparison.current.pathKey;
        const pathMismatch = Boolean(expectedPathKey && currentPath && currentPath !== expectedPathKey);
        if (pathMismatch) {
          if (unexpectedPathSince == null) unexpectedPathSince = Date.now();
        } else {
          unexpectedPathSince = null;
        }

        const stateKey = [
          execution.busy ? 'busy' : 'idle',
          execution.readyForEntry ? 'ready' : 'not-ready',
          execution.inputReady ? 'input-ready' : 'input-not-ready',
          sawImageCountIncrease ? 'count-increased' : 'count-not-increased',
          sawNewImage ? 'new-image' : 'no-image',
          sawResponseChange ? 'response-change' : 'no-response-change',
          comparison.hasNewError ? 'error' : 'no-error',
          pathMismatch ? 'wrong-chat' : 'expected-chat'
        ].join('|');
        if (stateKey !== lastStateKey) {
          this.logger?.debug?.('Generation observation state changed.', {
            stateKey,
            elapsedMs: Date.now() - started,
            expectedPathKey,
            currentPath,
            execution: {
              busy: execution.busy,
              readyForEntry: execution.readyForEntry,
              reason: execution.reason
            },
            evidence: {
              sawBusy,
              sawNewImage,
              sawImageCountIncrease,
              sawResponseChange,
              baselineImageCount: comparison.baselineImageCount,
              imageCount: comparison.current.images?.count || 0,
              imageCountDelta: comparison.imageCountDelta,
              responseCount: comparison.current.responses?.count || 0,
              newErrorCount: comparison.newErrors.length
            }
          }, 'generation.state_changed');
          lastStateKey = stateKey;
        }

        const verboseIntervalMs = Math.max(500, Number(this.settings.logging?.verbosePollIntervalMs || 2000));
        if (Date.now() - lastVerboseAt >= verboseIntervalMs) {
          this.logger?.verbose?.('Generation observation poll.', {
            elapsedMs: Date.now() - started,
            timeoutMs: timeout,
            expectedPathKey,
            currentPath,
            documentVisibility: comparison.current.documentVisibility,
            execution: {
              busy: execution.busy,
              readyForEntry: execution.readyForEntry,
              readyToSubmit: execution.readyToSubmit,
              reason: execution.reason
            },
            evidence: {
              sawBusy,
              sawNewImage,
              sawImageCountIncrease,
              sawResponseChange,
              baselineImageCount: comparison.baselineImageCount,
              imageCount: comparison.current.images?.count || 0,
              imageCountDelta: comparison.imageCountDelta,
              responseCount: comparison.current.responses?.count || 0,
              newImages: comparison.newImages,
              newResponses: comparison.newResponses.map(item => ({ elementId: item.elementId, text: item.text })),
              newErrors: comparison.newErrors.map(item => item.text)
            }
          }, 'generation.poll');
          lastVerboseAt = Date.now();
        }

        if (unexpectedPathSince != null && Date.now() - unexpectedPathSince >= 2000) {
          return {
            status: 'failed',
            reason: `The page navigated away from the prompt's chat (${expectedPathKey} → ${currentPath}).`,
            failureType: 'unexpected-chat-navigation',
            elapsedMs: Date.now() - started,
            sawBusy,
            sawNewImage,
            sawImageCountIncrease,
            sawResponseChange,
            snapshot: comparison.current,
            evidence: comparison
          };
        }

        // A new visible image plus a composer that can accept the next prompt is stronger
        // evidence than a stale/adjacent error banner. This also follows Gemini's observable
        // contract: successful image generation increases the visible image count.
        const composerUsable = Boolean(execution.readyForEntry);
        // Require the count to remain above the pre-submit baseline at the moment completion is
        // accepted. `sawImageCountIncrease` is retained for diagnostics only; a transient image
        // placeholder that later disappears must not be promoted to a successful generation.
        const verifiedImageEvidence = comparison.imageCountIncreased;
        const verifiedTextEvidence = !requireImage && sawResponseChange;

        if (comparison.hasNewError && !(composerUsable && verifiedImageEvidence)) {
          return {
            status: 'failed',
            reason: comparison.newErrors[comparison.newErrors.length - 1]?.text || 'The site reported a generation error.',
            failureType: 'site-error',
            elapsedMs: Date.now() - started,
            sawBusy,
            sawNewImage,
            sawImageCountIncrease,
            sawResponseChange,
            snapshot: comparison.current,
            evidence: comparison
          };
        }

        // Gemini can leave a stale thinking/response wrapper mounted after the image is complete.
        // The enabled visible composer is the authoritative signal that the page can accept the
        // next prompt; do not wait for a secondary response-container mutation or stale overlay.
        if (composerUsable && (verifiedImageEvidence || verifiedTextEvidence)) {
          if (completionReadySince == null) completionReadySince = Date.now();
        } else {
          completionReadySince = null;
        }

        if (composerUsable && sawResponseChange && !verifiedImageEvidence && requireImage) {
          if (responseWithoutImageSince == null) responseWithoutImageSince = Date.now();
        } else if (verifiedImageEvidence || !sawResponseChange || !composerUsable) {
          responseWithoutImageSince = null;
        }

        const settledEnough = completionReadySince != null
          && Date.now() - completionReadySince >= resolveIdleSettleMs();
        if (settledEnough && (verifiedImageEvidence || verifiedTextEvidence)) {
          return {
            status: 'completed',
            reason: verifiedImageEvidence
              ? `The page image count increased from ${comparison.baselineImageCount} to ${comparison.currentImageCount}, and the textarea became ready for the next prompt.`
              : 'The assistant response changed and the textarea became ready for the next prompt.',
            elapsedMs: Date.now() - started,
            sawBusy,
            sawNewImage,
            sawImageCountIncrease,
            sawResponseChange,
            snapshot: comparison.current,
            evidence: comparison
          };
        }

        if (responseWithoutImageSince != null && Date.now() - responseWithoutImageSince >= resolveNoImageFailureGraceMs()) {
          return {
            status: 'failed',
            reason: 'The response finished without producing a prompt-specific new image.',
            failureType: 'no-image-output',
            elapsedMs: Date.now() - started,
            sawBusy,
            sawNewImage,
            sawImageCountIncrease,
            sawResponseChange,
            snapshot: comparison.current,
            evidence: comparison
          };
        }

        const remaining = Math.max(1, resolveTimeout() - (Date.now() - started));
        await utils.sleepWithSignal(Math.min(resolvePollIntervalMs(), remaining), this.signal);
      }

      const finalExecution = this.getExecutionState();
      const finalComparison = lastComparison || this.compare(baseline);
      return {
        status: 'timeout',
        reason: `Timed out after ${Math.round(timeout / 1000)} seconds waiting for verified prompt-specific generation completion.`,
        failureType: 'generation-timeout',
        elapsedMs: Date.now() - started,
        sawBusy,
        sawNewImage,
        sawImageCountIncrease,
        sawResponseChange,
        stillBusy: Boolean(finalExecution.busy),
        composerReady: Boolean(finalExecution.readyForEntry),
        snapshot: finalComparison.current,
        evidence: finalComparison
      };
    }
  }

  root.GenerationMonitor = GenerationMonitor;
})(globalThis);
