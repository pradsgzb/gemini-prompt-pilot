(function attachPromptPilotSiteConfigs(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});

  const GENERIC = Object.freeze({
    input: [
      'textarea[placeholder*="prompt" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="message" i]',
      'textarea[aria-label*="message" i]',
      'textarea[placeholder*="ask" i]',
      'textarea[aria-label*="ask" i]',
      '[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"][aria-label*="prompt" i]',
      '[contenteditable="true"][aria-label*="message" i]',
      '[contenteditable="true"][aria-label*="ask" i]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    inputContainers: [
      'form',
      '[data-testid*="composer" i]',
      '[data-test-id*="composer" i]',
      '[class*="composer" i]',
      '[class*="prompt" i]',
      '[class*="input" i]',
      '[class*="chat" i]',
      '[role="main"]',
      'main'
    ],
    submit: [
      'button[type="submit"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Generate" i]',
      'button[aria-label*="Create" i]',
      'button[data-testid*="send" i]',
      'button[data-test-id*="send" i]',
      'button[class*="send" i]',
      'button[class*="submit" i]',
      'button[class*="generate" i]',
      '[role="button"][aria-label*="Send" i]',
      '[role="button"][aria-label*="Submit" i]',
      '[role="button"][aria-label*="Generate" i]'
    ],
    submitTextPatterns: [
      '\\bsend\\b',
      '\\bsubmit\\b',
      '\\bgenerate\\b',
      '\\bcreate\\b',
      'arrow[_ -]?upward',
      'send[_ -]?filled',
      'paper[_ -]?plane'
    ],
    submitExcludeTextPatterns: [
      'feedback', 'share', 'export', 'copy', 'download', 'upload', 'attach', 'settings', 'menu', 'voice', 'mic',
      'stop response', 'stop generating', 'stop streaming', 'stop generation', 'cancel response', 'cancel generation', 'cancel generating', 'pause response', 'pause generation', '\\bstop\\b', '\\bcancel\\b', '\\bpause\\b', '\\babort\\b', '\\binterrupt\\b'
    ],
    unsafeSubmitTextPatterns: [
      'stop response', 'stop generating', 'stop streaming', 'stop generation', 'cancel response', 'cancel generation', 'cancel generating', 'pause response', 'pause generation', '\\bstop\\b', '\\bcancel\\b', '\\bpause\\b', '\\babort\\b', '\\binterrupt\\b'
    ],
    busy: [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Cancel" i]',
      '[role="button"][aria-label*="Stop" i]',
      '[role="button"][aria-label*="Cancel" i]',
      '[data-testid*="stop" i]',
      '[data-test-id*="stop" i]',
      '[aria-busy="true"]',
      '[role="progressbar"]',
      '[class*="loading" i]',
      '[class*="spinner" i]',
      '[class*="generating" i]'
    ],
    busyTextPatterns: [
      'stop generating', 'stop response', 'cancel response', '\\bstop\\b', '\\bcancel\\b', 'generating', 'creating', 'thinking'
    ],
    responseContainers: [
      'model-response',
      'message-content',
      'article[data-testid*="conversation" i]',
      'article[data-test-id*="conversation" i]',
      '[data-testid*="assistant" i]',
      '[data-test-id*="assistant" i]',
      '[data-message-author-role="assistant"]',
      '[role="article"]',
      'main article'
    ],
    errorContainers: [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[data-testid*="error" i]',
      '[data-test-id*="error" i]',
      '[class*="error" i]'
    ],
    errorTextPatterns: [
      'something went wrong',
      'failed to generate',
      'generation failed',
      'could not generate',
      "couldn't generate",
      'unable to generate',
      'could not create',
      "couldn't create",
      'unable to create',
      'try again',
      'internal error',
      'network error',
      'request failed',
      'service unavailable',
      'temporarily unavailable',
      'too many requests',
      'rate limit',
      'quota exceeded',
      'image generation is unavailable',
      'image generation unavailable',
      'image was not generated',
      'no image was generated'
    ],
    conversationLinks: [
      'a[href*="/app/"]',
      'a[href*="/c/"]',
      'a[data-testid*="conversation" i]',
      'a[data-test-id*="conversation" i]'
    ],
    outputImages: [
      'main img[src^="blob:"]',
      'main img[src^="data:image"]',
      'main img[src*="googleusercontent.com"]',
      'main img[src*="blob.core.windows.net"]',
      'main img[src*="openai.com"]',
      'main img[src*="oaidalle"]',
      'article img',
      '[role="article"] img',
      '[data-testid*="conversation" i] img',
      '[data-test-id*="conversation" i] img',
      'picture img',
      'img[src^="blob:"]',
      'img[src^="data:image"]',
      'main img'
    ],
    downloadButtons: [
      'button[aria-label="Download full size image"]',
      'button[aria-label*="Download full" i]',
      'button[aria-label*="Download" i]',
      'button[title*="Download" i]',
      'button[data-testid*="download" i]',
      'button[data-test-id*="download" i]',
      'button[class*="download" i]',
      '[role="button"][aria-label*="Download" i]',
      'a[download]',
      'a[aria-label*="Download" i]',
      'mat-icon[fonticon="download"]',
      'mat-icon[data-mat-icon-name="download"]',
      '[data-icon*="download" i]',
      'svg[aria-label*="Download" i]'
    ],
    downloadTextPatterns: [
      'download full size image', 'download full', '\\bdownload\\b', 'save[_ -]?alt', 'file[_ -]?download'
    ]
  });

  root.GENERIC_SITE_SELECTORS = GENERIC;

  root.DEFAULT_SITE_CONFIGS = Object.freeze([
    {
      id: 'gemini',
      name: 'Google Gemini',
      urlPatterns: ['^https://gemini\\.google\\.com/'],
      hostnames: ['gemini.google.com'],
      promptInputMode: 'contenteditable',
      adaptiveSelectors: true,
      selectors: {
        input: [
          '[role="textbox"][contenteditable="true"][aria-label*="prompt" i]',
          '[role="textbox"][contenteditable="true"][aria-label*="Gemini" i]',
          '[data-test-id="textarea-inner"] div.ql-editor[contenteditable="true"]',
          'rich-textarea div.ql-editor[contenteditable="true"]',
          'input-area-v2 div.ql-editor[contenteditable="true"]',
          'div.ql-editor[contenteditable="true"]:not(.ql-clipboard)',
          '[contenteditable="true"][role="textbox"]',
          ...GENERIC.input
        ],
        inputContainers: [
          'form',
          'rich-textarea',
          'input-area-v2',
          '[data-test-id="textarea"]',
          '[data-test-id="input-area"]',
          '.input-area-container',
          '.composer-container',
          ...GENERIC.inputContainers
        ],
        submit: [
          '[data-test-id="send-button-container"] gem-icon-button.send-button:not(.stop) button',
          '[data-test-id="send-button-container"] .send-button:not(.stop) button',
          'gem-icon-button.send-button:not(.stop) button',
          '.send-button.submit button',
          '.send-button:not(.stop) button[aria-label*="Send" i]',
          'button[aria-label="Send message"]',
          'button[aria-label*="Send" i]',
          'button.send-button.submit',
          'mat-icon[fonticon="arrow_upward"]',
          'mat-icon[data-mat-icon-name="arrow_upward"]',
          ...GENERIC.submit
        ],
        submitTextPatterns: ['\\bsend\\b', 'arrow[_ -]?upward', ...GENERIC.submitTextPatterns],
        submitExcludeTextPatterns: ['feedback', 'share', 'export', 'copy', 'upload', 'download', 'settings', 'apps', 'stop response', 'stop generating', 'stop streaming', 'stop generation', 'cancel response', 'cancel generation', 'cancel generating', 'pause response', 'pause generation', '\\bstop\\b', '\\bcancel\\b', '\\bpause\\b', '\\babort\\b', '\\binterrupt\\b'],
        stop: [
          '[data-test-id="send-button-container"] gem-icon-button.send-button.stop',
          '[data-test-id="send-button-container"] .send-button.stop',
          '[data-test-id="send-button-container"] button[aria-label*="Stop" i]',
          '[data-test-id="send-button-container"] button[aria-label*="Cancel" i]',
          'gem-icon-button.send-button.stop button',
          'gem-icon-button.send-button.stop',
          '.send-button.stop button',
          '.send-button.stop',
          'button[aria-label="Stop response"]',
          'button[aria-label*="Stop response" i]',
          'button[aria-label*="Stop generating" i]',
          'button[aria-label*="Cancel response" i]'
        ],
        thinking: [
          'thinking-overlay',
          'thinking-overlay [data-test-id="thinking-overlay-content"]',
          '[data-test-id="thinking-overlay-content"]'
        ],
        busy: [
          'thinking-overlay',
          'thinking-overlay [data-test-id="thinking-overlay-content"]',
          '[data-test-id="thinking-overlay-content"]',
          '[data-test-id="send-button-container"] gem-icon-button.send-button.stop',
          '[data-test-id="send-button-container"] .send-button.stop',
          '[data-test-id="send-button-container"] button[aria-label*="Stop" i]',
          '[data-test-id="send-button-container"] button[aria-label*="Cancel" i]',
          'gem-icon-button.send-button.stop button',
          'gem-icon-button.send-button.stop',
          '.send-button.stop button',
          '.send-button.stop',
          'button[aria-label="Stop response"]',
          'button[aria-label*="Stop response" i]',
          'button[aria-label*="Stop generating" i]',
          'button[aria-label*="Cancel response" i]'
        ],
        busyTextPatterns: ['stop generating', 'cancel response', 'stop response'],
        responseContainers: [
          'model-response',
          'message-content',
          '[data-test-id*="response" i]',
          '[data-testid*="response" i]',
          ...GENERIC.responseContainers
        ],
        errorContainers: [
          'model-response [role="alert"]',
          'message-content [role="alert"]',
          'model-response [class*="error" i]',
          'message-content [class*="error" i]',
          ...GENERIC.errorContainers
        ],
        errorTextPatterns: [
          'there was an error generating',
          'failed to generate',
          'failed to create (an |the |this )?image',
          'could not create that image',
          "couldn't create that image",
          'could not generate (an |the |this )?image',
          "couldn't generate (an |the |this )?image",
          'was not able to generate (an |the |this )?image',
          'unable to create (an |the |this )?image',
          'cannot create (an |the |this )?image',
          "can't create (an |the |this )?image",
          'image generation is (currently )?unavailable',
          ...GENERIC.errorTextPatterns
        ],
        newChat: [
          '[data-test-id="new-chat-button"] a',
          'a[aria-label="New chat"]',
          'a[href="/app"][aria-label*="New chat" i]',
          'a[href="/app"]'
        ],
        conversationLinks: [
          'a[href^="/app/"]',
          'a[href*="gemini.google.com/app/"]',
          '[data-test-id*="conversation" i] a[href]',
          '[data-testid*="conversation" i] a[href]',
          ...GENERIC.conversationLinks
        ],
        outputImages: [
          'main img[src^="blob:"]',
          'main img[src^="data:image"]',
          'main img[src*="googleusercontent.com"]',
          'model-response img',
          'message-content img',
          '[data-test-id*="response" i] img',
          ...GENERIC.outputImages
        ],
        downloadButtons: [
          'button[aria-label="Download full size image"]',
          'button[aria-label*="Download full size image" i]',
          'button[aria-label*="Download full" i]',
          'button[aria-label*="Download" i]',
          'button[data-test-id*="download" i]',
          '[role="button"][aria-label*="Download" i]',
          'mat-icon[fonticon="download"]',
          'mat-icon[data-mat-icon-name="download"]',
          ...GENERIC.downloadButtons
        ],
        downloadTextPatterns: [...GENERIC.downloadTextPatterns]
      },
      preRunSteps: [
        {
          id: 'createImageMode',
          label: 'Create image mode',
          kind: 'toggle',
          optionPath: 'enableCreateImageMode',
          defaultEnabled: true,
          openerSelectors: [
            'button[aria-label="Upload & tools"]',
            'button[aria-label="Upload &amp; tools"]',
            'button[aria-label*="Upload" i][aria-haspopup="menu"]',
            'button[jslog*="300142"]',
            'button[aria-label*="tools" i]',
            'button[aria-label*="attach" i]'
          ],
          targetSelectors: [
            'button[role="menuitemcheckbox"][aria-label*="Create image" i]',
            'toolbox-drawer-item button[role="menuitemcheckbox"]',
            'button[role="menuitemcheckbox"]',
            'button[jslog*="271906"]',
            '[role="menuitemcheckbox"]',
            '[role="menuitem"]'
          ],
          targetTextPatterns: ['create image', 'image create', 'generate image'],
          checkedAttribute: 'aria-checked',
          desiredValue: 'true',
          waitAfterMs: 700
        },
        {
          id: 'ensureProMode',
          label: 'Pro mode',
          kind: 'menu-select',
          optionPath: 'ensureProMode',
          defaultEnabled: false,
          openerSelectors: [
            'button[data-test-id="bard-mode-menu-button"]',
            'button[aria-label="Open mode picker"]',
            'bard-mode-switcher button[aria-haspopup="true"]',
            'button[aria-haspopup="menu"][aria-label*="mode" i]'
          ],
          targetSelectors: ['[role="menuitem"]', '[role="option"]', 'button', 'mat-option', 'div[role="button"]'],
          targetTextPatterns: ['\\bpro\\b'],
          waitAfterMs: 800
        }
      ]
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      urlPatterns: ['^https://chatgpt\\.com/', '^https://chat\\.openai\\.com/'],
      hostnames: ['chatgpt.com', 'chat.openai.com'],
      promptInputMode: 'auto',
      adaptiveSelectors: true,
      selectors: {
        input: ['#prompt-textarea', '[data-testid="prompt-textarea"]', 'textarea[placeholder*="Ask" i]', 'textarea[aria-label*="message" i]', '[contenteditable="true"][data-testid="prompt-textarea"]', 'div[contenteditable="true"][role="textbox"]', ...GENERIC.input],
        inputContainers: ['form', '[data-testid="composer"]', '[data-testid="composer-footer"]', '.composer-parent', 'main', ...GENERIC.inputContainers],
        submit: ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[type="submit"]', 'svg[aria-label*="Send" i]', ...GENERIC.submit],
        submitTextPatterns: ['\\bsend\\b', 'arrow[_ -]?upward', ...GENERIC.submitTextPatterns],
        submitExcludeTextPatterns: ['feedback', 'download', 'copy', 'share', 'voice', 'mic', 'attach', 'stop response', 'stop generating', 'stop streaming', 'stop generation', 'cancel response', 'cancel generation', 'cancel generating', 'pause response', 'pause generation', '\\bstop\\b', '\\bcancel\\b', '\\bpause\\b', '\\babort\\b', '\\binterrupt\\b'],
        busy: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]', '[data-testid*="stop" i]', ...GENERIC.busy],
        busyTextPatterns: ['stop generating', 'stop response', 'cancel', ...GENERIC.busyTextPatterns],
        responseContainers: ['[data-message-author-role="assistant"]', 'article[data-testid]', ...GENERIC.responseContainers],
        errorContainers: [...GENERIC.errorContainers],
        errorTextPatterns: [...GENERIC.errorTextPatterns],
        newChat: ['a[aria-label*="New chat" i]', 'button[aria-label*="New chat" i]', 'a[href="/"]'],
        conversationLinks: ['a[href^="/c/"]', 'a[href*="chatgpt.com/c/"]', ...GENERIC.conversationLinks],
        outputImages: ['main img[src^="blob:"]', 'main img[src^="data:image"]', 'main img[src*="oaidalleapiprodscus.blob.core.windows.net"]', 'article img', 'main img', ...GENERIC.outputImages],
        downloadButtons: ['button[aria-label*="Download" i]', '[data-testid*="download" i]', '[role="button"][aria-label*="Download" i]', 'a[download]', ...GENERIC.downloadButtons],
        downloadTextPatterns: [...GENERIC.downloadTextPatterns]
      },
      preRunSteps: []
    },
    {
      id: 'seaart',
      name: 'SeaArt',
      urlPatterns: ['^https://(www\\.)?seaart\\.ai/'],
      hostnames: ['seaart.ai', 'www.seaart.ai'],
      promptInputMode: 'auto',
      adaptiveSelectors: true,
      selectors: {
        input: ['textarea[placeholder*="prompt" i]', 'textarea[aria-label*="prompt" i]', 'textarea', '[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', ...GENERIC.input],
        inputContainers: ['form', '[class*="prompt" i]', '[class*="generate" i]', 'main', ...GENERIC.inputContainers],
        submit: ['button[type="submit"]', 'button[aria-label*="Generate" i]', 'button[aria-label*="Create" i]', ...GENERIC.submit],
        submitTextPatterns: ['generate', 'create', 'submit', 'start', ...GENERIC.submitTextPatterns],
        submitExcludeTextPatterns: ['upload', 'download', 'copy', 'share', 'settings', 'stop response', 'stop generating', 'stop streaming', 'stop generation', 'cancel response', 'cancel generation', 'cancel generating', 'pause response', 'pause generation', '\\bstop\\b', '\\bcancel\\b', '\\bpause\\b', '\\babort\\b', '\\binterrupt\\b'],
        busy: ['button[aria-label*="Stop" i]', 'button[aria-label*="Cancel" i]', '[class*="loading" i]', '[aria-busy="true"]', ...GENERIC.busy],
        busyTextPatterns: ['stop', 'cancel', 'generating', ...GENERIC.busyTextPatterns],
        responseContainers: [...GENERIC.responseContainers],
        errorContainers: [...GENERIC.errorContainers],
        errorTextPatterns: [...GENERIC.errorTextPatterns],
        newChat: [],
        conversationLinks: [...GENERIC.conversationLinks],
        outputImages: ['img[src^="blob:"]', 'img[src^="data:image"]', 'img[src*="seaart"]', 'main img', ...GENERIC.outputImages],
        downloadButtons: ['button[aria-label*="Download" i]', '[role="button"][aria-label*="Download" i]', 'a[download]', 'button[class*="download" i]', ...GENERIC.downloadButtons],
        downloadTextPatterns: [...GENERIC.downloadTextPatterns]
      },
      preRunSteps: []
    },
    {
      id: 'perplexity',
      name: 'Perplexity',
      urlPatterns: ['^https://(www\\.)?perplexity\\.ai/'],
      hostnames: ['perplexity.ai', 'www.perplexity.ai'],
      promptInputMode: 'auto',
      adaptiveSelectors: true,
      selectors: {
        input: ['textarea[placeholder*="Ask" i]', 'textarea[aria-label*="Ask" i]', 'textarea', '[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', ...GENERIC.input],
        inputContainers: ['form', '[class*="composer" i]', '[class*="search" i]', 'main', ...GENERIC.inputContainers],
        submit: ['button[type="submit"]', 'button[aria-label*="Submit" i]', 'button[aria-label*="Send" i]', ...GENERIC.submit],
        submitTextPatterns: ['submit', 'send', 'ask', ...GENERIC.submitTextPatterns],
        submitExcludeTextPatterns: ['feedback', 'download', 'copy', 'share', 'settings', 'attach', 'stop response', 'stop generating', 'stop streaming', 'stop generation', 'cancel response', 'cancel generation', 'cancel generating', 'pause response', 'pause generation', '\\bstop\\b', '\\bcancel\\b', '\\bpause\\b', '\\babort\\b', '\\binterrupt\\b'],
        busy: ['button[aria-label*="Stop" i]', 'button[aria-label*="Cancel" i]', '[aria-busy="true"]', '[class*="loading" i]', ...GENERIC.busy],
        busyTextPatterns: ['stop', 'cancel', 'generating', ...GENERIC.busyTextPatterns],
        responseContainers: [...GENERIC.responseContainers],
        errorContainers: [...GENERIC.errorContainers],
        errorTextPatterns: [...GENERIC.errorTextPatterns],
        newChat: ['a[aria-label*="New" i]', 'button[aria-label*="New" i]', 'a[href="/"]'],
        conversationLinks: [...GENERIC.conversationLinks],
        outputImages: ['main img[src^="blob:"]', 'main img[src^="data:image"]', 'main img', ...GENERIC.outputImages],
        downloadButtons: ['button[aria-label*="Download" i]', '[role="button"][aria-label*="Download" i]', 'a[download]', ...GENERIC.downloadButtons],
        downloadTextPatterns: [...GENERIC.downloadTextPatterns]
      },
      preRunSteps: []
    }
  ]);
})(globalThis);
