/**
 * Unlock Flow — background service worker (MV3).
 *
 * Owns the registration of the MAIN-world hook (`hook.js`) on Google Flow and
 * lets the popup switch it on and off. The intended state is kept in
 * `chrome.storage.local` so the popup opens instantly, and is reconciled with
 * the real registration whenever the worker starts up.
 */
'use strict';

const HELPER_SCRIPT_ID = 'flow-helper';
const STORAGE_KEY_ENABLED = 'enabled';
const STORAGE_KEY_LAST_ERROR = 'lastError';
const DEFAULT_ENABLED = true;

/** Registration descriptor of the page hook (persists across browser restarts). */
const registration = {
  id: HELPER_SCRIPT_ID,
  matches: ['https://flow.google.com/*'],
  js: ['hook.js'],
  runAt: 'document_start',
  world: 'MAIN',
  persistAcrossSessions: true,
};

const errorMessage = (error) =>
  [String(error?.message || error || 'unknown error'), chrome.runtime.lastError?.message]
    .filter(Boolean)
    .join(' — ');

async function isRegistered() {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [HELPER_SCRIPT_ID] });
  return scripts.length > 0;
}

/** Applies the desired state and reports what happened. */
async function applyEnabled(enabled) {
  if (enabled) {
    if (await isRegistered()) return { ok: true, error: null };
    try {
      await chrome.scripting.registerContentScripts([registration]);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  if (!(await isRegistered())) return { ok: true, error: null };
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [HELPER_SCRIPT_ID] });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function setEnabled(enabled) {
  const result = await applyEnabled(enabled);
  await chrome.storage.local.set({
    [STORAGE_KEY_ENABLED]: enabled,
    [STORAGE_KEY_LAST_ERROR]: result.error,
  });
  return result;
}

/** Makes the registration match the stored preference (repairs desyncs). */
async function reconcile() {
  const stored = await chrome.storage.local.get(STORAGE_KEY_ENABLED);
  const enabled = stored[STORAGE_KEY_ENABLED] ?? DEFAULT_ENABLED;
  const result = await applyEnabled(enabled);
  await chrome.storage.local.set({ [STORAGE_KEY_LAST_ERROR]: result.error });
  return result;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ [STORAGE_KEY_ENABLED]: DEFAULT_ENABLED });
    await setEnabled(DEFAULT_ENABLED);
    return;
  }
  // On update, refresh the descriptor: `matches` / `js` / `runAt` may have changed.
  const stored = await chrome.storage.local.get(STORAGE_KEY_ENABLED);
  const enabled = stored[STORAGE_KEY_ENABLED] ?? DEFAULT_ENABLED;
  await applyEnabled(false);
  if (enabled) await applyEnabled(true);
  await chrome.storage.local.set({ [STORAGE_KEY_LAST_ERROR]: null });
});

chrome.runtime.onStartup.addListener(() => {
  reconcile().catch((error) => console.error('Flow Helper reconcile failed:', error.message));
});

// Popup -> background: enable / disable the hook.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== 'setEnabled') return;

  setEnabled(Boolean(message.enabled))
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));

  return true; // keep the message channel open for the asynchronous response
});

// Catch up on the very first start after install (onStartup does not fire then).
reconcile().catch((error) => console.error('Flow Helper reconcile failed:', error.message));
