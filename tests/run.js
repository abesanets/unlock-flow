/**
 * Unlock Flow — unit + integration tests.
 * Run with:  node tests/run.js
 *
 * Browser APIs are stubbed (see ./harness.js), so no browser is needed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  ROOT,
  MESSAGES,
  createDocument,
  createWindow,
  createChrome,
  createXHR,
  runScript,
  flush,
} = require('./harness');

const FLOW = 'https://flow.google.com/';
const CONFIG_URL = FLOW + '_/AiSandboxAngularFrontend/data/batchexecute?rpcids=cPZSdc';
const STATE_EVENT = 'flow-local-diagnostic:state';
const REQUEST_EVENT = 'flow-local-diagnostic:request';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* --------------------------------------------------------------- fixtures */
function buildBody({
  unit = 'bytes',
  flag = false,
  flagIndex = 30,
  length = 32,
  prefixOffset = 0,
  rpc = 'cPZSdc',
  extraEntries = 0,
  payloadField = null,
  fill = null,
  flags = {},
} = {}) {
  const payload = new Array(length).fill(fill);
  if (Object.keys(flags).length) {
    for (const [index, value] of Object.entries(flags)) payload[Number(index)] = value;
  } else if (flagIndex < length) {
    payload[flagIndex] = flag;
  }
  const entry = ['wrb.fr', rpc, JSON.stringify(payload), null, null, null, 'generic'];
  const envelope = [entry];
  for (let i = 0; i < extraEntries; i++) envelope.push(['di', 22 + i]);
  if (payloadField !== null) entry[2] = payloadField;

  const line = JSON.stringify(envelope);
  const len = unit === 'bytes' ? new TextEncoder().encode(line).length : line.length;
  return [")]}'", '', String(len + prefixOffset), line, '25', '[["e",4,null,null,519]]'].join('\n');
}

function parseChunk(body) {
  const lines = body.split('\n');
  const index = lines.findIndex((line) => line.startsWith('[['));
  return { envelope: JSON.parse(lines[index]), prefix: Number(lines[index - 1]), line: lines[index] };
}

/* ---------------------------------------------------------- 1. i18n check */
test('i18n: every key used by the popup exists in _locales/en', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const keys = new Set();

  const stateMap = popup.slice(popup.indexOf('STATE_MESSAGE_KEY'), popup.indexOf('const t ='));
  for (const match of stateMap.matchAll(/:\s*'([A-Za-z0-9_]+)'/g)) keys.add(match[1]);
  for (const match of popup.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) keys.add(match[1]);
  for (const match of html.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) keys.add(match[1]);

  assert.ok(keys.size > 12, `expected to find popup keys, found ${keys.size}`);
  for (const key of keys) assert.ok(MESSAGES[key]?.message, `missing message: ${key}`);

  // every state the hook can publish must be mapped by the popup
  for (const state of Object.values(STATE)) {
    const mapped = new RegExp(`['"]?${state}['"]?\\s*:`, 'm');
    assert.ok(mapped.test(stateMap), `popup.js does not map the hook state "${state}"`);
  }
});

test('i18n: manifest placeholders are defined', () => {
  const manifest = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
  for (const match of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    assert.ok(MESSAGES[match[1]], `missing message: ${match[1]}`);
  }
});

