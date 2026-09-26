Unlock Flow — helper extension for Google Flow.

Install
1. Download and unzip this archive; keep the folder in place.
2. Open chrome://extensions and enable "Developer mode".
3. Click "Load unpacked" and select this folder (the one containing manifest.json).
4. Pin "Unlock Flow" to the toolbar and open Flow: https://flow.google.com

Use
- The toolbar popup switches the helper on and off and shows the state of the
  current Flow tab ("working", "ready", "needs update"…).
- "Enter Flow" opens Flow in a new tab, "Refresh" reloads the current Flow tab
  (dropping the /unsupported-country suffix first).
- After switching the helper on, reopen already open Flow tabs — the hook is
  injected at document_start.

Files
- hook.js       page hook (MAIN world): patches the availability flag in Flow's
                batchexecute response.
- status.js     content script: reports the hook state to the popup.
- background.js service worker: registers/unregisters the hook.
- popup.*       toolbar UI; all texts live in _locales/en/messages.json.
- tests/        `node tests/run.js` — unit + integration tests with stubbed
                Chrome APIs (no browser needed).

Chrome 111 or newer is required.
