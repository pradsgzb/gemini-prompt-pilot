'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
global.location = { href: 'https://gemini.google.com/app/test-chat' };
Object.defineProperty(global, 'navigator', {
  value: { onLine: true },
  configurable: true
});
global.PromptPilot = {};
const localStorageData = new Map();
global.localStorage = {
  getItem(key) { return localStorageData.has(key) ? localStorageData.get(key) : null; },
  setItem(key, value) { localStorageData.set(key, String(value)); },
  removeItem(key) { localStorageData.delete(key); }
};

function load(relativePath) {
  require(path.join(rootDir, relativePath));
}

load('src/shared/constants.js');
load('src/shared/default-settings.js');
load('src/shared/utils.js');
load('src/shared/settings-repository.js');
load('src/content/dom.js');

// GenerationMonitor is tested with a deterministic comparison adapter. The observer itself is real.
load('src/content/generation-monitor.js');
load('src/content/run-checkpoint.js');
load('src/content/automation-runner.js');

const PP = global.PromptPilot;

function createLogger() {
  const entries = [];
  const logger = { entries };
  for (const level of ['error', 'warn', 'info', 'debug', 'verbose']) {
    logger[level] = (message, meta, event) => entries.push({ level, message, meta, event });
  }
  logger.setContext = () => {};
  logger.setLevel = () => {};
  return logger;
}

function createRepository() {
  const snapshots = [];
  return {
    snapshots,
    async saveActiveRun(_tabId, data) {
      snapshots.push(structuredClone(data));
      return data;
    },
    async saveRunState(data) {
      snapshots.push(structuredClone(data));
      return data;
    }
  };
}

async function testV1UnlimitedRetryMigrationBecomesFiniteAndFailSoft() {
  const settingsKey = `__promptPilot.fallback.${PP.STORAGE_KEYS.SETTINGS}`;
  localStorage.setItem(settingsKey, JSON.stringify({
    settingsSchemaVersion: 1,
    idleSettleMs: 3500,
    retry: { enabled: true, maxPromptRetries: 0 }
  }));

  const migrated = await new PP.SettingsRepository().getSettings();
  assert.equal(migrated.settingsSchemaVersion, 2);
  assert.equal(migrated.retry.enabled, false);
  assert.equal(migrated.retry.maxPromptRetries, 0);
  assert.equal(migrated.idleSettleMs, 750);

  localStorage.removeItem(settingsKey);
}

async function testV1FiniteRetryMigrationPreservesExplicitLimit() {
  const settingsKey = `__promptPilot.fallback.${PP.STORAGE_KEYS.SETTINGS}`;
  localStorage.setItem(settingsKey, JSON.stringify({
    settingsSchemaVersion: 1,
    retry: { enabled: true, maxPromptRetries: 2 }
  }));

  const migrated = await new PP.SettingsRepository().getSettings();
  assert.equal(migrated.settingsSchemaVersion, 2);
  assert.equal(migrated.retry.enabled, true);
  assert.equal(migrated.retry.maxPromptRetries, 2);

  localStorage.removeItem(settingsKey);
}

async function testDynamicDomWaitTimeoutUsesLiveValue() {
  let activeTimeout = 5000;
  setTimeout(() => { activeTimeout = 1000; }, 25);
  const started = Date.now();
  await assert.rejects(
    PP.Dom.waitFor(() => null, {
      timeout: () => activeTimeout,
      interval: 100,
      name: 'dynamic timeout test'
    }),
    /Timed out after 1000 ms/i
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 1500, `DOM wait should honor the live timeout; elapsed=${elapsed}`);
}

