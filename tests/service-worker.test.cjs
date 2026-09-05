const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

class FakeResponse {
  constructor(body, { ok = true } = {}) {
    this.body = body;
    this.ok = ok;
  }
  clone() { return new FakeResponse(this.body, { ok: this.ok }); }
  static error() { return new FakeResponse('error', { ok: false }); }
}

function makeWorker(fetchImpl) {
  const listeners = new Map();
  const stores = new Map();
  const keyFor = (request) => typeof request === 'string' ? request : request.url;
  const caches = {
    async open(name) {
      if (!stores.has(name)) {
        const values = new Map();
        stores.set(name, {
          values,
          async addAll() {},
          async match(request) { return values.get(keyFor(request)); },
          async put(request, response) { values.set(keyFor(request), response); },
        });
      }
      return stores.get(name);
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const self = {
    location: { origin: 'https://example.test' },
    clients: { claim() {} },
    skipWaiting() {},
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  const context = vm.createContext({
    caches,
    fetch: fetchImpl,
    Response: FakeResponse,
    URL,
    self,
  });
  vm.runInContext(source, context, { filename: 'sw.js' });

  async function request(request) {
    let promise;
    listeners.get('fetch')({
      request,
      respondWith(value) { promise = value; },
    });
    return await promise;
  }

  return { caches, request };
}

test('page navigation checks the network and refreshes the offline home page', async () => {
  const calls = [];
  const worker = makeWorker(async (request, options) => {
    calls.push({ request, options });
    return new FakeResponse('latest page');
  });
  const request = {
    method: 'GET',
    mode: 'navigate',
    url: 'https://example.test/app/',
  };
  const response = await worker.request(request);
  assert.equal(response.body, 'latest page');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cache, 'no-store');
  const cache = await worker.caches.open('holiday-plus-weeks-v7');
  assert.equal((await cache.match('./')).body, 'latest page');
});

test('page navigation uses the cached home page while offline', async () => {
  const worker = makeWorker(async () => { throw new Error('offline'); });
  const cache = await worker.caches.open('holiday-plus-weeks-v7');
  await cache.put('./', new FakeResponse('offline page'));
  const response = await worker.request({
    method: 'GET',
    mode: 'navigate',
    url: 'https://example.test/app/?from=home-screen',
  });
  assert.equal(response.body, 'offline page');
});

test('non-navigation app assets remain cache-first', async () => {
  let fetches = 0;
  const worker = makeWorker(async () => {
    fetches += 1;
    return new FakeResponse('network asset');
  });
  const request = {
    method: 'GET',
    mode: 'cors',
    url: 'https://example.test/app/manifest.webmanifest',
  };
  const cache = await worker.caches.open('holiday-plus-weeks-v7');
  await cache.put(request, new FakeResponse('cached asset'));
  const response = await worker.request(request);
  assert.equal(response.body, 'cached asset');
  assert.equal(fetches, 0);
});
