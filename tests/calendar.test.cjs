const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((script) => script.includes('function buildEvents('));
const storageKey = 'holiday-plus-weeks-closed-dates-v1';
const allVisible = { showHoliday: true, showClosure: true, showPlus4: true, showPlus8: true };

function makeApp({ stored, readError = false } = {}) {
  const nodes = new Map();
  function node(selector) {
    if (!nodes.has(selector)) {
      nodes.set(selector, {
        checked: true,
        value: '',
        textContent: '',
        hidden: false,
        disabled: false,
        dataset: {},
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        setAttribute() {},
        removeAttribute() {},
        focus() {},
        reportValidity() { return true; },
        checkValidity() { return true; },
        querySelector: node,
      });
    }
    return nodes.get(selector);
  }

  const storage = {
    value: stored === undefined ? null : stored,
    failWrites: false,
    writes: 0,
    getItem(key) {
      assert.equal(key, storageKey);
      if (readError) throw new Error('Storage access denied');
      return this.value;
    },
    setItem(key, value) {
      assert.equal(key, storageKey);
      this.writes += 1;
      if (this.failWrites) throw new Error('Storage quota exceeded');
      this.value = value;
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
  const context = vm.createContext({
    Date: FixedDate,
    console,
    document: {
      querySelector: node,
      getElementById: (id) => node(`#${id}`),
      addEventListener() {},
    },
    window: { addEventListener() {}, localStorage: storage },
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
  };
}

function eventsFor(events, base, kind) {
  return events.filter((event) => event.extendedProps?.base === base
    && (!kind || event.extendedProps.kind === kind));
}

function onlyEvent(events, base, kind) {
  const found = eventsFor(events, base, kind);
  assert.equal(found.length, 1, `Expected one ${kind} event for ${base}`);
  assert.equal(found[0].allDay, true);
  return found[0];
}

test('custom closures generate their own labels and exact 4/8 week offsets', () => {
  const app = makeApp();
  const events = app.events({}, allVisible, new Set(['2026-07-17']));
  assert.equal(onlyEvent(events, '2026-07-17', 'closure').start, '2026-07-17');
  assert.equal(onlyEvent(events, '2026-07-17', 'closure_label').start, '2026-07-17');
  assert.equal(onlyEvent(events, '2026-07-17', 'plus4').start, '2026-08-14');
  assert.equal(onlyEvent(events, '2026-07-17', 'plus8').start, '2026-09-11');
});

test('offset dates cross year and leap-day boundaries correctly', () => {
  const app = makeApp();
  const events = app.events({}, allVisible, ['2026-12-20', '2028-02-01']);
  assert.equal(onlyEvent(events, '2026-12-20', 'plus4').start, '2027-01-17');
  assert.equal(onlyEvent(events, '2026-12-20', 'plus8').start, '2027-02-14');
  assert.equal(onlyEvent(events, '2028-02-01', 'plus4').start, '2028-02-29');
  assert.equal(onlyEvent(events, '2028-02-01', 'plus8').start, '2028-03-28');
});

test('custom closures outside the holiday display range retain their offsets', () => {
  const events = makeApp().events({}, allVisible, ['2035-06-06']);
  assert.equal(onlyEvent(events, '2035-06-06', 'closure_label').start, '2035-06-06');
  assert.equal(onlyEvent(events, '2035-06-06', 'plus4').start, '2035-07-04');
  assert.equal(onlyEvent(events, '2035-06-06', 'plus8').start, '2035-08-01');
});

test('overlapping holiday and closure generate only one offset of each kind', () => {
  const app = makeApp();
  const holidays = { '2026-07-20': '海の日' };
  const events = app.events(holidays, allVisible, ['2026-07-20', '2026-07-20']);
  onlyEvent(events, '2026-07-20', 'holiday_label');
  onlyEvent(events, '2026-07-20', 'closure_label');
  onlyEvent(events, '2026-07-20', 'plus4');
  onlyEvent(events, '2026-07-20', 'plus8');

  const afterRemoval = app.events(holidays, allVisible, []);
  onlyEvent(afterRemoval, '2026-07-20', 'holiday_label');
  onlyEvent(afterRemoval, '2026-07-20', 'plus4');
  onlyEvent(afterRemoval, '2026-07-20', 'plus8');
  assert.equal(eventsFor(afterRemoval, '2026-07-20', 'closure_label').length, 0);
});

test('base visibility switches do not suppress enabled offsets', () => {
  const events = makeApp().events({ '2026-07-20': '海の日' }, {
    ...allVisible, showHoliday: false, showClosure: false,
  }, ['2026-07-17']);
  assert.ok(events.every((event) => ['plus4', 'plus8'].includes(event.extendedProps.kind)));
  for (const base of ['2026-07-17', '2026-07-20']) {
    onlyEvent(events, base, 'plus4');
    onlyEvent(events, base, 'plus8');
  }
});

test('holiday and closure labels can be shown independently on overlapping dates', () => {
  const app = makeApp();
  for (const showClosure of [true, false]) {
    const events = app.events({ '2026-07-20': '海の日' }, {
      ...allVisible, showClosure, showHoliday: !showClosure,
    }, ['2026-07-20']);
    onlyEvent(events, '2026-07-20', showClosure ? 'closure_label' : 'holiday_label');
    assert.equal(eventsFor(events, '2026-07-20', showClosure ? 'holiday_label' : 'closure_label').length, 0);
    onlyEvent(events, '2026-07-20', 'plus4');
    onlyEvent(events, '2026-07-20', 'plus8');
  }
});

test('offset visibility switches are independent of closure visibility and each other', () => {
  const app = makeApp();
  for (const disabledKind of ['plus4', 'plus8']) {
    const events = app.events({}, {
      ...allVisible,
      [disabledKind === 'plus4' ? 'showPlus4' : 'showPlus8']: false,
    }, ['2026-07-17']);
    onlyEvent(events, '2026-07-17', 'closure_label');
    onlyEvent(events, '2026-07-17', disabledKind === 'plus4' ? 'plus8' : 'plus4');
    assert.ok(events.every((event) => event.extendedProps.kind !== disabledKind));
  }
});

test('year-end holidays remain present without modifying the supplied holiday map', () => {
  const holidays = { '2027-01-01': '元日' };
  const events = makeApp().events(holidays);
  assert.deepEqual(holidays, { '2027-01-01': '元日' });
  for (const base of ['2026-12-28', '2026-12-31', '2027-01-01', '2027-01-03']) {
    onlyEvent(events, base, 'holiday_label');
    onlyEvent(events, base, 'plus4');
    onlyEvent(events, base, 'plus8');
  }
  assert.match(onlyEvent(events, '2027-01-01', 'holiday_label').title, /元日/);
});

test('adding and removing closures persists across app reloads', () => {
  const app = makeApp();
  app.save('2026-07-17', true);
  app.save('2035-06-06', true);
  app.save('2026-07-17', true);
  assert.deepEqual(app.dates(), ['2026-07-17', '2035-06-06']);
  const reloaded = makeApp({ stored: app.storage.value });
  assert.deepEqual(reloaded.dates(), app.dates());
  reloaded.save('2026-07-17', false);
  assert.deepEqual(reloaded.dates(), ['2035-06-06']);
  assert.deepEqual(makeApp({ stored: reloaded.storage.value }).dates(), ['2035-06-06']);
});

test('failed writes leave the currently saved closure set unchanged', () => {
  const original = JSON.stringify(['2026-07-17']);
  const app = makeApp({ stored: original });
  app.storage.failWrites = true;
  app.save('2026-07-18', true);
  assert.deepEqual(app.dates(), ['2026-07-17']);
  assert.equal(app.storage.value, original);
  app.save('2026-07-17', false);
  assert.deepEqual(app.dates(), ['2026-07-17']);
  assert.equal(app.storage.value, original);
});

test('invalid date input cannot create or overwrite saved closures', () => {
  const original = JSON.stringify(['2026-07-17']);
  const app = makeApp({ stored: original });
  for (const date of ['', '2026-02-30', '2026-13-01', '2026-7-17', 'not-a-date']) {
    assert.equal(app.save(date, true), false);
  }
  assert.deepEqual(app.dates(), ['2026-07-17']);
  assert.equal(app.storage.value, original);
  assert.equal(app.storage.writes, 0);
});

test('corrupt stored data cannot be overwritten by adding a new closure', () => {
  for (const stored of ['{broken JSON', '{"date":"2026-07-17"}', '["2026-02-30"]']) {
    const app = makeApp({ stored });
    assert.equal(app.canSave(), false);
    app.save('2026-07-18', true);
    assert.equal(app.storage.value, stored);
    assert.equal(app.storage.writes, 0);
    assert.deepEqual(app.dates(), []);
  }
});

test('inaccessible storage prevents closure changes', () => {
  const app = makeApp({ readError: true });
  assert.equal(app.canSave(), false);
  app.save('2026-07-18', true);
  assert.equal(app.storage.writes, 0);
  assert.deepEqual(app.dates(), []);
});

test('repeated closure changes and display refreshes keep one current event source', () => {
  const app = makeApp();
  for (let index = 0; index < 5; index += 1) {
    app.save('2026-07-17', true);
    app.refresh();
    assert.equal(app.calendar.getEventSources().length, 1);
    onlyEvent(app.renderedEvents(), '2026-07-17', 'closure_label');
    onlyEvent(app.renderedEvents(), '2026-07-17', 'plus4');
    app.save('2026-07-17', false);
    assert.equal(app.calendar.getEventSources().length, 1);
    assert.equal(eventsFor(app.renderedEvents(), '2026-07-17').length, 0);
  }
});

test('successful holiday loading combines API holidays with saved closures', async () => {
  const app = makeApp({ stored: '["2026-07-17"]' });
  onlyEvent(app.renderedEvents(), '2026-07-17', 'closure_label');
  await app.reload(async () => ({
    ok: true,
    json: async () => ({ '2026-07-20': '海の日' }),
  }));
  onlyEvent(app.renderedEvents(), '2026-07-17', 'closure_label');
  onlyEvent(app.renderedEvents(), '2026-07-20', 'holiday_label');
  onlyEvent(app.renderedEvents(), '2026-07-20', 'plus8');
  assert.equal(app.calendar.getEventSources().length, 1);
  assert.equal(app.node('#holidayStatus').textContent, '');
  assert.equal(app.node('#reload').disabled, false);
});

test('holiday API failure leaves custom closures usable and preserves previous holidays', async () => {
  const app = makeApp({ stored: '["2026-07-17"]' });
  const failFetch = async () => { throw new Error('Offline'); };
  await app.reload(failFetch);
  onlyEvent(app.renderedEvents(), '2026-07-17', 'closure_label');
  assert.ok(app.node('#holidayStatus').textContent.length > 0);
  assert.equal(app.node('#reload').disabled, false);
  assert.equal(app.save('2026-07-18', true), true);
  onlyEvent(app.renderedEvents(), '2026-07-18', 'plus4');

  await app.reload(async () => ({
    ok: true,
    json: async () => ({ '2026-07-20': '海の日' }),
  }));
  await app.reload(failFetch);
  onlyEvent(app.renderedEvents(), '2026-07-20', 'holiday_label');
  onlyEvent(app.renderedEvents(), '2026-07-17', 'closure_label');
  onlyEvent(app.renderedEvents(), '2026-07-18', 'closure_label');
  assert.equal(app.calendar.getEventSources().length, 1);
});