async function testCheckpointProcessesFailuresAndSuccesses() {
  const repository = createRepository();
  const checkpoint = new PP.RunCheckpoint(repository, createLogger(), { tabId: 7 });
  checkpoint.create(['first', 'second', 'third'], PP.DEFAULT_SETTINGS, { id: 'gemini' }, {
    tabId: 7,
    url: global.location.href
  });

  await checkpoint.beginJob();
  await checkpoint.beginAttempt();
  await checkpoint.markFailedAndAdvance({
    status: 'failed',
    failureType: 'site-error',
    reason: 'Gemini reported a generation failure.'
  });
  assert.equal(checkpoint.data.currentIndex, 1);
  assert.equal(checkpoint.data.processedCount, 1);
  assert.equal(checkpoint.data.successfulCount, 0);
  assert.equal(checkpoint.data.failedCount, 1);
  assert.equal(checkpoint.data.jobs[0].status, 'failed');

  await checkpoint.beginJob();
  await checkpoint.beginAttempt();
  await checkpoint.markComplete({
    status: 'completed',
    reason: 'Visible image count increased from 2 to 3.'
  });
  assert.equal(checkpoint.data.currentIndex, 2);
  assert.equal(checkpoint.data.processedCount, 2);
  assert.equal(checkpoint.data.successfulCount, 1);
  assert.equal(checkpoint.data.failedCount, 1);
  assert.equal(checkpoint.data.jobs[1].status, 'completed');

  await checkpoint.beginJob();
  await checkpoint.beginAttempt();
  await checkpoint.markFailedAndAdvance({
    status: 'failed',
    failureType: 'generation-timeout',
    reason: 'No generated image appeared before the timeout.'
  });
  await checkpoint.finish();

  assert.equal(checkpoint.data.currentIndex, 3);
  assert.equal(checkpoint.data.processedCount, 3);
  assert.equal(checkpoint.data.completedCount, 3);
  assert.equal(checkpoint.data.successfulCount, 1);
  assert.equal(checkpoint.data.failedCount, 2);
  assert.equal(checkpoint.data.status, PP.RUN_STATUS.COMPLETED);
  assert.equal(checkpoint.data.resumable, false);
}

function completedComparison(overrides = {}) {
  return {
    current: {
      pathKey: '/app/test-chat',
      documentVisibility: 'visible',
      images: { count: 3 },
      responses: { count: 1 },
      errors: { count: 0 }
    },
    sameDocument: true,
    comparisonMode: 'stable-content-multiset',
    baselineImageCount: 2,
    currentImageCount: 3,
    imageCountDelta: 1,
    imageCountIncreased: true,
    newImages: [{ contentSignature: 'new-image' }],
    newResponses: [],
    newErrors: [],
    hasNewImage: true,
    hasResponseChange: false,
    hasNewError: false,
    ...overrides
  };
}

async function testImageCountPlusReadyComposerCompletesWithoutResponseMutation() {
  const monitor = new PP.GenerationMonitor(
    { id: 'gemini', selectors: {} },
    { generationTimeoutMs: 1000, idleSettleMs: 0, logging: { verbosePollIntervalMs: 999999 } },
    createLogger(),
    new AbortController().signal,
    () => ({ busy: false, inputReady: true, readyForEntry: true, readyToSubmit: true, reason: 'ready' })
  );
  monitor.compare = () => completedComparison();

  const outcome = await monitor.observe({}, {
    timeout: 1000,
    idleSettleMs: 0,
    pollIntervalMs: 100,
    requireImage: true,
    expectedPathKey: '/app/test-chat'
  });

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.sawImageCountIncrease, true);
  assert.equal(outcome.sawResponseChange, false);
  assert.match(outcome.reason, /image count increased from 2 to 3/i);
}

