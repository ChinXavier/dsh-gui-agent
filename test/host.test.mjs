import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';
import { COMPUTER_TOOL_NAMES } from '../lib/tools.js';

const toolNames = [...COMPUTER_TOOL_NAMES];

function makeCtx({ connection = makeConnection(), storeDir } = {}) {
  const tools = new Map();
  const sections = [];
  const routes = new Map();
  const effects = [];
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            tools.set(definition.name, definition);
            return () => tools.delete(definition.name);
          },
        };
      }
      if (name === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section.name);
            return () => {
              const index = sections.indexOf(section.name);
              if (index >= 0) sections.splice(index, 1);
            };
          },
        };
      }
      if (name === 'webServer') {
        return {
          register({ path: routePath, handler }) {
            routes.set(routePath, handler);
            return () => routes.delete(routePath);
          },
        };
      }
      if (name === 'connection') return connection;
      if (name === 'attachments') {
        return { saveImage: async () => ({ attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }) };
      }
      return undefined;
    },
    effect(callback) {
      const disposable = callback();
      effects.push(disposable);
      return () => {};
    },
  };
  // Services are resolved asynchronously in the real runtime; the fake simply
  // hands the same context to the injected callback once its deps "exist".
  ctx.inject = (_dependencies, callback) => callback(ctx);
  return { ctx, tools, sections, routes, effects, storeDir };
}

function makeConnection(rejection = () => undefined) {
  return {
    requestRejection({ headers }) {
      if (typeof rejection === 'function') return rejection(headers);
      return rejection;
    },
  };
}

