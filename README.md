# Prompt Pilot v1.1.0 — Fail-Soft Gemini Image Queue

Prompt Pilot is a Manifest V3 Chrome extension for automating prompt queues on supported AI sites. Google Gemini image generation has the strongest site-specific implementation.

Version 1.1.0 is designed around one operational requirement: **every queued prompt must reach a recorded terminal outcome—successful or failed—so an individual generation problem does not halt the batch.**

## What changed in v1.1.0

- A prompt is considered successfully generated when the **visible generated-image count increases relative to the pre-submit baseline** and the Gemini textarea is ready to accept the next prompt.
- A changed assistant-response wrapper is no longer required. This prevents the runner from waiting after the image is already visible and the composer is usable.
- Stale Gemini thinking UI is ignored when the textarea is enabled. A visible Stop/Cancel control remains an authoritative busy signal.
- Site errors, no-image responses, submission failures, readiness failures, and generation timeouts are logged against the affected prompt.
- After any configured finite retries are exhausted, the prompt is marked failed and the queue advances automatically.
- Prompt retries are disabled by default. A retry occurs only when retrying is enabled and the retry count is greater than zero. `0` means **no retries**.
- Existing v1 settings that used `0` as “unlimited retries” are migrated to the new fail-soft default so one bad prompt cannot loop forever.
- The docked panel, popup, and settings page save timing changes live. Active waits re-read their current values, so lowering or increasing a timeout applies without restarting the run.
- Optional image-download failures are isolated from generation success. A verified generated image is not resubmitted or marked failed because a download step failed.
- Automatic New-chat or original-chat navigation is checkpoint-protected and bounded. When automatic checkpoint resume is disabled, scheduled navigation is skipped so the active queue is not stranded by a page replacement.
- Progress now reports processed, successful, and failed counts separately.

## Completion and failure rules

### Successful image generation

For an image prompt, Prompt Pilot records success when both conditions are true:

1. The current visible generated-image count is greater than the count captured immediately before submission.
2. The prompt textarea is visible, enabled, and not blocked by a visible Stop/Cancel control.

The completion condition must remain stable for the configured idle-settle period. The default is 750 ms.

### Failed prompt

A prompt is recorded as failed when, for example:

- Gemini displays a recognized generation or service error.
- The response finishes without a new image.
- The generation timeout expires.
- The prompt cannot be entered or safely submitted.
- The page moves to an unexpected conversation.
- A required page setup step cannot be verified.
- An unexpected prompt-level automation exception occurs.

The failure record includes the prompt number/hash, attempt, failure type, reason, timestamp, and compact evidence. The next prompt is then processed.

### Run completion

The run finishes with a summary such as:

```text
Processed all 40 prompts: 37 succeeded and 3 failed.
```

A run may still be intentionally stopped by the operator. Browser shutdown, extension removal, account logout, or an unrecoverable page lifecycle interruption can also prevent continued execution; normal same-tab page reloads remain checkpoint-resumable.

## Live timing behavior

The active runner re-evaluates current settings during:

- generation observation;
- textarea/input readiness waits;
- safe Submit-control waits;
- submission acknowledgement waits;
- idle settling;
- no-image grace periods;
- retry backoff;
- timeout-recovery observation;
- New-chat/original-chat navigation waits;
- cooldown countdowns; and
- the total optional-download operation timeout.

Changes made in the docked panel are applied to the current runner immediately and persisted shortly afterward. Changes made in the popup or settings page are persisted and propagated to active supported-site tabs through Chrome storage events.

## Installation

1. Extract the release ZIP to a permanent folder.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Remove or disable the previous unpacked Prompt Pilot build.
5. Select **Load unpacked**.
6. Choose the extracted folder that directly contains `manifest.json`.
7. Refresh any Gemini tabs that were already open.
8. Open Gemini and click the Prompt Pilot toolbar icon to show the docked panel.

Chrome cannot load the ZIP directly; load the extracted folder.

## Recommended Gemini settings

- Generation timeout: `300000` ms
- Idle settle: `750` ms
- Cooldown: choose a value appropriate for the account and workload
- Retry failed prompt: disabled by default
- Prompt retries after first attempt: `0` means none
- Timeout reload recovery: available when a finite prompt retry is enabled
- Automatic checkpoint resume: keep enabled when using New-chat or timeout-reload recovery
- Adaptive selector discovery: enabled
- Enter fallback: disabled
- Log level: Debug for normal diagnosis; Verbose for intermittent timing issues

## Safety behavior

Prompt Pilot does not intentionally click controls identified as Stop, Cancel, Pause, Abort, or Interrupt.

Before submitting, the runner:

1. confirms that the expected prompt text is still present;
2. confirms that the control is a positive Send/Submit control;
3. performs a final synchronous safety check; and
4. dispatches only one native click for that attempt.

If a Send click may have been dispatched but the site does not acknowledge it promptly, Prompt Pilot observes the existing attempt instead of immediately clicking again.

## Durable checkpoints and logs

A per-tab checkpoint stores the queue and current prompt state so a normal same-tab reload can resume safely. Terminal jobs are retained with compact outcome evidence.

The docked panel activity log records structured events, including:

- `generation.completed`
- `generation.failed`
- `generation.timeout`
- `prompt.completed`
- `prompt.failed_continued`
- `prompt.retry_scheduled`
- `settings.live_applied`
- `download.failed`
- `download.unexpected_failure_contained`

The exported diagnostic JSON may contain queued prompt text and operational metadata. Treat it as potentially sensitive.

## Supported sites

Built-in configurations are included for:

- Google Gemini
- ChatGPT
- SeaArt
- Perplexity

Gemini receives strict composer-state, image-count, Create-image setup, and conversation-recovery handling. Other sites share the same queue framework but can require selector maintenance when their interfaces change.

## Validation

Run the included reliability suite from the extracted extension folder:

```bash
node tests/reliability.test.js
```

Static syntax and package checks used for this release:

```bash
find . -name '*.js' -not -path './.git/*' -print0 | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
git diff --check
```

See `RELIABILITY.md` for the execution model and `TEST_REPORT.md` for the validated scenarios.

## Operational limitations

Prompt Pilot cannot control Gemini service availability, account quota/rate limits, moderation decisions, authentication expiry, browser or operating-system shutdown, or future third-party DOM changes. The v1.1.0 behavior for prompt-level failures is to preserve evidence, record the prompt as failed after its finite retry policy, and continue the remaining queue rather than waiting indefinitely.