async function testImageSuccessWinsOverAdjacentStaleError() {
  const monitor = new PP.GenerationMonitor(
    { id: 'gemini', selectors: {} },
    { generationTimeoutMs: 1000, idleSettleMs: 0, logging: { verbosePollIntervalMs: 999999 } },
    createLogger(),
    new AbortController().signal,
    () => ({ busy: false, inputReady: true, readyForEntry: true, readyToSubmit: true, reason: 'ready' })
  );
  monitor.compare = () => completedComparison({
    hasNewError: true,
    newErrors: [{ text: 'Try again' }]
  });

  const outcome = await monitor.observe({}, {
    timeout: 1000,
    idleSettleMs: 0,
    pollIntervalMs: 100,
    requireImage: true,
    expectedPathKey: '/app/test-chat'
  });
  assert.equal(outcome.status, 'completed');
}

async function testVisibleStopControlPreventsPrematureCompletion() {
  let poll = 0;
  const monitor = new PP.GenerationMonitor(
    { id: 'gemini', selectors: {} },
    { generationTimeoutMs: 1000, idleSettleMs: 0, logging: { verbosePollIntervalMs: 999999 } },
    createLogger(),
    new AbortController().signal,
    () => {
      poll += 1;
      return poll < 2
        ? { busy: true, inputReady: true, readyForEntry: false, reason: 'Stop control visible' }
        : { busy: false, inputReady: true, readyForEntry: true, reason: 'ready' };
    }
  );
  monitor.compare = () => completedComparison();

  const started = Date.now();
  const outcome = await monitor.observe({}, {
    timeout: 1000,
    idleSettleMs: 0,
    pollIntervalMs: 100,
    requireImage: true,
    expectedPathKey: '/app/test-chat'
  });
  assert.equal(outcome.status, 'completed');
  assert.ok(Date.now() - started >= 80, 'completion should wait until readyForEntry becomes true');
}

async function testTransientImageCountIncreaseDoesNotCreateFalseSuccess() {
  let poll = 0;
  const monitor = new PP.GenerationMonitor(
    { id: 'gemini', selectors: {} },
    { generationTimeoutMs: 1000, idleSettleMs: 0, logging: { verbosePollIntervalMs: 999999 } },
    createLogger(),
    new AbortController().signal,
    () => ({ busy: false, inputReady: true, readyForEntry: poll > 1, reason: poll > 1 ? 'ready' : 'not ready' })
  );
  monitor.compare = () => {
    poll += 1;
    return poll === 1
      ? completedComparison()
      : completedComparison({
          currentImageCount: 2,
          imageCountDelta: 0,
          imageCountIncreased: false,
          newImages: [],
          hasNewImage: false
        });
  };

  const outcome = await monitor.observe({}, {
    timeout: 1000,
    idleSettleMs: 0,
    pollIntervalMs: 100,
    requireImage: true,
    expectedPathKey: '/app/test-chat'
  });

  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.sawImageCountIncrease, true, 'the transient increase should remain available as diagnostic evidence');
  assert.equal(outcome.evidence.imageCountIncreased, false, 'success requires the current count to remain above baseline');
}

async function testLoweredTimeoutTakesEffectDuringActiveObservation() {
  let activeTimeout = 5000;
  const monitor = new PP.GenerationMonitor(
    { id: 'gemini', selectors: {} },
    { generationTimeoutMs: 5000, idleSettleMs: 0, logging: { verbosePollIntervalMs: 999999 } },
    createLogger(),
    new AbortController().signal,
    () => ({ busy: false, inputReady: true, readyForEntry: true, reason: 'ready' })
  );
  monitor.compare = () => completedComparison({
    currentImageCount: 2,
    imageCountDelta: 0,
    imageCountIncreased: false,
    newImages: [],
    hasNewImage: false
  });

  setTimeout(() => { activeTimeout = 1000; }, 25);
  const started = Date.now();
  const outcome = await monitor.observe({}, {
    timeout: () => activeTimeout,
    idleSettleMs: 0,
    pollIntervalMs: 100,
    requireImage: true,
    expectedPathKey: '/app/test-chat'
  });
  const elapsed = Date.now() - started;

  assert.equal(outcome.status, 'timeout');
  assert.ok(elapsed >= 900 && elapsed < 1500, `lowered timeout should be honored within the active run; elapsed=${elapsed}`);
}