test('i18n: the UI has no non-Latin text left', () => {
  for (const file of ['popup.html', 'popup.js', 'status.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/[က-῿؀-ۿ]/.test(source), `${file} still contains non-Latin UI text`);
  }
});

/* ------------------------------------------------------- 2. patch function */
const { patch, findFlagIndex, selectLengthUnit, STATE } = require(path.join(ROOT, 'hook.js'));

test('patch: flips the flag and rewrites the byte length prefix', () => {
  const body = buildBody({ flag: false });
  const result = patch(body);
  assert.strictEqual(result.patched, 1);
  assert.strictEqual(result.before, false);

  const { envelope, prefix, line } = parseChunk(result.body);
  assert.strictEqual(JSON.parse(envelope[0][2])[30], true, 'flag was not flipped');
  assert.strictEqual(prefix, new TextEncoder().encode(line).length, 'length prefix not rewritten');
});

test('patch: supports a UTF-16 length prefix', () => {
  const result = patch(buildBody({ unit: 'utf16', flag: false }));
  const { prefix, line } = parseChunk(result.body);
  assert.strictEqual(result.patched, 1);
  assert.strictEqual(prefix, line.length);
});

test('patch: preserves a length prefix that was off by one', () => {
  const result = patch(buildBody({ flag: false, prefixOffset: 1 }));
  const { prefix, line } = parseChunk(result.body);
  assert.strictEqual(result.patched, 1);
  assert.strictEqual(prefix - line.length, 1, 'the original offset must survive');
});

test('patch: reports the previous flag value', () => {
  assert.strictEqual(patch(buildBody({ flag: null })).before, null);
  assert.strictEqual(patch(buildBody({ flag: true })).before, true);
});

test('patch: extra entries in the same chunk do not break it', () => {
  const result = patch(buildBody({ flag: false, extraEntries: 2 }));
  assert.strictEqual(result.patched, 1);
  assert.strictEqual(JSON.parse(parseChunk(result.body).envelope[0][2])[30], true);
});

test('patch: a response without a config entry is passed through, not rejected', () => {
  const body = buildBody({ rpc: 'other' });
  const result = patch(body);
  assert.strictEqual(result.patched, 0);
  assert.strictEqual(result.body, body, 'body must be untouched');
});

test('patch: several config chunks are all patched', () => {
  const secondLine = JSON.stringify([
    ['wrb.fr', 'cPZSdc', JSON.stringify(new Array(32).fill(null)), null, null, null, 'g'],
  ]);
  const body = buildBody({ flag: false }) + '\n' + String(secondLine.length) + '\n' + secondLine;
  assert.strictEqual(patch(body).patched, 2);
});

test('patch: schema problems carry the schema-mismatch code', () => {
  const cases = [
    [buildBody({ length: 10 }), 'expected at least'],
    [buildBody({ fill: 'x', flags: { 27: true, 29: true } }), 'ambiguous'],
    [buildBody({ payloadField: 42 }), 'not a string'],
    [buildBody({ payloadField: '{not json' }), 'not valid JSON'],
  ];

  for (const [body, expected] of cases) {
    let thrown;
    try { patch(body); } catch (error) { thrown = error; }
    assert.ok(thrown, 'expected a throw');
    assert.strictEqual(thrown.code, STATE.schemaMismatch, `wrong code: ${thrown?.code}`);
    assert.match(thrown.message, new RegExp(expected));
  }
});

test('patch: a broken length prefix carries the frame-length-mismatch code', () => {
  let thrown;
  try { patch(buildBody({ prefixOffset: 400 })); } catch (error) { thrown = error; }
  assert.ok(thrown, 'expected a throw');
  assert.strictEqual(thrown.code, STATE.frameMismatch);
});

test('findFlagIndex: prefers index 30, then a boolean, then the nearest null', () => {
  assert.strictEqual(findFlagIndex(new Array(31).fill(null)), 30);

  const shifted = new Array(32).fill('x');
  shifted[26] = true;
  assert.strictEqual(findFlagIndex(shifted), 26);

  const onlyNulls = new Array(32).fill('x');
  onlyNulls[28] = null;
  assert.strictEqual(findFlagIndex(onlyNulls), 28);

  assert.throws(() => findFlagIndex(new Array(32).fill('x')), /no boolean or null/);
});

test('selectLengthUnit: picks the unit with the smallest delta', () => {
  const line = '[[1,2,3]]';
  const unit = selectLengthUnit(new TextEncoder().encode(line).length, line);
  assert.ok(unit, 'no unit selected');
  assert.strictEqual(unit.fn(line), new TextEncoder().encode(line).length);
  assert.strictEqual(selectLengthUnit(99999, line), undefined);
});

/* ------------------------------------------------- 3. hook: XHR interception */
function bootHook({ fetchImpl } = {}) {
  const win = createWindow();
  if (fetchImpl) win.fetch = fetchImpl;
  const { chrome } = createChrome();
  const { ctx } = runScript('hook.js', {
    document: createDocument(),
    window: win,
    chrome,
    XMLHttpRequest: createXHR(),
  });
  return { win, chrome, ctx };
}

function readBody(ctx, { url, body, readyState = 4, twice = false, prop = 'responseText', reopen = null }) {
  ctx.__case = { url, body, readyState, twice, prop, reopen };
  return vm.runInContext(
    `(() => {
      const c = __case;
      const xhr = new XMLHttpRequest();
      xhr._body = c.body;
      xhr.readyState = c.readyState;
      xhr.open('POST', c.url);
      const out = {};
      out.first = xhr[c.prop];
      if (c.twice) out.second = xhr[c.prop];
      if (c.reopen) { xhr.open('POST', c.reopen); out.second = xhr[c.prop]; }
      return out;
    })()`,
    ctx
  );
}

test('hook: rewrites the config response and reports "applied"', () => {
  const { ctx, win } = bootHook();
  const out = readBody(ctx, { url: CONFIG_URL, body: buildBody({ flag: false }) });

  assert.strictEqual(JSON.parse(parseChunk(out.first).envelope[0][2])[30], true);
  assert.strictEqual(win.__flowLocalDiagnostic.state, 'applied');
  assert.strictEqual(win.__flowLocalDiagnostic.applied, 1);
  assert.strictEqual(win.__flowLocalDiagnostic.before, false);
  assert.strictEqual(win.__flowLocalDiagnostic.requestsSeen, 1);
});

test('hook: an already-enabled response is reported separately', () => {
  const { ctx, win } = bootHook();
  readBody(ctx, { url: CONFIG_URL, body: buildBody({ flag: true }) });
  assert.strictEqual(win.__flowLocalDiagnostic.state, 'already-enabled');
});

test('hook: caches the patched body and resets the cache on re-open', () => {
  const { ctx, win } = bootHook();
  const body = buildBody({ flag: false });

  const cached = readBody(ctx, { url: CONFIG_URL, body, twice: true });
  assert.strictEqual(cached.first, cached.second, 'the same body must come back');
  assert.strictEqual(win.__flowLocalDiagnostic.applied, 1, 'a cached body must be counted once');

  readBody(ctx, { url: CONFIG_URL, body }); // a new request
  assert.strictEqual(win.__flowLocalDiagnostic.applied, 2);

  const reopened = readBody(ctx, { url: CONFIG_URL, body, reopen: CONFIG_URL });
  assert.strictEqual(reopened.first, reopened.second, 'the re-opened request must be patched too');
  assert.strictEqual(win.__flowLocalDiagnostic.applied, 4, 're-open must clear the cache');
});

test('hook: hides partial chunks and passes earlier ready states through', () => {
  const { ctx, win } = bootHook();
  const body = buildBody({ flag: false });
  assert.strictEqual(readBody(ctx, { url: CONFIG_URL, body, readyState: 3 }).first, '');
  assert.strictEqual(win.__flowLocalDiagnostic.heldPartial, true);
  assert.strictEqual(readBody(ctx, { url: CONFIG_URL, body, readyState: 2 }).first, body);
});

test('hook: leaves unrelated requests alone', () => {
  const { ctx, win } = bootHook();
  const body = buildBody({ flag: false });
  assert.strictEqual(readBody(ctx, { url: FLOW + 'other?rpcids=cPZSdc', body }).first, body);
  assert.strictEqual(readBody(ctx, { url: CONFIG_URL.replace('cPZSdc', 'zzz'), body }).first, body);
  assert.strictEqual(readBody(ctx, { url: 'https://other.example/x?rpcids=cPZSdc', body }).first, body);
  assert.strictEqual(win.__flowLocalDiagnostic.requestsSeen, 0);
  assert.strictEqual(win.__flowLocalDiagnostic.state, 'armed');
});

test('hook: matches a batched rpcids parameter', () => {
  const { ctx, win } = bootHook();
  const url = FLOW + '_/AiSandboxAngularFrontend/data/batchexecute?rpcids=other,cPZSdc';
  const out = readBody(ctx, { url, body: buildBody({ flag: false }) });
  assert.strictEqual(JSON.parse(parseChunk(out.first).envelope[0][2])[30], true);
  assert.strictEqual(win.__flowLocalDiagnostic.requestsSeen, 1);
});

test('hook: an unknown schema passes the response through unchanged', () => {
  const { ctx, win } = bootHook();
  const body = buildBody({ length: 8 });
  const out = readBody(ctx, { url: CONFIG_URL, body });
  assert.strictEqual(out.first, body, 'the response must not be modified');
  assert.strictEqual(win.__flowLocalDiagnostic.state, 'schema-mismatch');
  assert.ok(win.__flowLocalDiagnostic.detail, 'the reason should be recorded');
});

test('hook: publishes state changes as events and answers polls', () => {
  const { ctx, win } = bootHook();
  assert.strictEqual(win.__flowLocalDiagnostic.state, 'armed', 'should arm itself on load');

  const seen = [];
  win.addEventListener(STATE_EVENT, (event) => seen.push(JSON.parse(event.detail)));
  readBody(ctx, { url: CONFIG_URL, body: buildBody({ flag: false }) });
  win.dispatchEvent(new CustomEvent(REQUEST_EVENT));

  assert.strictEqual(seen.length, 2, 'one event per state change plus the poll answer');
  assert.strictEqual(seen[0].state, 'applied');
  assert.strictEqual(seen[1].state, 'applied');
});

test('hook: installing twice is a no-op', () => {
  const { win } = bootHook();
  const marker = win.__flowLocalDiagnostic;
  runScript('hook.js', {
    document: createDocument(),
    window: win,
    chrome: createChrome().chrome,
    XMLHttpRequest: createXHR(),
  });
  assert.strictEqual(win.__flowLocalDiagnostic, marker);
});

/* --------------------------------------------------------- 4. hook: fetch */
test('hook: fetch responses are patched too', async () => {
  const body = buildBody({ flag: false });
  const { ctx, win } = bootHook({
    fetchImpl: async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/plain', 'content-length': '999' } }),
  });

  const result = await vm.runInContext(
    `(async () => {
      const r = await window.fetch('${CONFIG_URL}', { method: 'POST' });
      return { text: await r.text(), length: r.headers.get('content-length') };
    })()`,
    ctx
  );

  assert.strictEqual(JSON.parse(parseChunk(result.text).envelope[0][2])[30], true);
  assert.strictEqual(result.length, null, 'content-length must be dropped for a rewritten body');
  assert.strictEqual(win.__flowLocalDiagnostic.state, 'applied');
});

test('hook: non-config fetch calls go straight through', async () => {
  const { ctx, win } = bootHook({ fetchImpl: async () => new Response('plain', { status: 200 }) });
  const text = await vm.runInContext(`(async () => (await window.fetch('${FLOW}other')).text())()`, ctx);
  assert.strictEqual(text, 'plain');
  assert.strictEqual(win.__flowLocalDiagnostic.state, 'armed');
});

/* -------------------------------------------------------- 5. status bridge */
function bootStatus() {
  const win = createWindow();
  const { chrome, handlers } = createChrome();
  runScript('status.js', { document: createDocument(), window: win, chrome });
  return { win, chrome, handlers };
}

const askStatus = (handlers, message = { type: 'status' }, sender = { id: 'EXTID' }) =>
  Promise.race([
    new Promise((resolve) => {
      for (const fn of handlers.message) fn(message, sender, resolve);
    }),
    new Promise((_, reject) => setTimeout(() => reject(Error('no response from status.js')), 1000)),
  ]);

test('status: answers the popup from cached state events', async () => {
  const { win, handlers } = bootStatus();
  win.dispatchEvent(
    new CustomEvent(STATE_EVENT, {
      detail: JSON.stringify({ state: 'applied', applied: 3, patched: 3, requestsSeen: 5 }),
    })
  );
  const response = await askStatus(handlers);
  assert.strictEqual(response.state, 'applied');
  assert.strictEqual(response.applied, true);
  assert.strictEqual(response.requestsSeen, 5);
  assert.strictEqual(response.stale, false);
});

test('status: polls the hook when nothing is cached yet', async () => {
  const { win, handlers } = bootStatus();
  win.addEventListener(REQUEST_EVENT, () => {
    setTimeout(
      () =>
        win.dispatchEvent(
          new CustomEvent(STATE_EVENT, { detail: JSON.stringify({ state: 'armed', applied: 0 }) })
        ),
      5
    );
  });
  const response = await askStatus(handlers);
  assert.strictEqual(response.state, 'armed');
});

test('status: reports not-loaded when the hook never answers', async () => {
  const { handlers } = bootStatus();
  const response = await askStatus(handlers);
  assert.strictEqual(response.state, 'not-loaded');
  assert.strictEqual(response.applied, false);
});

test('status: ignores foreign senders and other message types', async () => {
  const { handlers } = bootStatus();
  let called = false;
  for (const fn of handlers.message) {
    await fn({ type: 'status' }, { id: 'OTHER' }, () => { called = true; });
    await fn({ type: 'setEnabled' }, { id: 'EXTID' }, () => { called = true; });
  }
  await delay(20);
  assert.strictEqual(called, false);
});

/* ------------------------------------------------------------ 6. background */
async function bootBackground(options = {}) {
  const { chrome, calls, handlers, store, registeredIds, getDescriptor } = createChrome(options);
  runScript('background.js', { document: createDocument(), window: createWindow(), chrome });
  await flush(10);
  return { chrome, calls, handlers, store, registeredIds, getDescriptor };
}

test('background: registers the hook on install', async () => {
  const { handlers, registeredIds, store } = await bootBackground();
  for (const fn of handlers.installed) await fn({ reason: 'install' });
  await flush(6);
  assert.ok(registeredIds.has('flow-helper'), 'the hook was not registered');
  assert.strictEqual(store.enabled, true);
});

test('background: setEnabled toggles the registration', async () => {
  const { handlers, registeredIds, store } = await bootBackground({ registered: true });

  let response;
  for (const fn of handlers.message) {
    await fn({ type: 'setEnabled', enabled: false }, { id: 'EXTID' }, (r) => { response = r; });
  }
  await flush(4);
  assert.strictEqual(response.ok, true, `unexpected response: ${JSON.stringify(response)}`);
  assert.strictEqual(response.error, null);
  assert.ok(!registeredIds.has('flow-helper'), 'the hook should be unregistered');
  assert.strictEqual(store.enabled, false);

  for (const fn of handlers.message) {
    await fn({ type: 'setEnabled', enabled: true }, { id: 'EXTID' }, (r) => { response = r; });
  }
  await flush(4);
  assert.strictEqual(response.ok, true, `unexpected response: ${JSON.stringify(response)}`);
  assert.strictEqual(response.error, null);
  assert.ok(registeredIds.has('flow-helper'), 'the hook should be registered again');
  assert.strictEqual(store.enabled, true);
});

test('background: the hook is injected in MAIN world at document_start', async () => {
  const { handlers, getDescriptor } = await bootBackground();
  for (const fn of handlers.installed) await fn({ reason: 'install' });
  await flush(6);
  const descriptor = getDescriptor();
  assert.strictEqual(descriptor.world, 'MAIN');
  assert.strictEqual(descriptor.runAt, 'document_start');
  assert.strictEqual(descriptor.id, 'flow-helper');
  assert.deepStrictEqual(Array.from(descriptor.matches), ['https://flow.google.com/*']);
  assert.deepStrictEqual(Array.from(descriptor.js), ['hook.js']);
});

test('background: ignores foreign senders and unknown message types', async () => {
  const { handlers, registeredIds } = await bootBackground({ registered: true });
  let called = false;
  for (const fn of handlers.message) {
    await fn({ type: 'setEnabled', enabled: false }, { id: 'OTHER' }, () => { called = true; });
    await fn({ type: 'setEnabled', enabled: false }, { id: 'EXTID', tab: { id: 1 } }, () => { called = true; });
    await fn({ type: 'status' }, { id: 'EXTID' }, () => { called = true; });
  }
  await flush(2);
  assert.strictEqual(called, false);
  assert.ok(registeredIds.has('flow-helper'), 'the registration must be untouched');
});

test('background: reconcile() repairs a desynced registration', async () => {
  const { registeredIds } = await bootBackground({ registered: true, storage: { enabled: false } });
  await flush(6);
  assert.ok(!registeredIds.has('flow-helper'), 'a stale registration should be removed');
});

test('background: registration failures are reported, not swallowed', async () => {
  const { chrome, handlers, store } = await bootBackground({ registered: false, storage: { enabled: false } });
  chrome.scripting.registerContentScripts = async () => { throw Error('permission denied'); };

  let response;
  for (const fn of handlers.message) {
    await fn({ type: 'setEnabled', enabled: true }, { id: 'EXTID' }, (r) => { response = r; });
  }
  await flush(4);
  assert.strictEqual(response.ok, false);
  assert.match(response.error, /permission denied/);
  assert.match(String(store.lastError), /permission denied/, 'the error should be stored for the popup');
});

test('background: an update refreshes the registration descriptor', async () => {
  const { calls, handlers, getDescriptor } = await bootBackground({ registered: true, storage: { enabled: true } });
  for (const fn of handlers.installed) await fn({ reason: 'update' });
  await flush(8);
  assert.ok(
    calls.some(([name]) => name === 'scripting.registerContentScripts'),
    'the hook should be re-registered on update'
  );
  assert.strictEqual(getDescriptor().js[0], 'hook.js');
});

/* ----------------------------------------------------------------- 7. popup */
const POPUP_I18N = [
  'popupTitle', 'statusChecking', 'buttonOpen', 'buttonRefresh',
];

async function bootPopup(options = {}) {
  const document = createDocument(POPUP_I18N);
  const win = createWindow();
  const { chrome, calls } = createChrome(options);
  runScript('popup.js', { document, window: win, chrome });
  await flush(12);
  return { document, win, chrome, calls };
}

test('popup: localizes the markup from _locales/en', async () => {
  const { document } = await bootPopup({ registered: true, tab: { id: 7, url: FLOW } });
  assert.strictEqual(document.title, MESSAGES.popupTitle.message);
  const nodes = document.querySelectorAll('[data-i18n]');
  assert.ok(nodes.length >= POPUP_I18N.length, 'not enough i18n nodes');
  for (const node of nodes) {
    assert.strictEqual(node.textContent, MESSAGES[node.dataset.i18n].message, `key ${node.dataset.i18n}`);
  }
});

test('popup: shows the state reported by the tab', async () => {
  const cases = [
    [{ applied: 3, state: 'applied' }, MESSAGES.statusApplied.message],
    [{ applied: 1, state: 'already-enabled' }, MESSAGES.statusAlreadyEnabled.message],
    [{ applied: 0, state: 'armed' }, MESSAGES.statusArmed.message],
    [{ applied: 0, state: 'no-config-entry' }, MESSAGES.statusNoConfigEntry.message],
    [{ applied: 0, state: 'schema-mismatch' }, MESSAGES.statusSchemaMismatch.message],
    [{ applied: 0, state: 'frame-length-mismatch' }, MESSAGES.statusFrameMismatch.message],
    [{ applied: 0, state: 'not-loaded' }, MESSAGES.statusNotLoaded.message],
  ];
  for (const [statusResponse, expected] of cases) {
    const { document } = await bootPopup({ registered: true, tab: { id: 7, url: FLOW }, statusResponse });
    assert.strictEqual(
      document.getElementById('status').textContent,
      expected,
      `state ${statusResponse.state}`
    );
  }
});

test('popup: a tab without the content script says so instead of failing', async () => {
  const { document } = await bootPopup({ registered: true, tab: { id: 7, url: FLOW } });
  assert.strictEqual(document.getElementById('status').textContent, MESSAGES.statusNotLoaded.message);
});

test('popup: hides Refresh outside Flow and reports a disabled helper', async () => {
  const { document } = await bootPopup({ registered: false, tab: { id: 3, url: 'https://example.com/' } });
  assert.strictEqual(document.getElementById('refresh').hidden, true);
  assert.strictEqual(document.getElementById('status').textContent, MESSAGES.statusDisabled.message);
  assert.strictEqual(document.getElementById('enabled').checked, false);
  assert.strictEqual(document.getElementById('enabled').disabled, false, 'the switch must end up usable');
});

test('popup: the switch sends setEnabled and confirms', async () => {
  const { document, calls } = await bootPopup({ registered: false, tab: { id: 7, url: FLOW } });
  const toggle = document.getElementById('enabled');
  toggle.checked = true;
  await toggle.fire('change');
  await flush(8);

  assert.ok(
    calls.some(
      ([name, message]) =>
        name === 'runtime.sendMessage' && message.type === 'setEnabled' && message.enabled === true
    ),
    'setEnabled was not sent'
  );
  assert.strictEqual(document.getElementById('status').textContent, MESSAGES.statusSaved.message);
  assert.strictEqual(document.getElementById('error').textContent, '');
});

test('popup: a failed save reverts the switch and shows the reason', async () => {
  const { document, chrome } = await bootPopup({ registered: true, tab: { id: 7, url: FLOW } });
  chrome.__runtimeResponse = { ok: false, error: 'permission denied' };
  const toggle = document.getElementById('enabled');
  toggle.checked = false;
  await toggle.fire('change');
  await flush(8);
  assert.strictEqual(toggle.checked, true, 'the switch should snap back');
  assert.strictEqual(document.getElementById('error').textContent, 'permission denied');
});

test('popup: surfaces an error stored by the background', async () => {
  const { document } = await bootPopup({
    registered: true,
    tab: { id: 7, url: FLOW },
    storage: { enabled: true, lastError: 'Flow Helper setup failed: nope' },
  });
  assert.strictEqual(document.getElementById('error').textContent, 'Flow Helper setup failed: nope');
});

test('popup: Refresh strips /unsupported-country, otherwise reloads', async () => {
  const blocked = await bootPopup({ registered: true, tab: { id: 7, url: FLOW + 'unsupported-country' } });
  await blocked.document.getElementById('refresh').fire('click');
  await flush(8);
  const update = blocked.calls.find(([name]) => name === 'tabs.update');
  assert.ok(update, 'expected tabs.update');
  assert.strictEqual(update[2].url, FLOW);
  assert.strictEqual(blocked.win.closed, true, 'the popup should close itself');

  const normal = await bootPopup({ registered: true, tab: { id: 7, url: FLOW } });
  await normal.document.getElementById('refresh').fire('click');
  await flush(8);
  assert.ok(normal.calls.some(([name]) => name === 'tabs.reload'), 'expected tabs.reload');
  assert.strictEqual(normal.win.closed, true);
});

test('popup: Refresh on a non-Flow tab explains itself', async () => {
  const { document, win, calls } = await bootPopup({
    registered: true,
    tab: { id: 2, url: 'https://example.com/x' },
  });
  document.getElementById('refresh').hidden = false;
  await document.getElementById('refresh').fire('click');
  await flush(8);
  assert.strictEqual(document.getElementById('error').textContent, MESSAGES.errorPickFlowTab.message);
  assert.strictEqual(win.closed, false);
  assert.ok(!calls.some(([name]) => name === 'tabs.reload'));
});

test('popup: Enter Flow opens a new Flow tab', async () => {
  const { document, calls } = await bootPopup({ registered: true, tab: { id: 7, url: FLOW } });
  await document.getElementById('open').fire('click');
  await flush(4);
  const create = calls.find(([name]) => name === 'tabs.create');
  assert.ok(create, 'expected tabs.create');
  assert.strictEqual(create[1].url, FLOW);
});

/* -------------------------------------------------------------- 8. manifest */
test('manifest: declares everything the code uses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.manifest_version, 3);
  assert.deepStrictEqual(manifest.permissions.slice().sort(), ['scripting', 'storage']);
  assert.strictEqual(manifest.default_locale, 'en');
  for (const size of ['16', '32', '48', '128']) {
    assert.ok(fs.existsSync(path.join(ROOT, manifest.icons[size])), `missing icon ${size}`);
  }
  for (const file of ['hook.js', 'status.js', 'background.js', 'popup.js', 'popup.html', 'popup.css']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);
  }
  const contentScript = manifest.content_scripts[0];
  assert.deepStrictEqual(contentScript.js, ['status.js']);
  assert.deepStrictEqual(contentScript.matches, ['https://flow.google.com/*']);
  assert.strictEqual(manifest.name, '__MSG_extName__');
});

/* ------------------------------------------------------------------- runner */
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed++;
      console.log(`  ✗ ${name}\n      ${String(error.message).split('\n').join('\n      ')}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
