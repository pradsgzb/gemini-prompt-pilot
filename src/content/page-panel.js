(function attachPromptPilotPagePanel(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const dom = root.Dom;
  const messageTypes = root.MESSAGE_TYPES;
  const statuses = root.RUN_STATUS;

  class PagePanel {
    constructor(options) {
      this.repository = options.repository;
      this.getState = options.getState;
      this.startRun = options.startRun;
      this.stopRun = options.stopRun;
      this.getContext = options.getContext;
      this.onSettingsChanged = typeof options.onSettingsChanged === 'function' ? options.onSettingsChanged : () => {};
      this.host = null;
      this.shadow = null;
      this.elements = {};
      this.activeSettings = null;
      this.activeCapabilities = null;
      this.activeSite = null;
      this.latestState = null;
      this.activeRunId = null;
      this.logs = [];
      this.disposers = [];
      this.resizeSaveTimer = null;
      this.settingsSaveTimer = null;
      this.settingsChangeSequence = 0;
      this.isApplyingSettings = false;
    }

    async toggle() {
      if (!this.host) await this.open();
      else if (this.host.dataset.collapsed === 'true') this.expand();
      else this.collapse();
      return { visible: Boolean(this.host), collapsed: this.host?.dataset.collapsed === 'true' };
    }

    async open() {
      if (!this.host) this.create();
      this.host.style.display = 'block';
      this.host.dataset.collapsed = 'false';
      await this.refresh();
      this.elements.promptText?.focus?.();
      return { visible: true };
    }

    collapse() {
      if (!this.host) return;
      this.host.dataset.collapsed = 'true';
    }

    expand() {
      if (!this.host) return;
      this.host.dataset.collapsed = 'false';
      this.refresh().catch(() => {});
    }

    close() {
      while (this.disposers.length) {
        try { this.disposers.pop()(); } catch (_) {}
      }
      if (this.resizeSaveTimer) clearTimeout(this.resizeSaveTimer);
      if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
      this.host?.remove();
      this.host = null;
      this.shadow = null;
      this.elements = {};
    }

    create() {
      document.getElementById(dom.PANEL_HOST_ID)?.remove();
      this.close();
      this.host = document.createElement('aside');
      this.host.id = dom.PANEL_HOST_ID;
      this.host.setAttribute('aria-label', 'Prompt Pilot docked panel');
      this.host.dataset.collapsed = 'false';
      this.host.dataset.density = 'regular';
      this.host.dataset.promptPilotVersion = root.VERSION || '';
      this.host.dataset.promptPilotRuntimeId = utils.getChromeRuntimeId?.() || '';
      this.host.style.cssText = [
        'position:fixed',
        'top:12px',
        'right:12px',
        'bottom:12px',
        'width:448px',
        'max-width:calc(100vw - 24px)',
        'z-index:2147483647',
        'display:block',
        'pointer-events:auto'
      ].join(';');
      this.shadow = this.host.attachShadow({ mode: 'open' });
      this.shadow.innerHTML = this.template();
      document.documentElement.appendChild(this.host);
      this.collectElements();
      this.bindEvents();
      this.syncPanelDensity();
    }

    template() {
      return `
        <style>${this.styles()}</style>
        <button id="collapsedTab" class="collapsed-tab" type="button" title="Open Prompt Pilot" aria-label="Open Prompt Pilot">
          <span>PP</span>
        </button>
        <section class="shell" role="dialog" aria-label="Prompt Pilot automation panel">
          <div id="resizeHandle" class="resize-rail" role="separator" aria-label="Resize Prompt Pilot panel" title="Drag to resize"></div>

          <header class="topbar">
            <div class="brand-mark" aria-hidden="true">PP</div>
            <div class="brand-copy">
              <h1>Prompt Pilot</h1>
              <p id="siteSummary">Detecting site…</p>
            </div>
            <span id="statusPill" class="pill idle">Idle</span>
            <button id="collapseButton" class="icon-button" type="button" title="Collapse panel" aria-label="Collapse panel">−</button>
            <button id="closeButton" class="icon-button" type="button" title="Close panel" aria-label="Close panel">×</button>
          </header>

          <main class="scroll-area">
            <section class="dashboard" aria-label="Run dashboard">
              <article class="metric-card image-card">
                <span class="eyebrow">Image being generated</span>
                <strong id="bigCounter">#0 / #0</strong>
                <div class="metric-footer">
                  <span id="phaseBadge" class="phase-badge">Ready</span>
                  <span id="progressText">0/0</span>
                </div>
              </article>

              <article id="timerCard" class="timer-card idle" aria-live="polite">
                <div class="timer-copy">
                  <span class="eyebrow">Countdown</span>
                  <strong id="timerLabel">Cooldown timer</strong>
                  <p id="timerDescription">Start a run to see the next-prompt countdown.</p>
                </div>
                <div id="timerDial" class="timer-dial" style="--timer-progress:0%">
                  <span id="timerValue">00:00</span>
                </div>
              </article>
            </section>

            <section class="progress-card" aria-label="Progress">
              <div class="progress-meta">
                <span id="runMessage">Ready</span>
                <span id="activePrompt">No prompt running</span>
              </div>
              <div class="progress-track" aria-hidden="true"><div id="progressFill"></div></div>
            </section>

            <section class="panel-card controls-card">
              <div class="section-title">
                <div>
                  <span>Run setup</span>
                  <small>Parsing, cooldown and log visibility</small>
                </div>
              </div>
              <div class="compact-grid">
                <label>
                  <span>Prompt parsing</span>
                  <select id="promptMode">
                    <option value="lines">One prompt per line</option>
                    <option value="blocks">Blank line blocks</option>
                    <option value="separator">Custom separator</option>
                  </select>
                </label>
                <label id="separatorWrap" class="hidden">
                  <span>Separator</span>
                  <input id="promptSeparator" type="text" value="---">
                </label>
                <label>
                  <span>Cooldown, ms</span>
                  <input id="cooldownMs" type="number" min="0" step="1000" inputmode="numeric">
                </label>
                <label>
                  <span>Log level</span>
                  <select id="logLevel">
                    <option value="error">Error</option>
                    <option value="warn">Warn</option>
                    <option value="info">Info</option>
                    <option value="debug">Debug</option>
                    <option value="verbose">Verbose</option>
                  </select>
                </label>
              </div>
            </section>

            <section class="panel-card prompt-panel">
              <div class="section-title">
                <div>
                  <span>Prompt queue</span>
                  <small>Paste your prompts below</small>
                </div>
                <strong id="promptCount" class="count-chip">0 prompts</strong>
              </div>
              <textarea id="promptText" spellcheck="false" placeholder="Paste prompts here, one prompt per line"></textarea>
            </section>

            <section class="panel-card options-panel">
              <div class="section-title tight">
                <div>
                  <span>Automation options</span>
                  <small>Site-aware controls appear when supported</small>
                </div>
              </div>

              <label id="newChatWrap" class="check-row hidden">
                <input id="newChatEnabled" type="checkbox">
                <span>New chat after every</span>
                <input id="newChatEvery" type="number" min="1" step="1" inputmode="numeric">
                <span>images</span>
              </label>

              <label id="downloadWrap" class="check-row hidden">
                <input id="downloadEnabled" type="checkbox">
                <span>Click the native full-resolution download button and save JPEG with prompt EXIF</span>
              </label>

              <details class="advanced">
                <summary>Reliability, retry and recovery</summary>
                <div class="advanced-grid">
                  <label><span>Generation timeout, ms</span><input id="generationTimeoutMs" type="number" min="1000" step="1000" inputmode="numeric"></label>
                  <label><span>Idle settle, ms</span><input id="idleSettleMs" type="number" min="0" step="100" inputmode="numeric"></label>
                  <label><span>Submit timeout, ms</span><input id="submitTimeoutMs" type="number" min="1000" step="1000" inputmode="numeric"></label>
                  <label><span>Submit-control wait cycles</span><input id="maxSubmitRetries" type="number" min="1" max="10" step="1" inputmode="numeric"></label>
                  <label><span>Prompt retries after first attempt (0 = none)</span><input id="maxPromptRetries" type="number" min="0" step="1" inputmode="numeric"></label>
                  <label><span>Initial retry backoff, ms</span><input id="retryInitialBackoffMs" type="number" min="0" step="1000" inputmode="numeric"></label>
                  <label><span>Maximum retry backoff, ms</span><input id="retryMaxBackoffMs" type="number" min="0" step="1000" inputmode="numeric"></label>
                  <label><span>Reload cycles per attempt</span><input id="maxReloadCyclesPerAttempt" type="number" min="1" max="10" step="1" inputmode="numeric"></label>
                  <label><span>Post-reload observation, ms</span><input id="postReloadObservationMs" type="number" min="5000" step="1000" inputmode="numeric"></label>
                </div>
                <label class="inline-check"><input id="retryEnabled" type="checkbox"> Retry failed prompts up to the positive limit above</label>
                <label class="inline-check"><input id="startRetryInNewChat" type="checkbox"> Start failed-prompt retries in a fresh chat when available</label>
                <label class="inline-check"><input id="reloadTimedOutChat" type="checkbox"> On timeout, open New chat and reopen the original chat before retrying</label>
                <label class="inline-check"><input id="adaptiveDomSearch" type="checkbox"> Use adaptive selector discovery</label>
                <p class="hint">Successful image creation is detected by an increase in the page's visible image count plus a ready textarea. Failures are logged and the queue continues to the next prompt. Timing changes apply to active waits immediately.</p>
              </details>
            </section>

            <section class="log-panel">
              <div class="section-title tight">
                <div><span>Activity log</span><small>Newest events first</small></div>
                <div class="log-actions">
                  <button id="exportLogs" class="ghost-button" type="button">Export</button>
                  <button id="clearLogs" class="ghost-button" type="button">Clear</button>
                </div>
              </div>
              <div id="logs" class="logs"></div>
            </section>
          </main>

          <footer class="actionbar">
            <button id="optionsButton" class="secondary" type="button">Settings</button>
            <button id="stopButton" class="danger" type="button" disabled>Stop</button>
            <button id="startButton" class="primary" type="button">Start run</button>
          </footer>
        </section>
      `;
    }

    styles() {
      return `
        :host {
          all: initial;
          color-scheme: light;
          --bg: rgba(248, 250, 252, 0.98);
          --card: rgba(255, 255, 255, 0.92);
          --card-strong: rgba(255, 255, 255, 0.98);
          --text: #0f172a;
          --muted: #64748b;
          --soft: #f1f5f9;
          --line: rgba(148, 163, 184, 0.28);
          --line-strong: rgba(148, 163, 184, 0.48);
          --primary: #1a73e8;
          --primary-2: #7c3aed;
          --primary-dark: #1558b0;
          --danger: #dc2626;
          --success: #059669;
          --warning: #d97706;
          --shadow: 0 26px 80px rgba(15, 23, 42, 0.23);
          --radius-xl: 30px;
          --radius-lg: 24px;
          --radius-md: 18px;
          --font: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-family: var(--font);
        }
        *, *::before, *::after { box-sizing: border-box; }
        .shell {
          position: relative;
          width: 100%;
          height: 100%;
          display: grid;
          grid-template-rows: auto 1fr auto;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.86);
          border-radius: var(--radius-xl);
          background:
            radial-gradient(circle at 12% 0%, rgba(26, 115, 232, 0.20), transparent 28%),
            radial-gradient(circle at 92% 10%, rgba(124, 58, 237, 0.16), transparent 34%),
            linear-gradient(180deg, rgba(255,255,255,0.98), var(--bg));
          box-shadow: var(--shadow);
          color: var(--text);
          font-family: var(--font);
          backdrop-filter: blur(20px) saturate(1.12);
        }
        .resize-rail {
          position: absolute;
          z-index: 5;
          top: 22px;
          bottom: 22px;
          left: -4px;
          width: 12px;
          cursor: ew-resize;
          border-radius: 999px;
        }
        .resize-rail::after {
          content: "";
          position: absolute;
          top: 50%;
          left: 4px;
          width: 4px;
          height: 64px;
          transform: translateY(-50%);
          border-radius: 999px;
          background: rgba(100, 116, 139, 0.28);
          transition: background 0.16s ease, height 0.16s ease;
        }
        .resize-rail:hover::after,
        .resize-rail:focus-visible::after {
          height: 96px;
          background: linear-gradient(180deg, var(--primary), var(--primary-2));
        }
        .collapsed-tab {
          position: fixed;
          right: 16px;
          top: 92px;
          display: none;
          width: 56px;
          height: 56px;
          border: 0;
          border-radius: 20px;
          color: #fff;
          background: linear-gradient(135deg, var(--primary), var(--primary-2));
          box-shadow: 0 18px 42px rgba(15, 23, 42, 0.26);
          font: 950 16px/1 var(--font);
          cursor: pointer;
        }
        .collapsed-tab span { letter-spacing: -0.08em; }
        :host([data-collapsed="true"]) { width: 76px !important; max-width: 76px !important; }
        :host([data-collapsed="true"]) .shell { display: none; }
        :host([data-collapsed="true"]) .collapsed-tab { display: grid; place-items: center; }

        .topbar {
          display: grid;
          grid-template-columns: 46px minmax(0, 1fr) auto auto auto;
          gap: 10px;
          align-items: center;
          padding: 14px 14px 10px;
        }
        .brand-mark {
          width: 46px;
          height: 46px;
          display: grid;
          place-items: center;
          border-radius: 18px;
          color: #fff;
          background: linear-gradient(135deg, var(--primary), var(--primary-2));
          box-shadow: 0 14px 30px rgba(26, 115, 232, 0.22);
          font: 950 16px/1 var(--font);
          letter-spacing: -0.08em;
        }
        h1, p { margin: 0; }
        h1 {
          font: 900 20px/1.02 var(--font);
          letter-spacing: -0.055em;
          color: var(--text);
        }
        .brand-copy { min-width: 0; }
        .brand-copy p {
          margin-top: 4px;
          color: var(--muted);
          font: 700 12px/1.35 var(--font);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pill, .phase-badge, .count-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          white-space: nowrap;
          font: 900 11px/1 var(--font);
          letter-spacing: 0.055em;
          text-transform: uppercase;
        }
        .pill {
          min-height: 30px;
          padding: 8px 10px;
          color: #334155;
          background: #e2e8f0;
        }
        .pill.running, .pill.preparing, .pill.cooldown, .pill.stopping, .pill.recovering, .pill.retrying { color: #174ea6; background: #dbeafe; }
        .pill.completed { color: #047857; background: #d1fae5; }
        .pill.error { color: #b91c1c; background: #fee2e2; }
        .pill.stopped { color: #92400e; background: #fef3c7; }
        .icon-button {
          width: 32px;
          height: 32px;
          display: grid;
          place-items: center;
          border: 1px solid var(--line);
          border-radius: 13px;
          background: rgba(255, 255, 255, 0.92);
          color: var(--text);
          font: 900 18px/1 var(--font);
          cursor: pointer;
          transition: transform 0.14s ease, background 0.14s ease, border-color 0.14s ease;
        }
        .icon-button:hover { transform: translateY(-1px); border-color: var(--line-strong); background: white; }

        .scroll-area {
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 0 14px 14px;
          overflow: auto;
          scrollbar-width: thin;
        }
        .dashboard {
          display: grid;
          grid-template-columns: 0.95fr 1.05fr;
          gap: 12px;
        }
        .panel-card,
        .metric-card,
        .timer-card,
        .progress-card,
        .log-panel {
          border: 1px solid var(--line);
          background: var(--card);
          box-shadow: 0 14px 34px rgba(15, 23, 42, 0.08);
          backdrop-filter: blur(14px);
        }
        .metric-card,
        .timer-card,
        .progress-card,
        .panel-card,
        .log-panel { border-radius: var(--radius-lg); }
        .metric-card {
          min-width: 0;
          padding: 16px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 14px;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.97), rgba(241,245,249,0.92));
        }
        .eyebrow {
          display: block;
          color: var(--muted);
          font: 950 11px/1.15 var(--font);
          letter-spacing: 0.085em;
          text-transform: uppercase;
        }
        #bigCounter {
          display: block;
          color: var(--text);
          font: 950 clamp(34px, 7.4vw, 54px)/0.88 var(--font);
          letter-spacing: -0.085em;
          font-variant-numeric: tabular-nums;
        }
        .metric-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          color: var(--muted);
          font: 850 12px/1 var(--font);
        }
        .phase-badge {
          min-height: 26px;
          padding: 7px 9px;
          color: #174ea6;
          background: #dbeafe;
        }
        .timer-card {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 104px;
          align-items: center;
          gap: 14px;
          padding: 16px;
          overflow: hidden;
          background:
            radial-gradient(circle at 90% 0%, rgba(26, 115, 232, 0.13), transparent 40%),
            var(--card-strong);
        }
        .timer-copy { min-width: 0; }
        #timerLabel {
          display: block;
          margin-top: 7px;
          color: var(--text);
          font: 900 18px/1.05 var(--font);
          letter-spacing: -0.035em;
        }
        #timerDescription {
          margin-top: 7px;
          color: var(--muted);
          font: 700 12px/1.45 var(--font);
        }
        .timer-dial {
          --timer-progress: 0%;
          width: 98px;
          height: 98px;
          display: grid;
          place-items: center;
          border-radius: 50%;
          background: conic-gradient(var(--primary) var(--timer-progress), #e2e8f0 0);
          box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.06);
          position: relative;
        }
        .timer-dial::after {
          content: "";
          position: absolute;
          inset: 9px;
          border-radius: 50%;
          background: white;
          box-shadow: inset 0 0 0 1px rgba(226, 232, 240, 0.95);
        }
        #timerValue {
          position: relative;
          z-index: 1;
          color: var(--text);
          font: 950 21px/1 var(--font);
          letter-spacing: -0.05em;
          font-variant-numeric: tabular-nums;
        }
        .timer-card.cooldown .timer-dial { background: conic-gradient(var(--warning) var(--timer-progress), #e2e8f0 0); }
        .timer-card.completed .timer-dial { background: conic-gradient(var(--success) 100%, #e2e8f0 0); }
        .timer-card.error .timer-dial { background: conic-gradient(var(--danger) 100%, #fee2e2 0); }

        .progress-card { padding: 14px; }
        .progress-meta {
          display: grid;
          grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
          gap: 10px;
          align-items: center;
          margin-bottom: 10px;
          color: var(--muted);
          font: 800 12px/1.35 var(--font);
        }
        #runMessage, #activePrompt {
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        #activePrompt { text-align: right; color: #475569; }
        .progress-track {
          height: 10px;
          overflow: hidden;
          border-radius: 999px;
          background: #e2e8f0;
        }
        #progressFill {
          height: 100%;
          width: 0%;
          border-radius: inherit;
          background: linear-gradient(90deg, var(--primary), var(--primary-2));
          transition: width 0.25s ease;
        }

        .panel-card, .log-panel { padding: 14px; }
        .section-title {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 12px;
        }
        .section-title.tight { margin-bottom: 9px; }
        .section-title span,
        label > span {
          display: block;
          margin-bottom: 6px;
          color: var(--muted);
          font: 950 11px/1.1 var(--font);
          letter-spacing: 0.065em;
          text-transform: uppercase;
        }
        .section-title small {
          display: block;
          margin-top: 3px;
          color: var(--muted);
          font: 700 12px/1.35 var(--font);
        }
        .count-chip {
          padding: 7px 10px;
          color: #174ea6;
          background: #dbeafe;
        }
        .compact-grid,
        .advanced-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px;
        }
        input,
        select,
        textarea {
          width: 100%;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: rgba(255, 255, 255, 0.96);
          color: var(--text);
          padding: 10px 11px;
          outline: none;
          font: 650 13px/1.35 var(--font);
          transition: border-color 0.14s ease, box-shadow 0.14s ease, background 0.14s ease;
        }
        input:focus,
        select:focus,
        textarea:focus {
          border-color: var(--primary);
          box-shadow: 0 0 0 4px rgba(26, 115, 232, 0.12);
          background: #fff;
        }
        .hidden { display: none !important; }
        .prompt-panel { min-height: 216px; }
        #promptText {
          min-height: 168px;
          max-height: 42vh;
          resize: vertical;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 12px;
          line-height: 1.5;
        }
        .options-panel { display: flex; flex-direction: column; gap: 12px; }
        .check-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          padding: 10px;
          border: 1px solid rgba(226, 232, 240, 0.9);
          border-radius: 16px;
          color: var(--text);
          background: rgba(248, 250, 252, 0.72);
          font: 750 13px/1.35 var(--font);
        }
        .check-row input[type="checkbox"], .inline-check input { width: auto; }
        .check-row input[type="number"] { width: 76px; padding: 7px 8px; }
        .advanced {
          border: 1px solid rgba(226, 232, 240, 0.9);
          border-radius: 16px;
          padding: 11px;
          background: rgba(248, 250, 252, 0.58);
        }
        summary {
          cursor: pointer;
          color: var(--text);
          font: 900 13px/1.25 var(--font);
        }
        details[open] summary { margin-bottom: 11px; }
        .inline-check {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 10px;
          color: var(--text);
          font: 750 12px/1.4 var(--font);
        }
        .hint { color: var(--muted); font: 650 11px/1.45 var(--font); margin: 8px 0 0; }

        .logs {
          display: flex;
          flex-direction: column;
          gap: 7px;
          max-height: 170px;
          overflow: auto;
          font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        .log-entry {
          padding: 8px 9px;
          border-radius: 12px;
          color: #475569;
          background: #f8fafc;
          border: 1px solid #edf2f7;
          overflow-wrap: anywhere;
        }
        .log-entry.error { color: #991b1b; background: #fef2f2; border-color: #fee2e2; }
        .log-entry.warn { color: #92400e; background: #fffbeb; border-color: #fde68a; }
        .log-entry.info { color: #1e3a8a; background: #eff6ff; border-color: #dbeafe; }
        .log-entry.debug, .log-entry.verbose, .log-entry.trace { color: #334155; background: #f1f5f9; }

        .actionbar {
          display: grid;
          grid-template-columns: 1fr 1fr 1.35fr;
          gap: 10px;
          padding: 12px 14px 14px;
          border-top: 1px solid rgba(226, 232, 240, 0.82);
          background: rgba(255, 255, 255, 0.74);
          backdrop-filter: blur(16px);
        }
        button {
          border: none;
          border-radius: 16px;
          padding: 12px 14px;
          font: 900 13px/1 var(--font);
          cursor: pointer;
          transition: transform 0.14s ease, box-shadow 0.14s ease, background 0.14s ease, border-color 0.14s ease;
        }
        button:hover:not(:disabled) { transform: translateY(-1px); }
        button:disabled { cursor: not-allowed; opacity: 0.52; transform: none; }
        .primary {
          color: #fff;
          background: linear-gradient(135deg, var(--primary), var(--primary-2));
          box-shadow: 0 14px 28px rgba(26, 115, 232, 0.23);
        }
        .primary:hover:not(:disabled) { box-shadow: 0 18px 32px rgba(26, 115, 232, 0.28); }
        .secondary { color: var(--text); background: white; border: 1px solid var(--line); }
        .danger { color: white; background: var(--danger); }
        .log-actions { display: flex; gap: 6px; }
        .ghost-button {
          padding: 7px 9px;
          border: 1px solid var(--line);
          color: var(--muted);
          background: white;
          font-size: 11px;
        }

        :host([data-density="compact"]) .dashboard { grid-template-columns: 1fr; }
        :host([data-density="compact"]) .timer-card { grid-template-columns: minmax(0, 1fr) 86px; }
        :host([data-density="compact"]) .timer-dial { width: 84px; height: 84px; }
        :host([data-density="compact"]) #timerValue { font-size: 18px; }
        :host([data-density="compact"]) .compact-grid,
        :host([data-density="compact"]) .advanced-grid { grid-template-columns: 1fr; }
        :host([data-density="compact"]) .progress-meta { grid-template-columns: 1fr; }
        :host([data-density="compact"]) #activePrompt { text-align: left; }
        :host([data-density="compact"]) .topbar { grid-template-columns: 42px minmax(0, 1fr) auto auto; }
        :host([data-density="compact"]) .topbar .pill { grid-column: 2 / 5; justify-self: start; margin-top: -4px; }
        :host([data-density="compact"]) .brand-mark { width: 42px; height: 42px; }
        :host([data-density="compact"]) h1 { font-size: 18px; }
        :host([data-density="compact"]) #bigCounter { font-size: 38px; }

        :host([data-density="wide"]) .dashboard { grid-template-columns: 0.9fr 1.1fr; }
        :host([data-density="wide"]) #promptText { min-height: 220px; }

        @media (max-width: 520px) {
          .shell { border-radius: 24px; }
          .dashboard, .compact-grid, .advanced-grid, .progress-meta { grid-template-columns: 1fr; }
          .timer-card { grid-template-columns: minmax(0, 1fr) 86px; }
          .timer-dial { width: 84px; height: 84px; }
          #timerValue { font-size: 18px; }
          .actionbar { grid-template-columns: 1fr; }
        }
      `;
    }

    collectElements() {
      const $ = id => this.shadow.getElementById(id);
      Object.assign(this.elements, {
        resizeHandle: $('resizeHandle'),
        collapsedTab: $('collapsedTab'),
        collapseButton: $('collapseButton'),
        closeButton: $('closeButton'),
        siteSummary: $('siteSummary'),
        statusPill: $('statusPill'),
        bigCounter: $('bigCounter'),
        phaseBadge: $('phaseBadge'),
        timerCard: $('timerCard'),
        timerDial: $('timerDial'),
        timerLabel: $('timerLabel'),
        timerDescription: $('timerDescription'),
        timerValue: $('timerValue'),
        promptMode: $('promptMode'),
        promptSeparator: $('promptSeparator'),
        separatorWrap: $('separatorWrap'),
        cooldownMs: $('cooldownMs'),
        logLevel: $('logLevel'),
        promptText: $('promptText'),
        promptCount: $('promptCount'),
        newChatWrap: $('newChatWrap'),
        newChatEnabled: $('newChatEnabled'),
        newChatEvery: $('newChatEvery'),
        downloadWrap: $('downloadWrap'),
        downloadEnabled: $('downloadEnabled'),
        generationTimeoutMs: $('generationTimeoutMs'),
        idleSettleMs: $('idleSettleMs'),
        submitTimeoutMs: $('submitTimeoutMs'),
        maxSubmitRetries: $('maxSubmitRetries'),
        retryEnabled: $('retryEnabled'),
        maxPromptRetries: $('maxPromptRetries'),
        retryInitialBackoffMs: $('retryInitialBackoffMs'),
        retryMaxBackoffMs: $('retryMaxBackoffMs'),
        startRetryInNewChat: $('startRetryInNewChat'),
        reloadTimedOutChat: $('reloadTimedOutChat'),
        maxReloadCyclesPerAttempt: $('maxReloadCyclesPerAttempt'),
        postReloadObservationMs: $('postReloadObservationMs'),
        adaptiveDomSearch: $('adaptiveDomSearch'),
        runMessage: $('runMessage'),
        activePrompt: $('activePrompt'),
        progressText: $('progressText'),
        progressFill: $('progressFill'),
        optionsButton: $('optionsButton'),
        stopButton: $('stopButton'),
        startButton: $('startButton'),
        exportLogs: $('exportLogs'),
        clearLogs: $('clearLogs'),
        logs: $('logs')
      });
    }

    listen(target, event, handler, options) {
      target.addEventListener(event, handler, options);
      this.disposers.push(() => target.removeEventListener(event, handler, options));
    }

    bindEvents() {
      const e = this.elements;
      this.listen(e.collapsedTab, 'click', () => this.expand());
      this.listen(e.collapseButton, 'click', () => this.collapse());
      this.listen(e.closeButton, 'click', () => this.close());
      this.listen(e.promptText, 'input', () => this.updatePromptCount());
      this.listen(e.promptMode, 'change', () => {
        this.updateSeparatorVisibility();
        this.updatePromptCount();
        this.handleSettingsFormChange(0);
      });
      this.listen(e.promptSeparator, 'input', () => {
        this.updatePromptCount();
        this.handleSettingsFormChange(150);
      });

      const immediateChangeIds = [
        'logLevel', 'newChatEnabled', 'downloadEnabled', 'retryEnabled',
        'startRetryInNewChat', 'reloadTimedOutChat', 'adaptiveDomSearch'
      ];
      for (const id of immediateChangeIds) {
        this.listen(e[id], 'change', () => this.handleSettingsFormChange(0));
      }

      const liveInputIds = [
        'cooldownMs', 'newChatEvery', 'generationTimeoutMs', 'idleSettleMs',
        'submitTimeoutMs', 'maxSubmitRetries', 'maxPromptRetries',
        'retryInitialBackoffMs', 'retryMaxBackoffMs', 'maxReloadCyclesPerAttempt',
        'postReloadObservationMs'
      ];
      for (const id of liveInputIds) {
        this.listen(e[id], 'input', () => this.handleSettingsFormChange(150));
        this.listen(e[id], 'change', () => this.handleSettingsFormChange(0));
      }

      this.listen(e.startButton, 'click', () => this.handleStart());
      this.listen(e.stopButton, 'click', () => this.handleStop());
      this.listen(e.optionsButton, 'click', () => this.openOptions());
      this.listen(e.exportLogs, 'click', () => this.exportDebugLogs().catch(err => this.appendLog({ level: 'error', message: `Could not export logs: ${err.message}` })));
      this.listen(e.clearLogs, 'click', () => {
        this.logs = [];
        this.renderLogs();
        if (this.activeRunId) {
          this.repository.clearRunLogs(this.activeRunId).catch(err => this.appendLog({ level: 'warn', message: `Could not clear persisted logs: ${err.message}` }));
        }
      });
      this.listen(e.resizeHandle, 'pointerdown', event => this.beginResize(event));
      this.listen(e.resizeHandle, 'dblclick', () => this.setPanelWidth(448, { persist: true }));
      this.listen(e.resizeHandle, 'keydown', event => this.handleResizeKey(event));
      e.resizeHandle.tabIndex = 0;
      this.listen(global, 'resize', () => this.setPanelWidth(this.getPanelWidth(), { persist: false }));
    }


    async refresh() {
      const response = await this.getState();
      this.activeSettings = response.settings || await this.repository.getSettings();
      this.activeSite = response.site || null;
      this.activeCapabilities = response.capabilities || {};
      this.activeRunId = response.logRunId || response.checkpoint?.runId || response.state?.runId || this.activeRunId;
      if (Array.isArray(response.logs)) this.logs = response.logs.slice().reverse();
      this.setFormFromSettings(this.activeSettings);
      this.setSiteUi(this.activeSite, this.activeCapabilities);
      this.updateRunState(response.state || this.latestState || {});
      this.updatePromptCount();
      this.renderLogs();
    }

    setFormFromSettings(settings, options) {
      const e = this.elements;
      const preserveFocused = options?.preserveFocused === true;
      const focused = this.shadow?.activeElement || null;
      const setValue = (element, value) => {
        if (!element || (preserveFocused && focused === element)) return;
        element.value = value;
      };
      const setChecked = (element, value) => {
        if (!element || (preserveFocused && focused === element)) return;
        element.checked = Boolean(value);
      };

      this.isApplyingSettings = true;
      try {
        this.activeSettings = utils.deepMerge(root.DEFAULT_SETTINGS || {}, settings || {});
        this.applyPanelSettings(this.activeSettings.panel || {});
        setValue(e.promptMode, this.activeSettings.promptParsingMode || 'lines');
        setValue(e.promptSeparator, this.activeSettings.promptSeparator || '---');
        setValue(e.cooldownMs, this.activeSettings.cooldownMs ?? 15000);
        setValue(e.logLevel, this.activeSettings.logLevel === 'trace' ? 'verbose' : (this.activeSettings.logLevel || 'info'));
        setChecked(e.newChatEnabled, this.activeSettings.newChat?.enabled);
        setValue(e.newChatEvery, this.activeSettings.newChat?.every || 50);
        setChecked(e.downloadEnabled, this.activeSettings.download?.enabled);
        setValue(e.generationTimeoutMs, this.activeSettings.generationTimeoutMs ?? 300000);
        setValue(e.idleSettleMs, this.activeSettings.idleSettleMs ?? 750);
        setValue(e.submitTimeoutMs, this.activeSettings.submitTimeoutMs ?? 25000);
        setValue(e.maxSubmitRetries, this.activeSettings.maxSubmitRetries ?? 3);
        setChecked(e.retryEnabled, this.activeSettings.retry?.enabled === true);
        setValue(e.maxPromptRetries, this.activeSettings.retry?.maxPromptRetries ?? 0);
        setValue(e.retryInitialBackoffMs, this.activeSettings.retry?.initialBackoffMs ?? 5000);
        setValue(e.retryMaxBackoffMs, this.activeSettings.retry?.maxBackoffMs ?? 60000);
        setChecked(e.startRetryInNewChat, this.activeSettings.retry?.startRetryInNewChat !== false);
        setChecked(e.reloadTimedOutChat, this.activeSettings.recovery?.reloadTimedOutChat !== false);
        setValue(e.maxReloadCyclesPerAttempt, this.activeSettings.recovery?.maxReloadCyclesPerAttempt ?? 2);
        setValue(e.postReloadObservationMs, this.activeSettings.recovery?.postReloadObservationMs ?? 45000);
        setChecked(e.adaptiveDomSearch, this.activeSettings.adaptiveDomSearch !== false);
        this.updateSeparatorVisibility();
      } finally {
        this.isApplyingSettings = false;
      }
    }

    applyExternalSettings(settings) {
      if (!this.host) return;
      this.setFormFromSettings(settings, { preserveFocused: true });
      this.updateTimer(this.latestState || {});
    }


    settingsFromForm() {
      const e = this.elements;
      return {
        logLevel: e.logLevel.value,
        cooldownMs: Math.max(0, Number(e.cooldownMs.value || 0)),
        promptParsingMode: e.promptMode.value,
        promptSeparator: e.promptSeparator.value || '---',
        generationTimeoutMs: Math.max(1000, Number(e.generationTimeoutMs.value || 300000)),
        idleSettleMs: Math.max(0, Number(e.idleSettleMs.value || 0)),
        submitTimeoutMs: Math.max(1000, Number(e.submitTimeoutMs.value || 25000)),
        maxSubmitRetries: Math.max(1, Number(e.maxSubmitRetries.value || 3)),
        adaptiveDomSearch: Boolean(e.adaptiveDomSearch.checked),
        retry: {
          ...(this.activeSettings?.retry || {}),
          enabled: Boolean(e.retryEnabled.checked),
          maxPromptRetries: Math.max(0, Number(e.maxPromptRetries.value || 0)),
          initialBackoffMs: Math.max(0, Number(e.retryInitialBackoffMs.value || 0)),
          maxBackoffMs: Math.max(0, Number(e.retryMaxBackoffMs.value || 0)),
          startRetryInNewChat: Boolean(e.startRetryInNewChat.checked)
        },
        recovery: {
          ...(this.activeSettings?.recovery || {}),
          enabled: true,
          reloadTimedOutChat: Boolean(e.reloadTimedOutChat.checked),
          maxReloadCyclesPerAttempt: Math.max(1, Number(e.maxReloadCyclesPerAttempt.value || 0)),
          postReloadObservationMs: Math.max(5000, Number(e.postReloadObservationMs.value || 45000))
        },
        panel: {
          ...(this.activeSettings?.panel || {}),
          dockSide: 'right',
          width: this.getPanelWidth()
        },
        newChat: {
          enabled: Boolean(e.newChatEnabled.checked),
          every: Math.max(1, Number(e.newChatEvery.value || 1))
        },
        download: {
          ...(this.activeSettings?.download || {}),
          enabled: Boolean(e.downloadEnabled.checked),
          clickNativeButton: true,
          captureNativeDownload: true
        }
      };
    }

    parsePromptText() {
      return root.PromptParser.parsePrompts(this.elements.promptText.value, {
        mode: this.elements.promptMode.value,
        separator: this.elements.promptSeparator.value || '---'
      });
    }

    updatePromptCount() {
      const count = this.parsePromptText().length;
      this.elements.promptCount.textContent = `${count} prompt${count === 1 ? '' : 's'}`;
    }

    updateSeparatorVisibility() {
      this.elements.separatorWrap.classList.toggle('hidden', this.elements.promptMode.value !== 'separator');
    }

    updateCapabilityUi(capabilities) {
      const hasNewChat = Boolean(capabilities?.hasNewChat);
      const hasDownload = Boolean(capabilities?.hasDownload || capabilities?.hasImageSelector);
      this.elements.newChatWrap.classList.toggle('hidden', !hasNewChat);
      this.elements.downloadWrap.classList.toggle('hidden', !hasDownload);
      if (!hasNewChat) this.elements.newChatEnabled.checked = false;
      if (!hasDownload) this.elements.downloadEnabled.checked = false;
    }

    setSiteUi(site, capabilities) {
      const supported = Boolean(capabilities?.supported);
      const siteName = site?.siteName || site?.name || capabilities?.siteName || 'Unsupported site';
      this.elements.siteSummary.textContent = supported ? `${siteName} detected` : 'Open a configured site to start automation';
      this.elements.startButton.disabled = !supported;
      this.updateCapabilityUi(capabilities);
    }

    updateRunState(state) {
      if (!this.elements.statusPill) return;
      this.latestState = state || {};
      if (state?.runId) this.activeRunId = state.runId;
      const status = state?.status || statuses.IDLE || 'idle';
      const total = Number(state?.total || 0);
      const current = Number(state?.current || 0);
      const safeCurrent = total > 0 ? Math.min(total, Math.max(0, current)) : 0;
      const processed = Math.min(total, Math.max(0, Number(state?.processedCount ?? state?.completedCount ?? 0)));
      const successful = Math.max(0, Number(state?.successfulCount || 0));
      const failed = Math.max(0, Number(state?.failedCount || 0));
      const percent = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
      const phase = state?.phase || status;
      const phaseLabel = phase ? String(phase).replace(/-/g, ' ') : 'Ready';

      this.elements.statusPill.textContent = status;
      this.elements.statusPill.className = `pill ${status}`;
      this.elements.bigCounter.textContent = `#${safeCurrent} / #${total}`;
      this.elements.phaseBadge.textContent = phaseLabel;
      this.elements.runMessage.textContent = state?.message || 'Ready';
      this.elements.progressText.textContent = `${processed}/${total} · ${successful} ok · ${failed} failed`;
      this.elements.progressFill.style.width = `${percent}%`;
      const attemptLabel = Number(state?.promptAttempt || 0) > 0 ? ` · attempt ${state.promptAttempt}` : '';
      this.elements.activePrompt.textContent = state?.currentPrompt
        ? `${utils.truncate(state.currentPrompt, 76)}${attemptLabel}`
        : 'No prompt running';
      this.updateTimer(state);

      const busy = [
        statuses.PREPARING, statuses.RUNNING, statuses.COOLDOWN, statuses.RECOVERING,
        statuses.RETRYING, statuses.STOPPING, 'preparing', 'running', 'cooldown',
        'recovering', 'retrying', 'stopping'
      ].includes(status);
      this.elements.startButton.disabled = busy || !this.activeCapabilities?.supported;
      this.elements.stopButton.disabled = !busy;
    }

    updateTimer(state) {
      const status = state?.status || 'idle';
      const remaining = Math.max(0, Number(state?.cooldownRemainingMs || 0));
      const configuredTotal = Number(state?.cooldownTotalMs || this.activeSettings?.cooldownMs || 0);
      const total = Math.max(remaining, configuredTotal, 0);
      const isCooldown = status === statuses.COOLDOWN || status === 'cooldown';
      const card = this.elements.timerCard;

      card.className = `timer-card ${status}`;

      if (isCooldown && remaining > 0) {
        const progress = total > 0 ? Math.min(100, Math.max(0, ((total - remaining) / total) * 100)) : 0;
        const nextNumber = Math.min(Number(state?.total || 0), Number(state?.current || 0) + 1);
        this.elements.timerLabel.textContent = 'Next prompt countdown';
        this.elements.timerDescription.textContent = state?.timerDescription || `Next image #${nextNumber || '?'} starts when the cooldown reaches zero.`;
        this.elements.timerValue.textContent = this.formatDuration(remaining);
        this.elements.timerDial.style.setProperty('--timer-progress', `${progress}%`);
        return;
      }

      if (status === statuses.COMPLETED || status === 'completed') {
        this.elements.timerLabel.textContent = 'Run complete';
        this.elements.timerDescription.textContent = 'All prompts have been processed.';
        this.elements.timerValue.textContent = 'Done';
        this.elements.timerDial.style.setProperty('--timer-progress', '100%');
        return;
      }

      if (status === statuses.ERROR || status === 'error') {
        this.elements.timerLabel.textContent = 'Needs attention';
        this.elements.timerDescription.textContent = state?.message || 'The run stopped because of an error.';
        this.elements.timerValue.textContent = 'Error';
        this.elements.timerDial.style.setProperty('--timer-progress', '100%');
        return;
      }

      if ([
        statuses.PREPARING, statuses.RUNNING, statuses.RECOVERING, statuses.RETRYING,
        statuses.STOPPING, 'preparing', 'running', 'recovering', 'retrying', 'stopping'
      ].includes(status)) {
        this.elements.timerLabel.textContent = 'Working';
        this.elements.timerDescription.textContent = state?.message || 'Prompt Pilot is currently processing the queue.';
        this.elements.timerValue.textContent = '—';
        this.elements.timerDial.style.setProperty('--timer-progress', '0%');
        return;
      }

      this.elements.timerLabel.textContent = 'Cooldown timer';
      this.elements.timerDescription.textContent = 'Start a run to see the next-prompt countdown.';
      this.elements.timerValue.textContent = this.formatDuration(0);
      this.elements.timerDial.style.setProperty('--timer-progress', '0%');
    }

    formatDuration(milliseconds) {
      const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const pad = value => String(value).padStart(2, '0');
      if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
      return `${pad(minutes)}:${pad(seconds)}`;
    }

    getPanelWidth() {
      const rectWidth = this.host?.getBoundingClientRect?.().width;
      return Math.round(rectWidth || parseFloat(this.host?.style?.width) || 448);
    }

    clampPanelWidth(width) {
      const viewportMax = Math.max(320, global.innerWidth - 24);
      const max = Math.min(760, viewportMax);
      const min = Math.min(max, 360);
      return Math.round(Math.min(max, Math.max(min, Number(width) || 448)));
    }

    setPanelWidth(width, options) {
      if (!this.host) return;
      const nextWidth = this.clampPanelWidth(width);
      this.host.style.width = `${nextWidth}px`;
      this.host.style.maxWidth = 'calc(100vw - 24px)';
      this.syncPanelDensity();
      if (options?.persist) this.persistPanelWidth(nextWidth);
    }

    applyPanelSettings(panelSettings) {
      const width = Number(panelSettings?.width || 448);
      this.setPanelWidth(width, { persist: false });
    }

    syncPanelDensity() {
      if (!this.host) return;
      const width = this.getPanelWidth();
      const density = width < 430 ? 'compact' : width > 560 ? 'wide' : 'regular';
      this.host.dataset.density = density;
    }

    persistPanelWidth(width) {
      if (this.resizeSaveTimer) clearTimeout(this.resizeSaveTimer);
      const panelPatch = { panel: { ...(this.activeSettings?.panel || {}), dockSide: 'right', width } };
      this.activeSettings = utils.deepMerge(this.activeSettings || root.DEFAULT_SETTINGS || {}, panelPatch);
      this.onSettingsChanged(panelPatch);
      this.resizeSaveTimer = setTimeout(() => {
        this.repository.saveSettings(panelPatch)
          .then(settings => { this.activeSettings = settings; })
          .catch(err => this.appendLog({ level: 'warn', message: `Could not save panel width: ${err.message}` }));
      }, 250);
    }

    beginResize(event) {
      if (!this.host || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = this.getPanelWidth();
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      const onMove = moveEvent => {
        moveEvent.preventDefault();
        const delta = startX - moveEvent.clientX;
        this.setPanelWidth(startWidth + delta, { persist: false });
      };
      const onEnd = () => {
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onEnd, true);
        document.removeEventListener('pointercancel', onEnd, true);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        this.persistPanelWidth(this.getPanelWidth());
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onEnd, true);
      document.addEventListener('pointercancel', onEnd, true);
    }

    handleResizeKey(event) {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') this.setPanelWidth(360, { persist: true });
      else if (event.key === 'End') this.setPanelWidth(640, { persist: true });
      else {
        const delta = event.shiftKey ? 48 : 24;
        const direction = event.key === 'ArrowLeft' ? 1 : -1;
        this.setPanelWidth(this.getPanelWidth() + direction * delta, { persist: true });
      }
    }

    appendLog(entry) {
      const safeEntry = {
        time: entry?.time || new Date().toISOString(),
        elapsedMs: entry?.elapsedMs ?? null,
        sequence: entry?.sequence ?? null,
        scope: entry?.scope || 'PromptPilot',
        level: entry?.level || 'info',
        event: entry?.event || entry?.meta?.event || null,
        message: entry?.message || '',
        context: entry?.context || null,
        meta: entry?.meta || null,
        url: entry?.url || global.location?.href || ''
      };
      this.logs.unshift(safeEntry);
      this.logs = this.logs.slice(0, 500);
      this.renderLogs();
    }

    renderLogs() {
      if (!this.elements.logs) return;
      this.elements.logs.textContent = '';
      for (const entry of this.logs.slice(0, 200)) {
        const div = document.createElement('div');
        div.className = `log-entry ${entry.level || 'info'}`;
        const time = entry.time ? new Date(entry.time).toLocaleTimeString() : new Date().toLocaleTimeString();
        const sequence = entry.sequence != null ? ` #${entry.sequence}` : '';
        const eventName = entry.event ? ` [${entry.event}]` : '';
        div.textContent = `${time}${sequence} ${String(entry.level || 'info').toUpperCase()}${eventName} ${entry.message || ''}`;
        if (entry.meta || entry.context) div.title = JSON.stringify({ context: entry.context, meta: entry.meta }, null, 2);
        this.elements.logs.appendChild(div);
      }
    }

    async exportDebugLogs() {
      const response = await this.getState().catch(() => null);
      const checkpoint = response?.checkpoint || null;
      const settings = response?.settings || await this.repository.getSettings().catch(() => this.activeSettings || null);
      const runId = response?.logRunId || checkpoint?.runId || this.activeRunId || this.latestState?.runId || null;
      const logs = Array.isArray(response?.logs)
        ? response.logs
        : runId
          ? await this.repository.getRunLogs(runId).catch(() => this.logs.slice().reverse())
          : this.logs.slice().reverse();
      const payload = {
        exportedAt: new Date().toISOString(),
        extensionVersion: root.VERSION,
        runId,
        pageUrl: global.location?.href || '',
        userAgent: global.navigator?.userAgent || '',
        currentState: response?.state || this.latestState,
        checkpoint,
        settings,
        logs
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
      const dataUrl = utils.bytesToDataUrl(bytes, 'application/json');
      await utils.chromeRuntimeRequest({
        type: messageTypes.DOWNLOAD_DATA_URL,
        dataUrl,
        filename: `PromptPilot/prompt-pilot-debug-${utils.nowTimestamp()}.json`,
        saveAs: true
      }, 30000);
      this.appendLog({ level: 'info', message: `Exported ${logs.length} persisted log entries with the durable run checkpoint.` });
    }

    handleSettingsFormChange(persistDelay) {
      if (this.isApplyingSettings || !this.host) return;
      const patch = this.settingsFromForm();
      this.activeSettings = utils.deepMerge(this.activeSettings || root.DEFAULT_SETTINGS || {}, patch);
      this.onSettingsChanged(patch);
      this.scheduleSettingsSave(persistDelay == null ? 150 : persistDelay);
      this.updateTimer(this.latestState || {});
    }

    scheduleSettingsSave(delay) {
      if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
      const sequence = ++this.settingsChangeSequence;
      this.settingsSaveTimer = setTimeout(() => {
        this.settingsSaveTimer = null;
        this.persistSettingsFromForm(sequence).catch(err => this.appendLog({ level: 'warn', message: `Could not save settings: ${err.message}` }));
      }, Math.max(0, Number(delay || 0)));
    }

    async persistSettingsFromForm(sequence) {
      const patch = this.settingsFromForm();
      const saved = await this.repository.saveSettings(patch);
      if (sequence === this.settingsChangeSequence) {
        this.activeSettings = saved;
        this.applyPanelSettings(saved.panel || {});
      }
      return saved;
    }

    async saveSettingsFromForm() {
      if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
      this.settingsSaveTimer = null;
      const sequence = ++this.settingsChangeSequence;
      const patch = this.settingsFromForm();
      this.activeSettings = utils.deepMerge(this.activeSettings || root.DEFAULT_SETTINGS || {}, patch);
      this.onSettingsChanged(patch);
      const saved = await this.repository.saveSettings(patch);
      if (sequence === this.settingsChangeSequence) {
        this.activeSettings = saved;
        this.applyPanelSettings(saved.panel || {});
      }
      return this.activeSettings;
    }


    async handleStart() {
      const prompts = this.parsePromptText();
      this.updatePromptCount();
      if (!prompts.length) {
        this.appendLog({ level: 'warn', message: 'No prompts found.' });
        return;
      }

      let settings;
      try {
        settings = await this.saveSettingsFromForm();
      } catch (err) {
        const formSettings = this.settingsFromForm();
        settings = utils.deepMerge(this.activeSettings || root.DEFAULT_SETTINGS || {}, formSettings);
        this.activeSettings = settings;
        this.appendLog({
          level: 'warn',
          message: `Could not persist settings before start: ${err.message}. Continuing this run with the visible panel values.`
        });
      }

      this.updateRunState({ status: 'preparing', message: `Starting ${prompts.length} prompts…`, current: 0, total: prompts.length, phase: 'preparing' });
      try {
        const response = await this.startRun({ prompts, settings });
        this.updateRunState(response.state);
        this.appendLog({ level: 'info', message: `Run accepted: ${prompts.length} prompts.` });
      } catch (err) {
        const message = utils.isExtensionContextInvalidatedError?.(err)
          ? `${err.message} Refresh this tab or click the Prompt Pilot toolbar icon again, then press Start run.`
          : err.message;
        this.appendLog({ level: 'error', message });
        this.updateRunState({ status: 'error', message, current: 0, total: prompts.length, phase: 'error' });
      }
    }

    async handleStop() {
      try {
        const response = await this.stopRun();
        this.updateRunState(response.state);
        this.appendLog({ level: 'warn', message: 'Stop requested.' });
      } catch (err) {
        this.appendLog({ level: 'error', message: err.message });
      }
    }

    openOptions() {
      if (!utils.safeChromeSendMessage({ type: messageTypes.OPEN_OPTIONS })) {
        this.appendLog({ level: 'warn', message: 'Could not open settings from this tab. Refresh the page, then open Prompt Pilot again.' });
      }
    }
  }

  root.PagePanel = PagePanel;
})(globalThis);
