/**
 * Unlock Flow — popup script.
 *
 * Shows whether the hook is enabled, reports the state of the current Flow tab
 * and offers "Enter Flow" / "Refresh" shortcuts. All user-facing text comes from
 * `_locales/en` via `chrome.i18n`.
 */
(() => {
  'use strict';

  const FLOW_ORIGIN = 'https://flow.google.com/';
  const HELPER_SCRIPT_ID = 'flow-helper';
  const UNSUPPORTED_PATH = '/unsupported-country';

  /** Popup copy, keyed by hook state. */
  const STATE_MESSAGE_KEY = {
    applied: 'statusApplied',
    'already-enabled': 'statusAlreadyEnabled',
    armed: 'statusArmed',
    'no-config-entry': 'statusNoConfigEntry',
    'schema-mismatch': 'statusSchemaMismatch',
    'frame-length-mismatch': 'statusFrameMismatch',
    'not-loaded': 'statusNotLoaded',
  };

  const t = (key, fallback) => (chrome.i18n?.getMessage(key) || fallback || key);

  const enabledToggle = document.getElementById('enabled');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  const refreshButton = document.getElementById('refresh');
  const openButton = document.getElementById('open');

  /** The active tab of the current window (a Flow tab, hopefully). */
  let tab;

  const setStatus = (text) => { statusEl.textContent = text; };
  const setError = (text) => { errorEl.textContent = text || ''; };

  /** Applies `data-i18n` attributes so the markup stays translation-ready. */
  function localize() {
    for (const node of document.querySelectorAll('[data-i18n]')) {
      const key = node.dataset.i18n;
      const value = chrome.i18n?.getMessage(key);
      if (value) node.textContent = value;
    }
    document.title = t('popupTitle', 'Unlock Flow');
  }

  /** Reads the stored preference, then verifies it against the real registration. */
  async function readEnabled() {
    const stored = await chrome.storage.local.get('enabled');
    let enabled = stored.enabled ?? true;
    try {
      const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [HELPER_SCRIPT_ID] });
      enabled = registered.length > 0;
    } catch {
      // keep the stored value if the API is unavailable
    }
    return enabled;
  }

  async function init() {
    enabledToggle.checked = await readEnabled();

    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const onFlow = Boolean(tab?.url?.startsWith(FLOW_ORIGIN));

    refreshButton.hidden = !onFlow;
    setError('');
    setStatus(enabledToggle.checked ? t('statusEnabled') : t('statusDisabled'));

    if (onFlow && enabledToggle.checked) {
      try {
        const diagnostic = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
        const key = STATE_MESSAGE_KEY[diagnostic?.state] || 'statusNotLoaded';
        setStatus(diagnostic?.applied && key === 'statusNotLoaded' ? t('statusApplied') : t(key));
        if (diagnostic?.state === 'schema-mismatch' || diagnostic?.state === 'frame-length-mismatch') {
          setError(t('errorUnexpected'));
        }
      } catch {
        // The content script is not running in this tab (opened before the hook was enabled).
        setStatus(t('statusNotLoaded'));
      }
    }

    const { lastError } = await chrome.storage.local.get('lastError');
    if (lastError) setError(lastError);

    enabledToggle.disabled = false;
  }

  // Enable / disable the hook.
  enabledToggle.addEventListener('change', async () => {
    enabledToggle.disabled = true;
    setError('');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'setEnabled',
        enabled: enabledToggle.checked,
      });
      if (!response?.ok) throw Error(response?.error || t('errorSaveFailed'));
      setStatus(t('statusSaved'));
    } catch (error) {
      enabledToggle.checked = !enabledToggle.checked;
      setError(error.message || t('errorSaveFailed'));
    } finally {
      enabledToggle.disabled = false;
    }
  });

  openButton.addEventListener('click', () => chrome.tabs.create({ url: FLOW_ORIGIN }));

  // Reload the Flow tab; if it is parked on /unsupported-country, drop that suffix first.
  refreshButton.addEventListener('click', async () => {
    try {
      const current = await chrome.tabs.get(tab?.id);
      if (!current?.url?.startsWith(FLOW_ORIGIN)) throw Error(t('errorPickFlowTab'));

      const url = new URL(current.url);
      if (url.pathname.endsWith(UNSUPPORTED_PATH)) {
        url.pathname = url.pathname.replace(/unsupported-country$/, '');
        await chrome.tabs.update(tab.id, { url: url.href });
      } else {
        await chrome.tabs.reload(tab.id);
      }

      window.close();
    } catch (error) {
      setError(error.message || t('errorUnexpected'));
    }
  });

  localize();
  init().catch((error) => setError(error.message || t('errorUnexpected')));
})();
