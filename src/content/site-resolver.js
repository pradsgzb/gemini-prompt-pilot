(function attachPromptPilotSiteResolver(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;

  function configMatchesUrl(config, href) {
    if (!config) return false;
    const url = new URL(href || location.href);

    if (Array.isArray(config.hostnames) && config.hostnames.includes(url.hostname)) return true;

    for (const pattern of config.urlPatterns || []) {
      try {
        if (new RegExp(pattern, 'i').test(url.href)) return true;
      } catch (_) {}
    }
    return false;
  }

  function resolveSiteConfig(configs, href) {
    return (configs || []).find(config => configMatchesUrl(config, href || location.href)) || null;
  }

  function getCapabilities(config) {
    const selectors = config?.selectors || {};
    return {
      supported: Boolean(config),
      siteId: config?.id || null,
      siteName: config?.name || 'Unsupported site',
      hasNewChat: Array.isArray(selectors.newChat) && selectors.newChat.length > 0,
      hasDownload: Boolean((Array.isArray(selectors.downloadButtons) && selectors.downloadButtons.length > 0) || (config?.adaptiveSelectors && root.GENERIC_SITE_SELECTORS?.downloadButtons?.length)),
      hasImageSelector: Boolean((Array.isArray(selectors.outputImages) && selectors.outputImages.length > 0) || (config?.adaptiveSelectors && root.GENERIC_SITE_SELECTORS?.outputImages?.length)),
      hasPreRunSteps: Array.isArray(config?.preRunSteps) && config.preRunSteps.length > 0
    };
  }

  function summarizeConfig(config) {
    const caps = getCapabilities(config);
    return utils.deepMerge(caps, {
      promptInputMode: config?.promptInputMode || 'auto'
    });
  }

  root.SiteResolver = Object.freeze({
    configMatchesUrl,
    resolveSiteConfig,
    getCapabilities,
    summarizeConfig
  });
})(globalThis);
