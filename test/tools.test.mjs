import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createComputerTools, COMPUTER_TOOL_NAMES } from '../lib/tools.js';
import { StateStore } from '../lib/store.js';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gui-agent-tools-'));
const downloadsDir = path.join(tmpRoot, 'Downloads');
const collectionRoot = path.join(tmpRoot, 'Pictures');
await fsp.mkdir(downloadsDir, { recursive: true });
await fsp.mkdir(collectionRoot, { recursive: true });

const windows = [
  { handle: 11, title: 'Grok - acc-a profile', pid: 101, active: false, minimized: false, x: 0, y: 0, width: 800, height: 600 },
  { handle: 22, title: 'Gemini - acc-b profile', pid: 202, active: true, minimized: false, x: 810, y: 0, width: 800, height: 600 },
];
const calls = [];
const bridge = {
  async call(op, args) {
    calls.push({ op, args });
    switch (op) {
      case 'window.list':
        return windows.map((window) => ({ ...window }));
      case 'window.active':
        return windows.find((window) => window.active) ?? null;
      case 'window.activate': {
        const target = windows.find((window) => window.handle === args.handle);
        if (!target) throw new Error('no such window');
        for (const window of windows) window.active = window.handle === args.handle;
        return { handle: target.handle, title: target.title };
      }
      case 'screen.info':
        return { cursor: { x: 5, y: 6 }, screenX: 0, screenY: 0, screenWidth: 1920, screenHeight: 1080, scale: 1 };
      case 'uia.find':
        return {
          windowHandle: 11,
          windowTitle: 'Grok - acc-a profile',
          scanned: 3,
          items: [{ name: '发送', controlType: 'Button', x: 0, y: 10, width: 20, height: 20, centerX: 10, centerY: 20 }],
        };
      case 'uia.at':
        return { x: args.x, y: args.y, windowTitle: 'Grok - acc-a profile', hit: { name: '发送', controlType: 'Button' }, chain: [] };
      case 'mouse.click':
        return { x: args.x, y: args.y, button: 'left' };
      default:
        return {};
    }
  },
};

const store = new StateStore({ dir: path.join(tmpRoot, 'state') });
await store.load();
let enabled = true;
const tools = createComputerTools({
  bridge,
  isEnabled: () => enabled,
  saveImage: async () => ({ attachmentId: 'img-1', mediaType: 'image/png', bytes: 10, width: 2, height: 2 }),
  store,
  logger: { warn() {} },
  paths: { downloadsDir, collectionRoot },
  paceOf: (sessionId) => store.paceOf(sessionId),
});

const exec = { agent: { id: 'sess-test' }, signal: undefined };

function tool(name) {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `tool ${name} exists`);
  return found;
}

async function run(name, args) {
  const definition = tool(name);
  const value = await definition.execute(args, exec);
  return definition.output.render(args, value)
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n');
}

assert.equal(tools.length, 9, 'nine tools');
assert.deepEqual(tools.map((entry) => entry.name).sort(), [...COMPUTER_TOOL_NAMES].sort(), 'tool names match');

// mode off short-circuits every tool
enabled = false;
const modeOff = await run('computer_screenshot', {});
assert.match(modeOff, /OFF/);
assert.match(modeOff, /Ask the user to turn on/);
enabled = true;

// accounts
let text = await run('computer_account', { action: 'set', label: 'acc-a', titleMatch: 'acc-a' });
assert.match(text, /Mapped "acc-a"/);
text = await run('computer_account', { action: 'set', label: 'acc-b', titleMatch: 'acc-b' });
assert.match(text, /Mapped "acc-b"/);
text = await run('computer_account', { action: 'list' });
assert.match(text, /acc-a -> 1 window/);
assert.match(text, /acc-b -> 1 window/);
text = await run('computer_account', { action: 'switch', label: 'acc-a' });
assert.match(text, /acc-a/);
text = await run('computer_account', { action: 'switch', label: 'acc-a' });
assert.match(text, /already in the foreground/);
text = await run('computer_account', { action: 'switch', label: 'nope' });
assert.match(text, /unknown account/);

// danger guard on clicks
const before = calls.filter((call) => call.op === 'mouse.click').length;
text = await run('computer_mouse', { action: 'click', x: 10, y: 20 });
assert.match(text, /confirm:true|refuse/i);
assert.equal(calls.filter((call) => call.op === 'mouse.click').length, before, 'blocked click never reaches the bridge');
text = await run('computer_mouse', { action: 'click', x: 10, y: 20, confirm: true });
assert.match(text, /left/);

