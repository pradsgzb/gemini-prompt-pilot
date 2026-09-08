# Changelog

## 1.1.0 — Fail-soft image queue

### Completion monitoring

- Made visible generated-image count growth relative to the pre-submit baseline the primary Gemini image-success signal.
- Removed the requirement for a changed assistant-response container.
- Completes when image count has increased and the textarea is ready for the next prompt after the live idle-settle period.
- Ignores stale Gemini thinking UI when the composer is enabled, while retaining a visible Stop/Cancel control as a hard busy signal.
- Expanded common generation, service, rate-limit, quota, and no-image error recognition.

### Failure containment and queue progress

- Records terminal prompt failures and automatically advances to the next prompt.
- Added separate processed, successful, and failed counters in checkpoint state and user interfaces.
- Contains unexpected prompt-level exceptions and records remaining prompts as failed if a run-level exception escapes prompt isolation.
- Isolates optional download failures from verified generation success.
- Replaced an unbounded direct-navigation recovery promise with a bounded, checkpoint-protected navigation wait.
- Skips automatic New-chat navigation when checkpoint auto-resume is disabled, preventing a navigation from stranding the active queue.
- Produces a final processed/succeeded/failed batch summary.

### Retry migration

- Changed `0` prompt retries from unlimited to none.
- Disabled prompt retry by default.
- Migrates v1 unlimited-zero settings to the fail-soft default while preserving explicit positive finite retry limits.

### Live settings

- Applied docked-panel timing changes directly to the active runner.
- Added storage propagation from the popup and options page to active supported-site tabs.
- Made generation, readiness, submit, settle, retry, recovery, cooldown, and total-download waits re-read current settings during execution.
- Added finite-number normalization so malformed timing values cannot create a tight indefinite polling loop.

### User interface and diagnostics

- Updated retry wording to `0 = none`.
- Added live-save behavior to the docked panel, popup, and settings page.
- Updated progress displays to show processed, successful, and failed totals.
- Added image-count baseline/current/delta evidence to terminal outcomes and logs.

### Validation

- Added thirteen deterministic reliability tests for settings migration, dynamic waits, active-run settings propagation, persistent image-count completion, stale-error precedence, Stop-control gating, explicit failure logging, download isolation, mixed queue completion, and navigation-recovery safety.
- Validated all JavaScript files, manifest JSON, and Git diff whitespace.

## 1.0.0 — Reliability rebuild

### Queue correctness

- Replaced the previous linear prompt loop with a durable per-prompt state machine.
- Made verified completion the only operation that can increment `currentIndex`.
- Removed the timeout soft-success path that could move to the next prompt or a scheduled New chat.
- Added transactional rollback when a completion checkpoint cannot be persisted.
- Added per-tab run ownership and automatic resume after page navigation/reload.
- Added launch and resume locks to prevent concurrent runners on the same content-script instance.

### Submission safety

- Added durable `submission-armed`, `submission-dispatched`, and `submitted` checkpoints around the irreversible Send boundary.
- Prevented repeated Send clicks after a click has been dispatched but not acknowledged.
- Disabled Enter fallback by default.
- Restricted the optional Enter fallback to cases where no native click was dispatched.
- Added a centralized safe-click layer with final synchronous identity checks.
- Added hard blocking for Stop, Cancel, Pause, Abort, and Interrupt controls.
- Removed native-download cancellation behavior.

### Completion monitoring

- Added pre-submit DOM baselines for images, assistant responses, and errors.
- Added stable content signatures that ignore rotating signed-URL query parameters.
- Added multiset comparison to distinguish DOM recreation from an additional generated image.
- Required new image evidence plus changed assistant-response evidence and a stable idle composer for image completion.
- Added explicit no-image, site-error, unexpected-chat, and generation-timeout outcomes.

### Recovery and retry

- Added timeout recovery in the required order: New chat → exact original chat → observe original attempt.
- Added persistent conversation URL/history capture.
- Added same-origin direct navigation fallback when the exact history link is unavailable.
- Added automatic retries of the same current prompt with bounded exponential backoff.
- Added unlimited prompt retries as the default (`0`).
- Prevented scheduled New chat boundaries until the previous prompt is durably complete.
- Made enabled site setup steps verified gates rather than warnings that fail open.

### Diagnostics

- Added Debug and Verbose levels with structured event codes.
- Added prompt hash, attempt, phase, recovery cycle, DOM-control, evidence, checkpoint, and timing metadata.
- Added bounded persisted logs by run, bytes, entry count, and retained-run count.
- Added JSON export containing logs, checkpoint, settings, public state, version, and page context.
- Added explicit checkpoint write diagnostics and fail-closed storage behavior.

### Downloads

- Added operation timeouts and AbortSignal propagation.
- Preserved the platform's native full-resolution download as a fallback.
- Never cancels the original native download.
- Treats download failure as non-fatal after generation has already been verified.

### User interface

- Added reliability/retry/recovery controls to the docked panel, popup, and settings page.
- Renamed submit retry wording to **Submit-control wait cycles** to reflect that Send is not repeatedly clicked.
- Added run attempt/recovery state and persisted-log export.

### Validation

- Added Node tests for queue invariants, retries, completion evidence, recovery order, setup gates, stop propagation, storage bounds, checkpoint rollback, launch locking, and durable-storage failure.
- Added deterministic Chromium scenarios for unsafe-control blocking, DOM recreation, verified idle completion, retry ordering, timeout recovery, reload resume, ambiguous-click handling, and recovery failure.
- Added package/static checks for syntax, version consistency, referenced assets, content-script order, centralized clicks, and absence of download cancellation.

### Known limitations

- Live third-party site selectors can change without notice.
- The deterministic browser harness does not use a signed-in live Gemini account.
- Exactly-once submission cannot be mathematically guaranteed through an uninstrumented third-party web UI. The extension minimizes duplicate risk by treating dispatched gestures as ambiguous until observed and never advances the queue without verified completion.
