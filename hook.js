/**
 * Unlock Flow — page hook (MAIN world content script).
 *
 * Runs inside the page on https://flow.google.com at document_start, before any
 * application code, and flips the "country / account supported" flag that Flow
 * receives from its `batchexecute` endpoint (RPC id `cPZSdc`).
 *
 * The response is a chunked stream where every chunk is prefixed by its length,
 * so the patched chunk is re-measured with the same unit the original length was
 * written in (bytes or UTF-16 code units) and the prefix is adjusted.
 *
 * The hook reports its state to the extension with `CustomEvent`s on `window`
 * (see STATE_EVENT / REQUEST_EVENT), which `status.js` listens to.
 */
(() => {
  'use strict';

  const FLOW_ORIGIN = 'https://flow.google.com';
  const CONFIG_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';
  const CONFIG_RPC_ID = 'cPZSdc';

  /** Last known position of the flag; used first, the search window is the fallback. */
  const CONFIG_FLAG_INDEX = 30;
  /** How far from CONFIG_FLAG_INDEX we look when the schema shifts. */
  const FLAG_SEARCH_WINDOW = 10;
  /** Allowed difference between the declared chunk length and the measured one. */
  const LENGTH_TOLERANCE = 2;

  const READY_STATE_LOADING = 3;
  const READY_STATE_DONE = 4;

  const STATE_EVENT = 'flow-local-diagnostic:state';
  const REQUEST_EVENT = 'flow-local-diagnostic:request';
  const LOG_PREFIX = '[Flow local diagnostic]';

  /** Machine readable states — the popup turns them into sentences. */
  const STATE = {
    armed: 'armed',
    applied: 'applied',
    alreadyEnabled: 'already-enabled',
    noConfigEntry: 'no-config-entry',
    schemaMismatch: 'schema-mismatch',
    frameMismatch: 'frame-length-mismatch',
  };

  /** Diagnostic state, shared with the extension and readable on `window`. */
  const diagnostic = {
    state: STATE.armed,
    applied: 0,
    patched: 0,
    requestsSeen: 0,
    heldPartial: false,
    before: undefined,
    detail: undefined,
  };

  const fail = (code, message) => Object.assign(Error(message), { code });
  const isFlagLike = (value) => value === null || typeof value === 'boolean';

  /**
   * Locates the availability flag inside the config payload.
   *
   * The field used to sit at index 30 and was the only boolean in the payload,
   * so we try that first and only then fall back to a search: booleans win over
   * nulls, and among equals the one closest to the known index wins.
   */
  function findFlagIndex(payload) {
    if (isFlagLike(payload[CONFIG_FLAG_INDEX])) return CONFIG_FLAG_INDEX;

    const from = Math.max(0, CONFIG_FLAG_INDEX - FLAG_SEARCH_WINDOW);
    const to = Math.min(payload.length - 1, CONFIG_FLAG_INDEX + FLAG_SEARCH_WINDOW);
    let booleans = [];
    let nulls = [];

    for (let index = from; index <= to; index++) {
      if (typeof payload[index] === 'boolean') booleans.push(index);
      else if (payload[index] === null) nulls.push(index);
    }

    const closest = (list) =>
      list.reduce(
        (best, index) =>
          Math.abs(index - CONFIG_FLAG_INDEX) < Math.abs(best - CONFIG_FLAG_INDEX) ? index : best,
        list[0],
      );

    if (booleans.length === 1) return booleans[0];
    if (booleans.length > 1) {
      const nearest = closest(booleans);
      // Several booleans, but one of them sits where the flag used to be: take it.
      if (booleans.includes(CONFIG_FLAG_INDEX)) return CONFIG_FLAG_INDEX;
      throw fail(
        STATE.schemaMismatch,
        `ambiguous flag field: booleans at ${booleans.join(',')} (nearest ${nearest})`,
      );
    }
    if (nulls.length) return closest(nulls);

    throw fail(STATE.schemaMismatch, 'no boolean or null flag field in the search window');
  }

  /** Picks the unit (bytes vs. UTF-16 code units) the declared length is written in. */
  function selectLengthUnit(declared, line) {
    const units = [(value) => new TextEncoder().encode(value).length, (value) => value.length];
    return units
      .map((fn) => ({ fn, delta: declared - fn(line) }))
      .filter((candidate) => Math.abs(candidate.delta) <= LENGTH_TOLERANCE)
      .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
  }

  /**
   * Rewrites the raw `batchexecute` response: sets the availability flag to
   * `true` in every config entry and fixes up the chunk length prefixes.
   *
   * @param {string} text raw response body
   * @returns {{ body: string, before: boolean|null|undefined, patched: number }}
   *          `patched === 0` means "no config entry found", the body is unchanged.
   * @throws {Error} with `code` = 'schema-mismatch' | 'frame-length-mismatch'
   */
  function patchConfigResponse(text) {
    const lines = text.split('\n');
    let before;
    let patched = 0;

    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('[[')) continue;

      let envelope;
      try {
        envelope = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (!Array.isArray(envelope)) continue;

      let changed = false;
      for (const entry of envelope) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || entry[1] !== CONFIG_RPC_ID) continue;
        if (typeof entry[2] !== 'string') {
          throw fail(STATE.schemaMismatch, 'config payload is not a string');
        }

        let payload;
        try {
          payload = JSON.parse(entry[2]);
        } catch {
          throw fail(STATE.schemaMismatch, 'config payload is not valid JSON');
        }
        if (!Array.isArray(payload) || payload.length <= CONFIG_FLAG_INDEX) {
          throw fail(
            STATE.schemaMismatch,
            `expected at least ${CONFIG_FLAG_INDEX + 1} fields, got ${
              Array.isArray(payload) ? payload.length : typeof payload
            }`,
          );
        }

        const flagIndex = findFlagIndex(payload);
        if (patched === 0) before = payload[flagIndex];
        payload[flagIndex] = true;
        patched++;
        entry[2] = JSON.stringify(payload);
        changed = true;
      }

      if (!changed) continue;

      const originalLine = lines[index].replace(/\r$/, '');
      const declared = Number(lines[index - 1]);
      if (!Number.isFinite(declared)) {
        throw fail(STATE.frameMismatch, `length prefix is not a number: ${lines[index - 1]}`);
      }

      const unit = selectLengthUnit(declared, originalLine);
      if (!unit) {
        throw fail(
          STATE.frameMismatch,
          `prefix ${declared} does not match the chunk (${originalLine.length} chars / ${
            new TextEncoder().encode(originalLine).length
          } bytes)`,
        );
      }

      const patchedLine = JSON.stringify(envelope);
      const newLength = unit.fn(patchedLine) + unit.delta;
      if (!Number.isFinite(newLength) || newLength < 0) {
        throw fail(STATE.frameMismatch, `cannot compute a new length prefix (${newLength})`);
      }

      lines[index - 1] = String(newLength);
      lines[index] = patchedLine;
    }

    // Nothing to patch is not an error: it is a response without a config entry.
    return { body: patched ? lines.join('\n') : text, before, patched };
  }

  // Node / unit-test entry point: `const { patch } = require('./hook.js')`.
  // Guarded by the absence of XHR so that a page defining `window.module`
  // can never stop the hook from installing.
  if (typeof module === 'object' && module.exports && typeof XMLHttpRequest === 'undefined') {
    module.exports = { patch: patchConfigResponse, findFlagIndex, selectLengthUnit, STATE };
    return;
  }

  if (location.origin !== FLOW_ORIGIN || window.__flowLocalDiagnostic) return;
  window.__flowLocalDiagnostic = diagnostic;

  /** Publishes the diagnostic state to `status.js` (and to the console). */
  function setStatus(state, extra = {}) {
    Object.assign(diagnostic, { state, detail: undefined }, extra);
    console.info(LOG_PREFIX, JSON.stringify(diagnostic));
    try {
      window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: JSON.stringify(diagnostic) }));
    } catch {}
  }

  // Answer state polls coming from the content script (it may have loaded later).
  window.addEventListener(REQUEST_EVENT, () => {
    try {
      window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: JSON.stringify(diagnostic) }));
    } catch {}
  });

  /** True for the request that carries the availability config. */
  function isConfigUrl(rawUrl) {
    try {
      const target = new URL(rawUrl, location.href);
      return (
        target.origin === location.origin &&
        target.pathname === CONFIG_PATH &&
        (target.searchParams.get('rpcids') || '').split(',').includes(CONFIG_RPC_ID)
      );
    } catch {
      return false;
    }
  }

  /** Applies the patch to a response body and updates the diagnostic state. */
  function applyPatch(body) {
    try {
      const result = patchConfigResponse(body);
      if (result.patched === 0) {
        setStatus(STATE.noConfigEntry);
        return body;
      }
      diagnostic.applied += result.patched;
      diagnostic.patched = result.patched;
      setStatus(result.before === true ? STATE.alreadyEnabled : STATE.applied, {
        before: result.before,
      });
      return result.body;
    } catch (error) {
      setStatus(error.code === STATE.frameMismatch ? STATE.frameMismatch : STATE.schemaMismatch, {
        detail: String(error.message).slice(0, 200),
      });
      return body; // never corrupt the response: pass it through untouched
    }
  }

  /* ------------------------------------------------------------- XMLHttpRequest */
  const isConfigRequest = new WeakMap(); // XMLHttpRequest -> boolean
  const patchedBodies = new WeakMap(); // XMLHttpRequest -> patched response body

  const xhrPrototype = XMLHttpRequest.prototype;
  const nativeOpen = xhrPrototype.open;

  xhrPrototype.open = function (method, url, ...rest) {
    const match = isConfigUrl(url);
    if (match) diagnostic.requestsSeen++;
    isConfigRequest.set(this, match);
    patchedBodies.delete(this);
    return Reflect.apply(nativeOpen, this, [method, url, ...rest]);
  };

  // Intercept both ways the app can read the response body.
  for (const property of ['responseText', 'response']) {
    const descriptor = Object.getOwnPropertyDescriptor(xhrPrototype, property);
    if (!descriptor?.get || !descriptor.configurable) continue;

    Object.defineProperty(xhrPrototype, property, {
      ...descriptor,
      get() {
        const value = Reflect.apply(descriptor.get, this, []);
        if (!isConfigRequest.get(this) || typeof value !== 'string') return value;

        // readyState 3 = a partial chunk is being streamed: hide it, the app would
        // otherwise parse a half-patched payload.
        if (this.readyState === READY_STATE_LOADING) {
          diagnostic.heldPartial = true;
          return '';
        }
        if (this.readyState !== READY_STATE_DONE) return value;

        if (!patchedBodies.has(this)) patchedBodies.set(this, applyPatch(value));
        return patchedBodies.get(this);
      },
    });
  }

  /* --------------------------------------------------------------------- fetch */
  // Flow may move away from XHR; if it does, the hook keeps working.
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function' && typeof Response === 'function') {
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      if (!isConfigUrl(url)) return Reflect.apply(nativeFetch, window, [input, init]);

      diagnostic.requestsSeen++;
      const response = await Reflect.apply(nativeFetch, window, [input, init]);
      try {
        const body = await response.clone().text();
        const patched = applyPatch(body);
        if (patched === body) return response;

        const headers = new Headers(response.headers);
        headers.delete('content-length'); // the body length changed
        headers.delete('content-encoding');
        return new Response(patched, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch {
        return response;
      }
    };
  }

  setStatus(STATE.armed);
})();