async function testRunnerLiveSettingsUpdateReachesActiveMonitor() {
  const logger = createLogger();
  const runner = new PP.AutomationRunner(
    { id: 'gemini', name: 'Google Gemini', selectors: {} },
    PP.Utils.deepMerge(PP.DEFAULT_SETTINGS, {
      generationTimeoutMs: 5000,
      idleSettleMs: 0,
      logging: { verbosePollIntervalMs: 999999 }
    }),
    logger,
    () => {},
    { repository: createRepository(), tabContext: { tabId: 11, url: global.location.href } }
  );
  const monitor = new PP.GenerationMonitor(
    runner.config,
    runner.settings,
    logger,
    new AbortController().signal,
    () => ({ busy: false, inputReady: true, readyForEntry: true, reason: 'ready' })
  );
  monitor.compare = () => completedComparison({
    currentImageCount: 2,
    imageCountDelta: 0,
    imageCountIncreased: false,
    newImages: [],
    hasNewImage: false
  });
  runner.monitor = monitor;

  setTimeout(() => runner.updateSettings({ generationTimeoutMs: 1000 }), 25);
  const started = Date.now();
  const outcome = await monitor.observe({}, {
    timeout: () => runner.getNumberSetting('generationTimeoutMs', 5000, 1000),
    idleSettleMs: () => runner.getNumberSetting('idleSettleMs', 0, 0),
    pollIntervalMs: 100,
    requireImage: true,
    expectedPathKey: '/app/test-chat'
  });
  const elapsed = Date.now() - started;

  assert.equal(outcome.status, 'timeout');
  assert.equal(runner.monitor.settings.generationTimeoutMs, 1000);
  assert.ok(elapsed >= 900 && elapsed < 1500, `active monitor should use the runner's live settings; elapsed=${elapsed}`);
  assert.ok(logger.entries.some(entry => entry.meta?.event === 'settings.live_applied'));
}

async function testUnexpectedDownloadFailureCannotUndoVerifiedGeneration() {
  const repository = createRepository();
  const runner = new PP.AutomationRunner(
    { id: 'gemini', name: 'Google Gemini', selectors: {} },
    PP.Utils.deepMerge(PP.DEFAULT_SETTINGS, { download: { enabled: true } }),
    createLogger(),
    () => {},
    { repository, tabContext: { tabId: 9, url: global.location.href } }
  );
  runner.checkpoint.create(['download isolation'], runner.settings, runner.config, {
    tabId: 9,
    url: global.location.href
  });
  await runner.checkpoint.beginJob();
  await runner.checkpoint.beginAttempt();
  runner.downloadGeneratedImage = async () => {
    throw new Error('Synthetic converter defect');
  };

  await runner.completeJob(runner.checkpoint.currentJob, {
    status: 'completed',
    reason: 'Visible image count increased from 1 to 2.',
    sawImageCountIncrease: true,
    evidence: { baselineImageCount: 1, currentImageCount: 2, imageCountDelta: 1 }
  });

  assert.equal(runner.checkpoint.data.currentIndex, 1);
  assert.equal(runner.checkpoint.data.successfulCount, 1);
  assert.equal(runner.checkpoint.data.failedCount, 0);
  assert.equal(runner.checkpoint.data.jobs[0].status, 'completed');
}

