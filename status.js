/**
 * Unlock Flow — status bridge (isolated world content script).
 *
 * The hook lives in the MAIN world and cannot talk to the extension directly, so
 * it publishes its diagnostic state as `CustomEvent`s on `window`. This script
 * caches them and answers `{ type: 'status' }` requests coming from the popup.
 *
 * Event transport instead of a DOM attribute: nothing is left behind in the page
 * for the site (or other extensions) to detect.
 */
(() => {
  'use strict';

  const STATE_EVENT = 'flow-local-diagnostic:state';
  const REQUEST_EVENT = 'flow-local-diagnostic:request';
  const MAX_STATE_LENGTH = 80;
  const REPLY_TIMEOUT_MS = 250;

  /** @type {{ diagnostic: object, at: number } | null} */
  let cached = null;

  const remember = (diagnostic) => {
    cached = { diagnostic, at: Date.now() };
  };

  window.addEventListener(STATE_EVENT, (event) => {
    let diagnostic;
    try {
      diagnostic = JSON.parse(typeof event.detail === 'string' ? event.detail : 'null');
    } catch {
      return;
    }
    if (diagnostic && typeof diagnostic === 'object') remember(diagnostic);
  });

  /** The hook may have published before this script loaded — ask it again. */
  function requestFresh() {
    return new Promise((resolve) => {
      let settled = false;
      const onState = (event) => {
        if (settled) return;
        settled = true;
        window.removeEventListener(STATE_EVENT, onState);
        try {
          resolve(JSON.parse(event.detail));
        } catch {
          resolve(null);
        }
      };
      window.addEventListener(STATE_EVENT, onState);
      window.dispatchEvent(new CustomEvent(REQUEST_EVENT));
      setTimeout(() => {
        if (settled) return;
        settled = true;
        window.removeEventListener(STATE_EVENT, onState);
        resolve(null);
      }, REPLY_TIMEOUT_MS);
    });
  }

  /** Falls back to the marker object the hook keeps on `window`. */
  function readMarker() {
    try {
      const marker = window.__flowLocalDiagnostic;
      return marker && typeof marker === 'object' ? marker : null;
    } catch {
      return null;
    }
  }

  function describe(diagnostic) {
    return {
      state:
        typeof diagnostic?.state === 'string'
          ? diagnostic.state.slice(0, MAX_STATE_LENGTH)
          : 'not-loaded',
      applied: diagnostic?.applied > 0,
      patched: diagnostic?.patched ?? 0,
      requestsSeen: diagnostic?.requestsSeen ?? 0,
      stale: cached ? Date.now() - cached.at > 60000 : false,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'status') return;

    (async () => {
      const diagnostic = cached?.diagnostic || (await requestFresh()) || readMarker();
      sendResponse(describe(diagnostic));
    })();

    return true; // the response is asynchronous
  });
})();