async function callRoute(handler, { method = 'GET', url = '/gui-agent/state', headers = { authorization: 'yes' }, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.destroy = () => {};
  const res = {
    status: 0,
    payload: undefined,
    writeHead(status) {
      this.status = status;
    },
    end(data) {
      try {
        this.payload = JSON.parse(String(data));
      } catch {
        this.payload = String(data);
      }
    },
  };
  const promise = handler(req, res);
  if (body !== undefined) {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  }
  await promise;
  return res;
}

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gui-agent-host-'));

// 1. routes register, no tools at boot
{
  const first = makeCtx({ storeDir: path.join(tmpRoot, 'a') });
  apply(first.ctx, { storeDir: first.storeDir });
  assert.equal(first.routes.size, 3, 'three routes registered');
  assert.equal(first.tools.size, 0, 'no tools before enabling');
  assert.equal(first.sections.length, 0, 'no prompt section before enabling');
}

// 2. unauthenticated state is rejected
{
  const { ctx, routes, storeDir } = makeCtx({ storeDir: path.join(tmpRoot, 'a2'), connection: makeConnection(() => 401) });
  apply(ctx, { storeDir });
  const unauthenticated = await callRoute(routes.get('/gui-agent/state'), { headers: {} });
  assert.equal(unauthenticated.status, 401, 'unauthenticated state rejected');
  assert.equal(unauthenticated.payload.error, 'unauthorized');
}

// 3. enable a session -> 9 tools + prompt section
const storeDir = path.join(tmpRoot, 'b');
const main = makeCtx({ storeDir });
apply(main.ctx, { storeDir });
await new Promise((resolve) => setTimeout(resolve, 50));
const enabled = await callRoute(main.routes.get('/gui-agent/toggle'), {
  method: 'POST',
  body: JSON.stringify({ sessionId: 'sess-one', enabled: true }),
});
assert.equal(enabled.status, 200, 'enable returns 200');
assert.equal(enabled.payload.enabled, true, 'state reports enabled');
assert.deepEqual([...main.tools.keys()].sort(), [...toolNames].sort(), 'all computer tools registered');
assert.equal(main.sections.length, 1, 'prompt section registered');

// 4. per-session isolation
const otherState = await callRoute(main.routes.get('/gui-agent/state'), {
  url: '/gui-agent/state?sessionId=sess-two',
});
assert.equal(otherState.payload.enabled, false, 'other session stays off');

// 5. missing enabled flag
const badToggle = await callRoute(main.routes.get('/gui-agent/toggle'), {
  method: 'POST',
  body: JSON.stringify({ sessionId: 'sess-one' }),
});
assert.equal(badToggle.status, 400, 'missing enabled is a bad request');

// 6. disable -> tools unregistered
const disabled = await callRoute(main.routes.get('/gui-agent/toggle'), {
  method: 'POST',
  body: JSON.stringify({ sessionId: 'sess-one', enabled: false }),
});
assert.equal(disabled.payload.enabled, false, 'disable reports off');
assert.equal(main.tools.size, 0, 'tools unregistered after disable');
assert.equal(main.sections.length, 0, 'prompt section removed after disable');

// 7. no connection service -> 403
{
  const noConnection = makeCtx({ storeDir: path.join(tmpRoot, 'c'), connection: null });
  apply(noConnection.ctx, { storeDir: noConnection.storeDir });
  const result = await callRoute(noConnection.routes.get('/gui-agent/state'), { headers: {} });
  assert.equal(result.status, 403, 'no connection service yields 403');
}

// 7b. pace route: default human, switch to fast, reject bad values, persist
{
  await callRoute(main.routes.get('/gui-agent/toggle'), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-pace', enabled: true }),
  });
  const initial = await callRoute(main.routes.get('/gui-agent/state'), { url: '/gui-agent/state?sessionId=sess-pace' });
  assert.equal(initial.payload.pace, 'human', 'pace defaults to human');

  const bad = await callRoute(main.routes.get('/gui-agent/pace'), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-pace', pace: 'warp' }),
  });
  assert.equal(bad.status, 400, 'unknown pace rejected');
  assert.match(bad.payload.error, /human.*fast/, 'pace error explains allowed values');

  const fast = await callRoute(main.routes.get('/gui-agent/pace'), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-pace', pace: 'fast' }),
  });
  assert.equal(fast.status, 200, 'pace switch accepted');
  assert.equal(fast.payload.pace, 'fast', 'state reports fast pace');
  const afterSwitch = await callRoute(main.routes.get('/gui-agent/state'), { url: '/gui-agent/state?sessionId=sess-pace' });
  assert.equal(afterSwitch.payload.pace, 'fast', 'pace persists in session state');

  const custom = await callRoute(main.routes.get('/gui-agent/pace'), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-pace', pace: 'custom', slowdown: 2.5 }),
  });
  assert.equal(custom.status, 200, 'custom pace accepted');
  assert.equal(custom.payload.pace, 'custom', 'state reports custom pace');
  assert.equal(custom.payload.slowdown, 2.5, 'slowdown persisted');
  const badSlowdown = await callRoute(main.routes.get('/gui-agent/pace'), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-pace', pace: 'custom', slowdown: 9 }),
  });
  assert.equal(badSlowdown.status, 400, 'out-of-range slowdown rejected');

  const getMethod = await callRoute(main.routes.get('/gui-agent/pace'));
  assert.equal(getMethod.status, 405, 'pace route is POST only');

  await callRoute(main.routes.get('/gui-agent/toggle'), {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-pace', enabled: false }),
  });
}

// 8. restore from persisted state
{
  const restoreDir = path.join(tmpRoot, 'd');
  await fsp.mkdir(restoreDir, { recursive: true });
  await fsp.writeFile(
    path.join(restoreDir, 'state.json'),
    JSON.stringify({
      version: 1,
      sessions: { 'sess-restored': Date.now() },
      accounts: { acc: { titleMatch: 'Grok', addedAt: Date.now() } },
      downloads: {},
      queue: [{ id: 'q1', prompt: 'p', status: 'pending', account: '', createdAt: Date.now(), updatedAt: Date.now() }],
    }),
    'utf8',
  );
  const restored = makeCtx({ storeDir: restoreDir });
  apply(restored.ctx, { storeDir: restoreDir });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(restored.tools.size, 9, 'restored session registers tools');
  const state = await callRoute(restored.routes.get('/gui-agent/state'), {
    url: '/gui-agent/state?sessionId=sess-restored',
  });
  assert.equal(state.payload.enabled, true, 'restored session is enabled');
  assert.equal(state.payload.accounts, 1, 'account restored');
  assert.equal(state.payload.queue, 1, 'queue restored');
}

await fsp.rm(tmpRoot, { recursive: true, force: true });
console.log('ALL HOST TESTS PASSED');