// pace: session default human, per-call override, session-level fast setting
await run('computer_keyboard', { action: 'type', text: 'hi' });
assert.equal(calls.filter((call) => call.op === 'key.type').at(-1).args.instant, false, 'human pace types naturally');
await run('computer_keyboard', { action: 'type', text: 'hi', pace: 'fast' });
assert.equal(calls.filter((call) => call.op === 'key.type').at(-1).args.instant, true, 'fast pace override jumps');
store.setPace('sess-test', 'fast');
await run('computer_mouse', { action: 'move', x: 3, y: 4 });
assert.equal(calls.filter((call) => call.op === 'mouse.move').at(-1).args.instant, true, 'session fast pace applies to the mouse');
store.setPace('sess-test', 'human');
await run('computer_mouse', { action: 'move', x: 3, y: 4 });
assert.equal(calls.filter((call) => call.op === 'mouse.move').at(-1).args.instant, false, 'human pace moves naturally');
store.setPace('sess-test', 'custom');
store.setSlowdown('sess-test', 2.5);
await run('computer_keyboard', { action: 'type', text: 'hi' });
const typedCustom = calls.filter((call) => call.op === 'key.type').at(-1);
assert.equal(typedCustom.args.instant, false, 'custom pace keeps the human path');
assert.equal(typedCustom.args.slowdown, 2.5, 'custom pace applies the session slowdown');
store.setPace('sess-test', 'human');
store.setSlowdown('sess-test', 1);
store.setPace('sess-fast', 'fast');
store.setPace('sess-custom', 'custom');
store.setSlowdown('sess-custom', 1.8);

// uia rendering
text = await run('computer_uia', { action: 'find', name: '发送' });
assert.match(text, /center=\(10,20\)/);
text = await run('computer_uia', { action: 'at', x: 10, y: 20 });
assert.match(text, /Hit: Button "发送"/);

// queue lifecycle
text = await run('computer_queue', { action: 'add', items: [{ prompt: 'cat' }, { prompt: 'dog', account: 'acc-a' }] });
assert.match(text, /Added 2 queue item/);
text = await run('computer_queue', { action: 'next' });
assert.match(text, /\[running\]/);
const runningId = /id=(q-[a-z0-9-]+)/.exec(text)?.[1];
assert.ok(runningId, 'next returns the running id');
text = await run('computer_queue', { action: 'complete', id: runningId, note: 'done' });
assert.match(text, /done|complete/i);
text = await run('computer_queue', { action: 'list' });
assert.match(text, /pending=1/);
await run('computer_queue', { action: 'clear' });
text = await run('computer_queue', { action: 'list' });
assert.match(text, /queue is empty/i);

// downloads: first collect records a baseline, later collect moves new files
await fsp.writeFile(path.join(downloadsDir, 'old.png'), 'old');
text = await run('computer_downloads', { action: 'collect', account: 'acc-a' });
assert.match(text, /baseline/i);
const emptyCollected = await fsp.readdir(path.join(collectionRoot, 'acc-a')).catch(() => []);
assert.equal(emptyCollected.length, 0, 'baseline collect moves nothing');
await fsp.writeFile(path.join(downloadsDir, 'new.png'), 'new');
text = await run('computer_downloads', { action: 'collect', account: 'acc-a' });
assert.match(text, /new\.png/);
const collected = await fsp.readdir(path.join(collectionRoot, 'acc-a'));
assert.deepEqual(collected, ['new.png']);

// store persists across reloads
await store.flush();
const reloaded = new StateStore({ dir: path.join(tmpRoot, 'state') });
await reloaded.load();
assert.equal(reloaded.accounts().length, 2, 'accounts persisted');
assert.deepEqual(reloaded.queue(), [], 'queue persisted as empty');
assert.equal(reloaded.paceOf('sess-fast'), 'fast', 'fast pace persisted');
assert.equal(reloaded.paceOf('sess-test'), 'human', 'human pace is the default');
assert.equal(reloaded.paceOf('sess-custom'), 'custom', 'custom pace persisted');
assert.equal(reloaded.slowdownOf('sess-custom'), 1.8, 'slowdown persisted');
assert.equal(reloaded.slowdownOf('sess-unknown'), 1, 'slowdown defaults to 1');
await reloaded.dispose();

await store.dispose();
await fsp.rm(tmpRoot, { recursive: true, force: true });
console.log('ALL TOOL TESTS PASSED');
