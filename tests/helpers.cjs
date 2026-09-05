const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((script) => script.includes('function buildEvents('));
const storageKey = 'holiday-plus-weeks-closed-dates-v1';
const memosKey = 'holiday-plus-weeks-memos-v1';
const allVisible = { showHoliday: true, showClosure: true, showPlus4: true, showPlus8: true };

function makeEventTarget(properties = {}) {
  const listeners = new Map();
  return {
    ...properties,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    dispatch(type, details = {}) {
      const event = {
        type,
        target: this,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        ...details,
      };
      for (const callback of listeners.get(type) || []) callback(event);
      return event;
    },
  };
}

function makeApp({ stored, storedMemos, readError = false, memoReadError = false } = {}) {
  const nodes = new Map();
  let focusedNode;
  function createNode() {
    const attributes = new Map();
    return makeEventTarget({
      checked: true,
      value: '',
      textContent: '',
      hidden: false,
      disabled: false,
      open: false,
      showModalCalls: 0,
      children: [],
      dataset: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      focus() { focusedNode = this; },
      showModal() { this.open = true; this.showModalCalls += 1; },
      close() { this.open = false; this.dispatch('close'); },
      appendChild(child) { this.children.push(child); return child; },
      reportValidity() { return true; },
      checkValidity() { return true; },
      querySelector: node,
    });
  }
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, createNode());
    return nodes.get(selector);
  }

  const values = new Map([
    [storageKey, stored === undefined ? null : stored],
    [memosKey, storedMemos === undefined ? null : storedMemos],
  ]);
  const storage = {
    values,
    failWrites: false,
    failWriteKeys: new Set(),
    failReadKeys: new Set([
      ...(readError ? [storageKey] : []),
      ...(memoReadError ? [memosKey] : []),
    ]),
    writes: 0,
    get value() { return values.get(storageKey); },
    set value(value) { values.set(storageKey, value); },
    get memoValue() { return values.get(memosKey); },
    getItem(key) {
      assert.ok(values.has(key), `Unexpected storage key: ${key}`);
      if (this.failReadKeys.has(key)) throw new Error('Storage access denied');
      return values.get(key);
    },
    setItem(key, value) {
      assert.ok(values.has(key), `Unexpected storage key: ${key}`);
      this.writes += 1;
      if (this.failWrites || this.failWriteKeys.has(key)) throw new Error('Storage quota exceeded');
      values.set(key, value);
    },
  };

  let calendar;
  class Calendar {
    constructor(element, options) {
      this.options = options;
      this.sources = [];
      calendar = this;
    }
    render() {}
    destroy() {}
    removeAllEvents() { this.sources.forEach((source) => { source.events = []; }); }
    getEventSources() { return [...this.sources]; }
    addEventSource(events) {
      const source = {
        events,
        remove: () => { this.sources = this.sources.filter((item) => item !== source); },
      };
      this.sources.push(source);
      return source;
    }
    addEvent() {}
    batchRendering(callback) { callback(); }
    setOption() {}
    gotoDate() {}
    getDate() { return new Date('2026-09-05T12:00:00+09:00'); }
  }
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-09-05T12:00:00+09:00']));
    }
  }

  const alerts = [];
  const window = makeEventTarget({ localStorage: storage, location: { href: '' } });
  const context = vm.createContext({
    Date: FixedDate,
    console,
    document: {
      querySelector: node,
      getElementById: (id) => node(`#${id}`),
      createElement: createNode,
      addEventListener() {},
    },
    window,
    navigator: {},
    localStorage: storage,
    FullCalendar: { Calendar },
    // Leave API loading unresolved so these tests are independent of the network.
    fetch: () => new Promise(() => {}),
    alert: (message) => alerts.push(message),
    confirm: () => true,
  });
  assert.ok(appScript, 'Expected the inline calendar application script');
  vm.runInContext(appScript, context, { filename: 'index.html' });
  return {
    storage,
    alerts,
    node,
    calendar,
    window,
    focusedNode: () => focusedNode,
    events: (holidays, options = allVisible, closedDates = []) =>
      context.buildEvents(holidays, options, closedDates),
    renderedEvents: () => calendar.sources.flatMap((source) => [...source.events]),
    refresh: () => context.refreshEvents(),
    reload: (fetch) => {
      context.fetch = fetch;
      return context.reloadHolidays();
    },
    save: (date, isClosed) => context.saveClosure(date, isClosed),
    dates: () => Array.from(vm.runInContext('closureDates', context)).sort(),
    canSave: () => vm.runInContext('storageAvailable', context),
    saveMemo: (date, text) => context.saveMemo(date, text),
    memos: () => JSON.parse(vm.runInContext('JSON.stringify(memos)', context)),
    canSaveMemos: () => vm.runInContext('memoStorageAvailable', context),
    openMemo: (date) => context.openMemo(date),
    closeMemo: () => context.closeMemo(),
    dateClick: (date, timeStamp) => calendar.options.dateClick({
      dateStr: date,
      jsEvent: { timeStamp },
    }),
    obsidianUri: (date, text) => context.buildObsidianExportUri(date, text),
    exportMemo: (date, text) => context.exportMemoToObsidian(date, text),
  };
}

module.exports = { makeApp, allVisible, storageKey, memosKey, html };
