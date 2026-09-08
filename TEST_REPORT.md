# Prompt Pilot v1.1.0 Validation Report

**Validation date:** August 20, 2026
**Build:** 1.1.0 — Fail-Soft Image Queue

## Scope

Validation targeted the reported Gemini failure modes:

- a failed image prompt stopping the entire queue;
- failure evidence not being recorded;
- waiting after the visible image count has already increased;
- requiring an unrelated assistant-response DOM mutation;
- treating a stale error or thinking wrapper as stronger than verified image success;
- starting the next prompt while a visible Stop control remains active;
- timing changes not affecting an active wait;
- old unlimited-retry settings keeping one prompt active indefinitely;
- optional download defects undoing successful image generation; and
- navigation recovery leaving the active runner on an unbounded wait or replacing the page while checkpoint auto-resume is disabled.

## Results

| Validation | Result |
|---|---:|
| Reliability tests | 13/13 passed |
| JavaScript syntax parsing | 20/20 files passed |
| Manifest JSON parse | Passed |
| Manifest/HTML asset references | Passed |
| Popup/options element bindings | Passed |
| Content-script injection parity | Passed |
| Never-resolving promise audit | Passed |
| Git whitespace/diff validation | Passed |

## Reliability-test coverage

The included `tests/reliability.test.js` verifies:

1. A v1 zero/unlimited retry configuration migrates to disabled finite retry behavior.
2. An explicit positive v1 retry limit remains enabled and finite after migration.
3. A DOM wait re-reads a lowered timeout while the wait is active.
4. Mixed failed and successful checkpoint outcomes advance in order and produce exact processed/success/failed counters.
5. Visible image-count growth plus a ready composer completes without a response-container mutation.
6. Verified image-count success overrides a stale adjacent error candidate.
7. A visible Stop/busy condition prevents premature completion until the textarea is truly ready for the next prompt.
8. A transient image-count increase that disappears before the textarea is ready does not create a false success.
9. A lowered generation timeout is honored by an already-running observation.
10. A live settings update applied through the production runner reaches the active monitor and changes its current deadline.
11. An unexpected optional-download failure cannot undo verified generation success.
12. A mixed three-prompt run (`failed → successful → failed`) logs both failures and reaches terminal completion instead of halting.
13. Timeout recovery returns a terminal prompt-level failure without navigation when automatic checkpoint resume is disabled.

## Commands executed

```bash
node tests/reliability.test.js
find . -name '*.js' -not -path './.git/*' -print0 | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
git diff --check
```

## Confirmed behavior

- Successful image generation is keyed to visible image-count increase and textarea readiness.
- Changed assistant-response markup is not required.
- Terminal prompt failures are logged and advanced after the finite retry policy.
- Default retry behavior is disabled with `0 = none`.
- Active timeout providers are re-evaluated during waits.
- A visible Gemini Stop control remains a hard busy signal.
- Stale thinking UI does not hold an enabled composer after image success.
- Processed, successful, and failed counters remain separate.
- Optional download failures are non-fatal after generation is verified.
- Navigation recovery is bounded and is not attempted when automatic checkpoint resume is disabled.

## Validation boundary

No authenticated live Gemini account was exercised in this container. The tests execute production state-machine and monitor modules with deterministic outcomes; they do not guarantee compatibility with every future Gemini UI revision. A selector change, service outage, account limit, logout, browser shutdown, or extension removal can still interrupt execution. The extension records and continues prompt-level failures while it remains active on a supported page.
