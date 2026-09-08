(function attachPromptPilotDefaults(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});

  root.DEFAULT_SETTINGS = Object.freeze({
    settingsSchemaVersion: 2,
    logLevel: 'debug',
    cooldownMs: 15000,
    generationTimeoutMs: 300000,
    submitTimeoutMs: 25000,
    idleSettleMs: 750,
    readyTimeoutMs: 30000,
    maxSubmitRetries: 3,
    promptParsingMode: 'lines',
    promptSeparator: '---',
    // Disabled by default: after an irreversible Send click, a second submission gesture can create duplicates.
    submitWithEnterFallback: false,
    waitForImageAfterSubmit: true,
    adaptiveDomSearch: true,
    autoResume: true,
    resumeMaxAgeHours: 24,
    logging: {
      persist: true,
      maxEntries: 2000,
      maxBytesPerRun: 1500000,
      maxPersistedRuns: 8,
      verbosePollIntervalMs: 2000,
      includeFullPromptText: false,
      promptPreviewChars: 180
    },
    retry: {
      enabled: false,
      // Number of retries after the first attempt. 0 means no retry.
      maxPromptRetries: 0,
      initialBackoffMs: 5000,
      maxBackoffMs: 60000,
      startRetryInNewChat: true
    },
    failureHandling: {
      // Prompt/site failures are terminal for that queue item, not for the batch.
      openNewChatWhenComposerIsBlocked: true,
      composerRecoveryTimeoutMs: 8000
    },
    recovery: {
      enabled: true,
      reloadTimedOutChat: true,
      maxReloadCyclesPerAttempt: 2,
      reopenTimeoutMs: 30000,
      captureConversationTimeoutMs: 30000,
      postReloadObservationMs: 45000,
      resumeObservationMs: 30000,
      settleMs: 1200,
      hardReloadFallback: true,
      requireOriginalChatReopen: false
    },
    panel: {
      dockSide: 'right',
      width: 448,
      minWidth: 360,
      maxWidth: 760,
      autoOpenOnSupportedSites: false
    },
    newChat: {
      enabled: false,
      every: 50
    },
    download: {
      enabled: false,
      clickNativeButton: true,
      captureNativeDownload: true,
      fallbackToPreviewImage: false,
      captureTimeoutMs: 25000,
      operationTimeoutMs: 90000,
      quality: 0.92,
      folder: 'PromptPilot',
      exifMaxChars: 10000,
      filenameTemplate: '{index}-{slug}.jpg'
    },
    siteOptions: {
      gemini: {
        enableCreateImageMode: true,
        ensureProMode: false
      },
      chatgpt: {},
      seaart: {},
      perplexity: {}
    }
  });
})(globalThis);
