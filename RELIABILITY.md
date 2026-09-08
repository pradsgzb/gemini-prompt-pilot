# Prompt Pilot v1.1.0 Reliability Model

## 1. Queue invariant

Every prompt is processed in index order and reaches one of two terminal states:

- `completed`: verified image-generation success; or
- `failed`: terminal prompt/site/automation failure after the configured finite retry policy.

Both terminal outcomes advance `currentIndex` exactly once. A prompt failure does not terminate the batch.

The public counters are:

- `processedCount`: successful plus failed terminal prompts;
- `successfulCount`: jobs with status `completed`;
- `failedCount`: jobs with status `failed`.

`completedCount` is retained for backward compatibility and mirrors `processedCount` in schema version 4 checkpoints.

## 2. Image completion contract

Before submitting a prompt, the generation monitor captures a baseline containing visible generated images, assistant-response containers, error candidates, document identity, and conversation path.

For Gemini image generation, completion requires:

1. `currentImageCount > baselineImageCount`; and
2. `readyForEntry === true` for the textarea; and
3. the condition remains true for the current `idleSettleMs`.

A response-container mutation is diagnostic evidence only; it is not a completion prerequisite. This specifically prevents a stale Gemini response/thinking wrapper from holding the queue after an image is visible and the composer is usable.

A visible Stop/Cancel control prevents `readyForEntry`. A stale thinking overlay does not prevent completion when the textarea is enabled and no Stop/Cancel control is visible.

## 3. Failure classification

The monitor or runner can return terminal failures such as:

- `site-error`
- `no-image-output`
- `generation-timeout`
- `unexpected-chat-navigation`
- `PROMPT_SUBMISSION_FAILED`
- `REQUIRED_SETUP_STEP_FAILED`
- `resume-chat-identity-unverified`
- `automation-error`
- `unhandled-prompt-error`

Recognized Gemini error text includes common generation failures, temporary service errors, rate limits, quota errors, and explicit no-image messages.

Every terminal failure is compacted into the job checkpoint with reason, failure type, timing, image-count evidence, response/error evidence, and the final page snapshot.

## 4. Failure-to-next-prompt flow

When an attempt fails:

1. The runner checks the current live retry settings.
2. A retry is allowed only when `retry.enabled === true`, `maxPromptRetries > 0`, and the finite retry limit has not been exhausted.
3. When no retry remains, `markFailedAndAdvance()` records the terminal failure.
4. `processedCount` and `failedCount` increase.
5. The runner attempts a bounded composer recovery or safe New-chat transition if needed.
6. The next queue item starts after the current live cooldown.

Unexpected prompt-level exceptions are caught by the same path. A run-level exception is contained by recording every remaining prompt as failed, allowing the run checkpoint to reach a terminal summary rather than remaining active indefinitely.

## 5. Retry semantics

`maxPromptRetries` means retries **after** the first attempt:

- `0`: no retry;
- `1`: at most two total attempts;
- `2`: at most three total attempts.

Retries are disabled by default. Version 1 settings in which `0` meant unlimited are migrated to disabled/zero. Explicit positive finite retry limits are preserved during migration.

Retry backoff is exponential and bounded by `initialBackoffMs` and `maxBackoffMs`. Both values are re-read during the active backoff, so lowering the delay takes effect without restarting the run.

## 6. Timeout recovery

Non-destructive timeout recovery is used only when a finite retry is available and recovery is enabled. The order is:

1. capture the original persistent conversation identity;
2. open a positively identified New-chat control;
3. reopen the exact original conversation;
4. observe the original attempt again without resubmitting; and
5. either accept verified completion, classify failure, or continue to the configured retry.

When retries are disabled, a generation timeout is logged as a failed prompt and the queue proceeds directly to the next item.

Navigation-based recovery is also disabled when checkpoint auto-resume is off. Scheduled New-chat boundaries are skipped in that mode, so a document-replacing navigation cannot strand the active queue. Direct original-chat navigation requires a committed checkpoint and uses a bounded wait; it never intentionally leaves the current runner on a permanently unresolved promise.

## 7. Submission boundary and duplicate control

Before a native Send click, the checkpoint records `submission-armed`. Immediately after dispatch, it records `submission-dispatched`.

After a click crosses this boundary, the same attempt does not issue a second native Send or Enter gesture merely because acknowledgement is slow. It observes generation evidence first.

The optional Enter fallback remains disabled by default and is permitted only when a native click was not dispatched.

## 8. Download isolation

Image generation is verified before optional downloading begins. Download errors are logged but do not:

- change a verified generation to failed;
- resubmit the prompt;
- prevent queue advancement; or
- stop later prompts.

The outer completion boundary also contains unexpected download-subsystem exceptions as a secondary safeguard.

## 9. Live settings propagation

The docked panel applies its form patch directly to the active runner, then saves it. Popup/options changes are saved to Chrome local storage; the content script listens for storage changes and replaces the active settings snapshot.

Active operations use value-provider functions rather than one-time timeout snapshots. The following are live during an operation:

- generation timeout;
- textarea readiness timeout;
- submit timeout and submit-control wait count;
- image idle-settle period;
- no-image grace period;
- polling interval;
- retry enablement, count, and backoff;
- timeout-recovery cycle count and observation timeout;
- navigation/reopen timeout and settle period;
- cooldown; and
- total download-operation timeout.

Timing values are normalized to finite numbers. Invalid external storage values fall back to safe defaults instead of creating a tight, indefinite polling loop.

## 10. Durable state

Checkpoint schema version 4 stores:

- run ownership and site identity;
- prompt queue and current index;
- processed/successful/failed counters;
- per-job status, phase, attempts, timestamps, and prompt hash;
- pre-submit baseline;
- submission boundary evidence;
- persistent conversation context; and
- compact terminal outcome evidence.

Routine checkpoint-write failures are logged and the current in-page batch continues; reload recovery may be unavailable until storage recovers. Normal page navigation/reinjection suspends the runner and leaves the checkpoint resumable.

## 11. Intentional stop behavior

The operator Stop command is the exception to automatic batch continuation. It aborts Prompt Pilot's waits and marks the checkpoint non-resumable. It does not click the website's Stop/Cancel control and does not attempt to terminate an already-running Gemini generation.

## 12. Troubleshooting

When a prompt fails unexpectedly:

1. Set logging to Debug or Verbose.
2. Review `baselineImageCount`, `currentImageCount`, and `imageCountDelta` in the generation outcome.
3. Confirm whether `readyForEntry` became true and whether a Stop control remained visible.
4. Review the failure type and recognized error text.
5. Export the activity log and checkpoint JSON from the docked panel.
6. Update Gemini selectors in the settings page if a site UI change has invalidated input, Send, Stop, response, error, or image selectors.

Do not share exported diagnostics without reviewing them; active checkpoints contain the queued prompts required for resume.

## 13. Scope boundary

The extension cannot guarantee third-party uptime, account quota, authentication continuity, browser power continuity, conversation-history retention, or future DOM compatibility. Within an active supported page, v1.1.0 is designed to contain prompt-level failures, preserve their evidence, and continue through the finite queue.
