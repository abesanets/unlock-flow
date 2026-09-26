/**
 * Tiny stub harness for running the extension scripts in Node.
 * No dependencies: a fake DOM, a fake `chrome`, an EventTarget-ish `window`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MESSAGES = JSON.parse(
  fs.readFileSync(path.join(ROOT, '_locales', 'en', 'messages.json'), 'utf8')
);

/* --------------------------------------------------------------- fake DOM */
function createElement(id) {
  return {
    id,
    textContent: '',
    hidden: false,
    checked: false,
    disabled: false,
    dataset: {},
    _listeners: {},
    addEventListener(event, fn) {
      (this._listeners[event] ||= []).push(fn);
    },
    async fire(event, ...args) {
      for (const fn of this._listeners[event] || []) await fn(...args);
    },
  };
}

function createDocument(i18nNodes = []) {
  const nodes = new Map();
  const extra = i18nNodes.map((key) => {
    const node = createElement(`i18n:${key}`);
    node.dataset.i18n = key;
    return node;
  });
  return {
    title: '',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, createElement(id));
      return nodes.get(id);
    },
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [...nodes.values(), ...extra].filter((n) => n.dataset.i18n);
      return [];
    },
    addEventListener() {},
    documentElement: createElement('html'),
    _nodes: nodes,
  };
}

/* ------------------------------------------------------------- fake window */
function createWindow({ origin = 'https://flow.google.com' } = {}) {
  const listeners = new Map();
  return {
    location: { origin, href: origin + '/' },
    __flowLocalDiagnostic: undefined,
    addEventListener(event, fn) {
      (listeners.get(event) || listeners.set(event, []).get(event)).push(fn);
    },
    removeEventListener(event, fn) {
      const list = listeners.get(event) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
      return true;
    },
    close() { this.closed = true; },
    closed: false,
  };
}

/* ------------------------------------------------------------- fake chrome */
function createChrome({ registered = false, storage = {}, tab, statusResponse, lastError } = {}) {
  const calls = [];
  const rec = (name, ...args) => calls.push([name, ...args]);
  const store = { ...storage };
  const registeredIds = new Set(registered ? ['flow-helper'] : []);
  const handlers = { message: [], installed: [], startup: [] };
  let scriptDescriptor = null;

  const chrome = {
    runtime: {
      id: 'EXTID',
      lastError: lastError ? { message: lastError } : undefined,
      onInstalled: { addListener: (fn) => handlers.installed.push(fn) },
      onStartup: { addListener: (fn) => handlers.startup.push(fn) },
      onMessage: { addListener: (fn) => handlers.message.push(fn) },
      sendMessage: async (message) => {
        rec('runtime.sendMessage', message);
        return chrome.__runtimeResponse ?? { ok: true };
      },
    },
    storage: {
      local: {
        async get(keys) {
          const wanted = keys == null ? Object.keys(store) : [].concat(keys);
          const out = {};
          for (const key of wanted) if (key in store) out[key] = store[key];
          rec('storage.get', wanted);
          return out;
        },
        async set(values) {
          Object.assign(store, values);
          rec('storage.set', values);
        },
      },
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) {
        const found = ids.filter((id) => registeredIds.has(id));
        rec('scripting.getRegisteredContentScripts', ids);
        return found.map((id) => ({ id }));
      },
      async registerContentScripts(scripts) {
        for (const script of scripts) registeredIds.add(script.id);
        scriptDescriptor = scripts[0];
        rec('scripting.registerContentScripts', scripts.map((s) => s.id));
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) registeredIds.delete(id);
        rec('scripting.unregisterContentScripts', ids);
      },
    },
    tabs: {
      async query(info) {
        rec('tabs.query', info);
        return tab ? [tab] : [];
      },
      async sendMessage(tabId, message) {
        rec('tabs.sendMessage', tabId, message);
        if (chrome.__sendMessageThrows) throw Error(chrome.__sendMessageThrows);
        return statusResponse;
      },
      async get(tabId) {
        rec('tabs.get', tabId);
        return tab;
      },
      async update(tabId, info) { rec('tabs.update', tabId, info); },
      async reload(tabId) { rec('tabs.reload', tabId); },
      async create(info) { rec('tabs.create', info); },
    },
    i18n: {
      getMessage(key) {
        rec('i18n.getMessage', key);
        return MESSAGES[key]?.message || '';
      },
    },
  };

  return { chrome, calls, handlers, store, registeredIds, getDescriptor: () => scriptDescriptor };
}

/* --------------------------------------------------------------- fake XHR */
function createXHR() {
  function XMLHttpRequest() {}
  Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
    configurable: true,
    get() { return this._body; },
  });
  Object.defineProperty(XMLHttpRequest.prototype, 'response', {
    configurable: true,
    get() { return this._body; },
  });
  XMLHttpRequest.prototype.open = function (method, url) { this._opened = url; };
  return XMLHttpRequest;
}

/** Runs a browser-style script in a sandbox; returns the sandbox and its context. */
function runScript(file, { origin, document, window: win, chrome, XMLHttpRequest, extra = {} } = {}) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const sandbox = {
    console: { info() {}, error() {}, log() {}, warn() {} },
    document,
    window: win,
    chrome,
    XMLHttpRequest,
    location: win?.location,
    window2: undefined,
    setTimeout, clearTimeout, Promise, JSON, URL, TextEncoder, TextDecoder,
    Reflect, WeakMap, Map, Set, Object, Array, String, Number, Boolean, Error, Date, Math,
    CustomEvent, Event, Response, Headers, Blob, FormData,
    ...extra,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: file });
  return { sandbox, ctx };
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

module.exports = {
  ROOT,
  MESSAGES,
  createDocument,
  createWindow,
  createChrome,
  createXHR,
  runScript,
  flush,
};
