(function attachPromptPilotImageConverter(global) {
  'use strict';

  const root = global.PromptPilot || (global.PromptPilot = {});
  const utils = root.Utils;
  const dom = root.Dom;
  const messageTypes = root.MESSAGE_TYPES;

  function diagnosticUrl(value) {
    const source = String(value || '');
    if (!source) return '';
    if (/^data:/i.test(source)) return `data:[redacted:${utils.hashText(source)}:${source.length} chars]`;
    if (/^blob:/i.test(source)) return 'blob:[redacted]';
    try {
      const url = new URL(source, global.location?.href || undefined);
      return utils.truncate(`${url.origin}${url.pathname}`, 600);
    } catch (_) {
      return utils.truncate(source.replace(/[?#].*$/, ''), 600);
    }
  }

  function runtimeMessage(message, options) {
    return new Promise((resolve, reject) => {
      const timeoutMs = Math.max(1000, Number(options?.timeoutMs || 60000));
      const signal = options?.signal || null;
      let settled = false;
      let timeoutId = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener?.('abort', abortListener);
      };
      const finish = (value, isError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (isError) reject(value);
        else resolve(value);
      };
      const abortListener = () => finish(new Error('Stopped by user.'), true);

      if (!utils.hasUsableExtensionContext?.()) {
        finish(utils.createExtensionContextError?.('runtime messaging') || new Error('Extension context is not available.'), true);
        return;
      }
      if (signal?.aborted) {
        abortListener();
        return;
      }
      signal?.addEventListener?.('abort', abortListener, { once: true });
      timeoutId = setTimeout(() => finish(new Error(`Extension message timed out after ${timeoutMs} ms.`), true), timeoutMs);
      try {
        chrome.runtime.sendMessage(message, response => {
          const errorMessage = utils.getChromeLastErrorMessage?.() || '';
          if (errorMessage) finish(new Error(errorMessage), true);
          else if (response && response.ok === false) finish(new Error(response.error || 'Extension message failed.'), true);
          else finish(response || {}, false);
        });
      } catch (err) {
        finish(err, true);
      }
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read image blob.'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
  }

  async function fetchInPage(url, signal, timeoutMs) {
    const controller = new AbortController();
    const effectiveTimeout = Math.max(5000, Number(timeoutMs || 45000));
    let timedOut = false;
    const abortListener = () => controller.abort();
    if (signal?.aborted) abortListener();
    else signal?.addEventListener?.('abort', abortListener, { once: true });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeout);

    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Image fetch failed with HTTP ${response.status}.`);
      return blobToDataUrl(await response.blob());
    } catch (error) {
      if (signal?.aborted) throw new Error('Stopped by user.');
      if (timedOut) throw new Error(`Image fetch timed out after ${effectiveTimeout} ms.`);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener?.('abort', abortListener);
    }
  }

  async function fetchSourceAsDataUrl(sourceUrl, logger, signal, timeoutMs) {
    if (!sourceUrl) throw new Error('Generated image URL is empty.');
    if (/^data:/i.test(sourceUrl)) return sourceUrl;

    if (/^blob:/i.test(sourceUrl)) {
      return fetchInPage(sourceUrl, signal, timeoutMs);
    }

    try {
      return await fetchInPage(sourceUrl, signal, timeoutMs);
    } catch (err) {
      if (signal?.aborted) throw err;
      logger?.debug?.(`Page fetch for image failed, asking extension service worker. ${err.message}`);
    }

    const response = await runtimeMessage(
      { type: messageTypes.FETCH_IMAGE_AS_DATA_URL, url: sourceUrl },
      { signal, timeoutMs: Math.max(5000, Number(timeoutMs || 45000)) }
    );
    if (!response.dataUrl) throw new Error('Service worker did not return image data.');
    return response.dataUrl;
  }

  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not load image for JPEG conversion.'));
      image.src = dataUrl;
    });
  }

  async function convertDataUrlToJpeg(dataUrl, quality) {
    const image = await loadImageFromDataUrl(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('Generated image has invalid dimensions.');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', Number(quality || 0.92));
  }

  function asciiBytes(text) {
    const value = String(text || '').replace(/[^\x20-\x7E\n\r\t]/g, '?') + '\0';
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i += 1) bytes[i] = value.charCodeAt(i) & 0xFF;
    return bytes;
  }

  function utf16LeBytes(text) {
    const value = String(text || '') + '\0';
    const bytes = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      bytes[i * 2] = code & 0xFF;
      bytes[i * 2 + 1] = (code >> 8) & 0xFF;
    }
    return bytes;
  }

  function align2(offset) {
    return offset + (offset % 2);
  }

  function copyBytes(target, offset, source) {
    target.set(source, offset);
    return offset + source.length;
  }

  function writeIfdEntry(view, offset, tag, type, count, value) {
    view.setUint16(offset, tag, true);
    view.setUint16(offset + 2, type, true);
    view.setUint32(offset + 4, count, true);
    view.setUint32(offset + 8, value, true);
  }

  function buildExifApp1Segment(prompt, maxChars) {
    let comment = utils.truncate(String(prompt || ''), maxChars || 10000);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const description = asciiBytes(comment);
      const xpComment = utf16LeBytes(comment);
      const userCommentPrefix = new Uint8Array([0x41, 0x53, 0x43, 0x49, 0x49, 0x00, 0x00, 0x00]);
      const userCommentText = asciiBytes(comment);
      const userComment = new Uint8Array(userCommentPrefix.length + userCommentText.length);
      userComment.set(userCommentPrefix, 0);
      userComment.set(userCommentText, userCommentPrefix.length);

      const ifd0Offset = 8;
      const ifd0EntryCount = 3;
      const ifd0Size = 2 + ifd0EntryCount * 12 + 4;
      const exifIfdOffset = ifd0Offset + ifd0Size;
      const exifIfdEntryCount = 1;
      const exifIfdSize = 2 + exifIfdEntryCount * 12 + 4;

      let dataOffset = exifIfdOffset + exifIfdSize;
      const descriptionOffset = dataOffset;
      dataOffset = align2(dataOffset + description.length);
      const xpCommentOffset = dataOffset;
      dataOffset = align2(dataOffset + xpComment.length);
      const userCommentOffset = dataOffset;
      dataOffset = align2(dataOffset + userComment.length);

      const tiff = new Uint8Array(dataOffset);
      const view = new DataView(tiff.buffer);

      // TIFF header, little-endian.
      tiff[0] = 0x49; tiff[1] = 0x49;
      view.setUint16(2, 0x002A, true);
      view.setUint32(4, ifd0Offset, true);

      view.setUint16(ifd0Offset, ifd0EntryCount, true);
      let entryOffset = ifd0Offset + 2;
      writeIfdEntry(view, entryOffset, 0x010E, 2, description.length, descriptionOffset); // ImageDescription
      entryOffset += 12;
      writeIfdEntry(view, entryOffset, 0x8769, 4, 1, exifIfdOffset); // ExifIFDPointer
      entryOffset += 12;
      writeIfdEntry(view, entryOffset, 0x9C9C, 1, xpComment.length, xpCommentOffset); // XPComment
      entryOffset += 12;
      view.setUint32(entryOffset, 0, true);

      view.setUint16(exifIfdOffset, exifIfdEntryCount, true);
      writeIfdEntry(view, exifIfdOffset + 2, 0x9286, 7, userComment.length, userCommentOffset); // UserComment
      view.setUint32(exifIfdOffset + 2 + 12, 0, true);

      copyBytes(tiff, descriptionOffset, description);
      copyBytes(tiff, xpCommentOffset, xpComment);
      copyBytes(tiff, userCommentOffset, userComment);

      const exifHeader = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // Exif\0\0
      const app1Data = new Uint8Array(exifHeader.length + tiff.length);
      app1Data.set(exifHeader, 0);
      app1Data.set(tiff, exifHeader.length);

      if (app1Data.length <= 65533) {
        const segment = new Uint8Array(4 + app1Data.length);
        segment[0] = 0xFF;
        segment[1] = 0xE1;
        const length = app1Data.length + 2;
        segment[2] = (length >> 8) & 0xFF;
        segment[3] = length & 0xFF;
        segment.set(app1Data, 4);
        return segment;
      }

      comment = utils.truncate(comment, Math.max(256, Math.floor(comment.length * 0.7)));
    }

    throw new Error('EXIF comment is too large to embed.');
  }

  function insertExifIntoJpegDataUrl(jpegDataUrl, prompt, maxChars) {
    const parsed = utils.dataUrlToBytes(jpegDataUrl);
    const bytes = parsed.bytes;
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error('Canvas did not produce a valid JPEG.');

    const exifSegment = buildExifApp1Segment(prompt, maxChars);
    const output = new Uint8Array(bytes.length + exifSegment.length);
    output.set(bytes.subarray(0, 2), 0);
    output.set(exifSegment, 2);
    output.set(bytes.subarray(2), 2 + exifSegment.length);
    return utils.bytesToDataUrl(output, 'image/jpeg');
  }

  function buildDownloadFilename(config, settings, prompt, context) {
    const downloadSettings = settings.download || {};
    const siteName = utils.slugify(config?.id || 'site', 'site');
    const index = utils.padNumber((context?.promptIndex || 0) + 1, 4);
    const slug = utils.slugify(prompt, 'prompt');
    const timestamp = utils.nowTimestamp();
    const rawName = utils.templateFilename(downloadSettings.filenameTemplate, {
      index,
      site: siteName,
      slug,
      timestamp,
      ext: 'jpg'
    });
    const filename = utils.sanitizeFilename(rawName.replace(/\.jpeg$/i, '.jpg').replace(/\.jpg$/i, ''), `${index}-${slug}`) + '.jpg';
    const folder = utils.sanitizeFilename(downloadSettings.folder || 'PromptPilot', 'PromptPilot');
    return `${folder}/${siteName}/${filename}`;
  }

  async function waitForImageReady(image, signal) {
    if (!image) throw new Error('No generated image found.');
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) return image;
    await dom.waitFor(() => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0, {
      timeout: 30000,
      interval: 250,
      name: 'generated image to finish loading',
      signal
    });
    return image;
  }

  function makeToken() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return `pp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function waitForNativeDownloadCapture(token, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutId = null;
      let abortListener = null;

      const cleanup = () => {
        try { chrome.runtime.onMessage.removeListener(listener); } catch (_) {}
        if (timeoutId) clearTimeout(timeoutId);
        if (abortListener) signal?.removeEventListener?.('abort', abortListener);
      };

      const finish = (value, isError) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (isError) reject(value);
        else resolve(value);
      };

      const listener = message => {
        if (!message || message.type !== messageTypes.NATIVE_DOWNLOAD_CAPTURED || message.token !== token) return;
        finish(message, false);
      };

      try {
        chrome.runtime.onMessage.addListener(listener);
      } catch (err) {
        finish(err, true);
        return;
      }
      timeoutId = setTimeout(() => finish(new Error('Timed out waiting for the native full-resolution download to start.'), true), timeoutMs);

      abortListener = () => finish(new Error('Stopped by user.'), true);
      if (signal) {
        if (signal.aborted) abortListener();
        else signal.addEventListener('abort', abortListener, { once: true });
      }
    });
  }

  async function downloadDataUrlAsJpeg(config, settings, prompt, context, sourceDataUrl, signal) {
    const jpegDataUrl = await convertDataUrlToJpeg(sourceDataUrl, settings.download?.quality || 0.92);
    const exifDataUrl = insertExifIntoJpegDataUrl(jpegDataUrl, prompt, settings.download?.exifMaxChars || 10000);
    const filename = buildDownloadFilename(config, settings, prompt, context);

    const response = await runtimeMessage({
      type: messageTypes.DOWNLOAD_DATA_URL,
      dataUrl: exifDataUrl,
      filename
    }, {
      signal,
      timeoutMs: Math.max(10000, Number(settings.download?.operationTimeoutMs || 90000))
    });

    return { skipped: false, filename, downloadId: response.downloadId || null };
  }

  function getLatestGeneratedImage(config, settings) {
    const configured = config?.selectors?.outputImages || [];
    const generic = settings?.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.outputImages || []) : [];
    const images = dom.getLargeVisibleImages([...configured, ...generic]);
    return images[images.length - 1] || null;
  }

  async function findNativeDownloadButton(config, settings, image, signal) {
    const selectors = [
      ...(config?.selectors?.downloadButtons || []),
      ...(settings?.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.downloadButtons || []) : [])
    ];
    const textPatterns = [
      ...(config?.selectors?.downloadTextPatterns || []),
      ...(settings?.adaptiveDomSearch !== false ? (root.GENERIC_SITE_SELECTORS?.downloadTextPatterns || []) : [])
    ];

    if (image) dom.hoverElement(image.closest?.('[class*="image" i], article, [role="article"]') || image.parentElement || image);
    await utils.sleep(350);

    const button = dom.findDownloadButtonForImage(image, selectors, textPatterns);
    if (button) return button;

    // Some apps only render the download action after an image hover animation completes.
    if (image) {
      dom.hoverElement(image);
      await utils.sleep(800);
      const delayedButton = dom.findDownloadButtonForImage(image, selectors, textPatterns);
      if (delayedButton) return delayedButton;
    }

    // Final generic fallback: choose the best visible download-like control on the page.
    return dom.findByText(['button', 'a', '[role="button"]', 'mat-icon', 'svg'], textPatterns, {
      excludeTextPatterns: ['feedback', 'copy', 'share', 'delete', 'close'],
      predicate: element => !dom.isDisabled(dom.buttonLike(element) || element)
    });
  }

  async function clickNativeAndRewrite(config, settings, prompt, context, logger, signal) {
    const downloadSettings = settings.download || {};
    const image = getLatestGeneratedImage(config, settings);
    const button = await findNativeDownloadButton(config, settings, image, signal);
    if (!button) throw new Error('Could not find a full-resolution download button. Update downloadButtons selectors for this site.');

    let captureEnabled = downloadSettings.captureNativeDownload !== false;
    const token = makeToken();
    let capturePromise = null;

    if (captureEnabled) {
      try {
        await runtimeMessage({
          type: messageTypes.ARM_NATIVE_DOWNLOAD_CAPTURE,
          token,
          timeoutMs: Math.max(5000, Number(downloadSettings.captureTimeoutMs || 25000)),
          cancelOriginal: false
        }, { signal, timeoutMs: 10000 });
        capturePromise = waitForNativeDownloadCapture(token, Math.max(5000, Number(downloadSettings.captureTimeoutMs || 25000)), signal);
      } catch (err) {
        captureEnabled = false;
        logger?.warn?.(`Could not arm EXIF rewrite capture: ${err.message}. Clicking the platform download button and keeping the native full-resolution download.`);
      }
    }

    logger?.debug?.('Clicking the site native download button for full-resolution image.');
    if (!dom.safeClick(button, { logger, purpose: 'download-generated-image', throwOnUnsafe: true })) {
      throw new Error('The native download control could not be clicked safely.');
    }

    if (!captureEnabled) {
      return {
        skipped: false,
        nativeOnly: true,
        filename: 'native platform download',
        reason: 'native button clicked; capture disabled'
      };
    }

    let captured;
    try {
      captured = await capturePromise;
    } catch (err) {
      await runtimeMessage({ type: messageTypes.DISARM_NATIVE_DOWNLOAD_CAPTURE, token }, { timeoutMs: 5000 }).catch(() => {});
      logger?.warn?.(`${err.message} The native platform download button was clicked; leaving that download as the fallback.`);
      return {
        skipped: false,
        nativeOnly: true,
        filename: 'native platform download',
        reason: err.message
      };
    }

    const item = captured.item || {};
    const sourceUrl = item.finalUrl || item.url;
    if (!sourceUrl) throw new Error('Native full-resolution download was captured, but Chrome did not expose its URL.');

    try {
      logger?.debug?.('Captured native full-resolution download URL for EXIF rewrite.', { sourceUrl: diagnosticUrl(sourceUrl) });
      const dataUrl = await fetchSourceAsDataUrl(
        sourceUrl,
        logger,
        signal,
        Math.max(5000, Number(downloadSettings.operationTimeoutMs || 90000))
      );
      return await downloadDataUrlAsJpeg(config, settings, prompt, context, dataUrl, signal);
    } catch (err) {
      logger?.warn?.(`Could not rewrite captured full-resolution download with EXIF: ${err.message}`);
      logger?.warn?.('The original native full-resolution download was preserved, so no second download click is needed.');
      return {
        skipped: false,
        nativeOnly: true,
        filename: 'native platform download',
        reason: err.message
      };
    }
  }

  async function downloadFromPreviewImage(config, settings, prompt, context, logger, signal) {
    const image = getLatestGeneratedImage(config, settings);
    if (!image) throw new Error('Could not find the generated image to download. Update outputImages selectors for this site.');

    await waitForImageReady(image, signal);
    const sourceUrl = image.currentSrc || image.src;
    logger?.debug?.('Preparing visible generated image for JPEG download.', { sourceUrl: diagnosticUrl(sourceUrl) });

    const originalDataUrl = await fetchSourceAsDataUrl(
      sourceUrl,
      logger,
      signal,
      Math.max(5000, Number(settings.download?.operationTimeoutMs || 90000))
    );
    return downloadDataUrlAsJpeg(config, settings, prompt, context, originalDataUrl, signal);
  }

  async function downloadLatestImage(config, settings, prompt, context, logger, signal) {
    const downloadSettings = settings.download || {};
    const hasDownloadButtons = Boolean(config?.selectors?.downloadButtons?.length || root.GENERIC_SITE_SELECTORS?.downloadButtons?.length);

    if (downloadSettings.clickNativeButton !== false && hasDownloadButtons) {
      return clickNativeAndRewrite(config, settings, prompt, context, logger, signal);
    }

    if (downloadSettings.fallbackToPreviewImage) {
      return downloadFromPreviewImage(config, settings, prompt, context, logger, signal);
    }

    return { skipped: true, reason: 'download disabled for preview fallback and no native download flow was available' };
  }

  root.ImageConverter = Object.freeze({
    fetchSourceAsDataUrl,
    convertDataUrlToJpeg,
    insertExifIntoJpegDataUrl,
    downloadLatestImage
  });
})(globalThis);