async function testRunnerCompletesMixedQueueInsteadOfHalting() {
  const repository = createRepository();
  const logger = createLogger();
  const statuses = [];
  const settings = PP.Utils.deepMerge(PP.DEFAULT_SETTINGS, {
    cooldownMs: 0,
    retry: { enabled: false, maxPromptRetries: 0 },
    download: { enabled: false }
  });
  const runner = new PP.AutomationRunner(
    { id: 'gemini', name: 'Google Gemini', selectors: { newChat: [] }, preRunSteps: [] },
    settings,
    logger,
    state => statuses.push(state),
    { repository, tabContext: { tabId: 8, url: global.location.href } }
  );

  runner.configureComponents = function configureForTest() {
    this.monitor = {};
    this.recovery = {};
  };
  runner.preparePageForRunReliably = async () => {};
  runner.prepareComposerAfterFailure = async () => {};
  runner.processCurrentJob = async function processForTest(job) {
    await this.checkpoint.beginJob();
    await this.checkpoint.beginAttempt();
    if (job.index === 1) {
      await this.completeJob(job, {
        status: 'completed',
        reason: 'Visible image count increased.',
        sawImageCountIncrease: true,
        evidence: { baselineImageCount: 1, currentImageCount: 2, imageCountDelta: 1 }
      });
    } else {
      await this.failJobAndContinue(job, {
        status: 'failed',
        failureType: job.index === 0 ? 'site-error' : 'generation-timeout',
        reason: job.index === 0 ? 'Gemini failed to create the image.' : 'Generation timed out.'
      });
    }
  };

  const finalState = await runner.start(['one', 'two', 'three']);
  assert.equal(finalState.status, PP.RUN_STATUS.COMPLETED);
  assert.equal(finalState.processedCount, 3);
  assert.equal(finalState.successfulCount, 1);
  assert.equal(finalState.failedCount, 2);
  assert.match(finalState.message, /Processed all 3 prompts/i);
  assert.equal(runner.checkpoint.data.jobs[0].status, 'failed');
  assert.equal(runner.checkpoint.data.jobs[1].status, 'completed');
  assert.equal(runner.checkpoint.data.jobs[2].status, 'failed');
  assert.ok(statuses.some(state => state.failedCount === 1 && state.processedCount === 1));
  const failureLogs = logger.entries.filter(entry => entry.meta?.event === 'prompt.failed_continued');
  assert.equal(failureLogs.length, 2, 'each failed prompt should produce an explicit fail-and-continue log entry');
}

async function testTimeoutRecoveryDoesNotNavigateWhenAutoResumeIsDisabled() {
  const runner = new PP.AutomationRunner(
    { id: 'gemini', name: 'Google Gemini', selectors: {} },
    PP.Utils.deepMerge(PP.DEFAULT_SETTINGS, {
      autoResume: false,
      recovery: { enabled: true, reloadTimedOutChat: true }
    }),
    createLogger(),
    () => {},
    { repository: createRepository(), tabContext: { tabId: 10, url: global.location.href } }
  );

  const outcome = await runner.recoverTimedOutAttempt({}, {}, {
    status: 'timeout',
    failureType: 'generation-timeout',
    reason: 'Generation timed out.'
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.failureType, 'timeout-recovery-auto-resume-disabled');
  assert.match(outcome.reason, /automatic checkpoint resume is disabled/i);
}

async function main() {
  const tests = [
    testV1UnlimitedRetryMigrationBecomesFiniteAndFailSoft,
    testV1FiniteRetryMigrationPreservesExplicitLimit,
    testDynamicDomWaitTimeoutUsesLiveValue,
    testCheckpointProcessesFailuresAndSuccesses,
    testImageCountPlusReadyComposerCompletesWithoutResponseMutation,
    testImageSuccessWinsOverAdjacentStaleError,
    testVisibleStopControlPreventsPrematureCompletion,
    testTransientImageCountIncreaseDoesNotCreateFalseSuccess,
    testLoweredTimeoutTakesEffectDuringActiveObservation,
    testRunnerLiveSettingsUpdateReachesActiveMonitor,
    testUnexpectedDownloadFailureCannotUndoVerifiedGeneration,
    testRunnerCompletesMixedQueueInsteadOfHalting,
    testTimeoutRecoveryDoesNotNavigateWhenAutoResumeIsDisabled
  ];

  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`\n${tests.length} reliability tests passed.\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
