(function attachPromptPilotConstants(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});

  root.VERSION = '1.1.0';

  root.STORAGE_KEYS = Object.freeze({
    SETTINGS: 'promptPilot.settings',
    SITE_CONFIGS: 'promptPilot.siteConfigs',
    RUN_STATE: 'promptPilot.runState',
    ACTIVE_RUN_PREFIX: 'promptPilot.activeRun.',
    RUN_LOG_PREFIX: 'promptPilot.runLog.',
    RUN_LOG_INDEX: 'promptPilot.runLogIndex'
  });

  root.MESSAGE_TYPES = Object.freeze({
    GET_STATE: 'PROMPT_PILOT_GET_STATE',
    START_RUN: 'PROMPT_PILOT_START_RUN',
    STOP_RUN: 'PROMPT_PILOT_STOP_RUN',
    STATUS: 'PROMPT_PILOT_RUN_STATUS',
    TOGGLE_PANEL: 'PROMPT_PILOT_TOGGLE_PANEL',
    SHOW_PANEL: 'PROMPT_PILOT_SHOW_PANEL',
    HIDE_PANEL: 'PROMPT_PILOT_HIDE_PANEL',
    OPEN_OPTIONS: 'PROMPT_PILOT_OPEN_OPTIONS',
    DOWNLOAD_DATA_URL: 'PROMPT_PILOT_DOWNLOAD_DATA_URL',
    FETCH_IMAGE_AS_DATA_URL: 'PROMPT_PILOT_FETCH_IMAGE_AS_DATA_URL',
    ARM_NATIVE_DOWNLOAD_CAPTURE: 'PROMPT_PILOT_ARM_NATIVE_DOWNLOAD_CAPTURE',
    DISARM_NATIVE_DOWNLOAD_CAPTURE: 'PROMPT_PILOT_DISARM_NATIVE_DOWNLOAD_CAPTURE',
    NATIVE_DOWNLOAD_CAPTURED: 'PROMPT_PILOT_NATIVE_DOWNLOAD_CAPTURED',
    GET_TAB_CONTEXT: 'PROMPT_PILOT_GET_TAB_CONTEXT',
    NAVIGATE_TAB: 'PROMPT_PILOT_NAVIGATE_TAB',
    PING: 'PROMPT_PILOT_PING'
  });

  root.RUN_STATUS = Object.freeze({
    IDLE: 'idle',
    PREPARING: 'preparing',
    RUNNING: 'running',
    RETRYING: 'retrying',
    RECOVERING: 'recovering',
    COOLDOWN: 'cooldown',
    STOPPING: 'stopping',
    STOPPED: 'stopped',
    COMPLETED: 'completed',
    ERROR: 'error'
  });

  root.LOG_LEVELS = Object.freeze({
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
    verbose: 4,
    trace: 4
  });
})(globalThis);
