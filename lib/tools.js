/**
 * Tool definitions for the GUI agent mode.
 *
 * Every tool first checks that the calling session has agent control enabled;
 * the tools themselves are only registered while at least one session has it on.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseComboList } from './keys.js';

export const COMPUTER_TOOL_NAMES = [
  'computer_screenshot',
  'computer_mouse',
  'computer_keyboard',
  'computer_window',
  'computer_wait',
  'computer_uia',
  'computer_account',
  'computer_queue',
  'computer_downloads',
];

const MODE_OFF_TEXT =
  'Agent control is OFF for this session. Ask the user to turn on 「代理操作」 with the toggle at the left of the composer, then retry.';

/** Controls whose click sends, pays, publishes or deletes: never clicked unconfirmed. */
const DANGER_RE =
  /(发送|提交|购买|支付|下单|结账|确认支付|删除|移除|发布|分享|清空|注销|退出登录|\b(send|submit|buy|pay|purchase|delete|remove|publish|share|post|checkout|logout)\b)/i;

const SCREENSHOT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      image: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          name: { type: 'string' },
        },
      },
    },
    required: ['text'],
  },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: String(value?.text ?? '') }];
    if (value?.image !== undefined && value.image !== null) blocks.push({ type: 'image', attachment: value.image });
    return blocks;
  },
};

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

function errorText(message) {
  return { text: `Error: ${message}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeWindows(windows, limit = 40) {
  const lines = windows.slice(0, limit).map((window) => {
    const flags = [window.minimized ? 'minimized' : '', window.active ? 'active' : ''].filter(Boolean).join(' ');
    return `- handle=${window.handle} pid=${window.pid} rect=${window.x},${window.y},${window.width}x${window.height}${flags ? ` [${flags}]` : ''} ${JSON.stringify(window.title)}`;
  });
  const omitted = windows.length - lines.length;
  return `${windows.length} visible window(s)${omitted > 0 ? `, first ${lines.length} shown` : ''}:\n${lines.join('\n')}`;
}

function guardText(sessionEnabled) {
  return sessionEnabled ? null : MODE_OFF_TEXT;
}

/** 'human' (default) = native eased motion and natural timings; 'fast' = jump + minimal delays; 'custom' = human path with a slowdown multiplier. */
function resolvePace(args, exec, paceOf) {
  if (args?.pace === 'human' || args?.pace === 'fast' || args?.pace === 'custom') return args.pace;
  try {
    const pace = paceOf?.(exec?.agent?.id);
    return pace === 'fast' || pace === 'custom' ? pace : 'human';
  } catch {
    return 'human';
  }
}

/** Typing slowdown: explicit argument wins, then the session's custom pace, otherwise 1. */
function resolveSlowdown(args, exec, paceOf, store) {
  if (typeof args?.slowdown === 'number' && args.slowdown > 0) return args.slowdown;
  if (resolvePace(args, exec, paceOf) !== 'custom' || !store) return 1;
  try {
    const value = store.slowdownOf?.(exec?.agent?.id);
    return typeof value === 'number' && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

function requireStore(store) {
  if (!store) throw new Error('the plugin state store is unavailable');
  return store;
}

function findTitleMatch(windows, titleMatch) {
  const needle = String(titleMatch ?? '').toLowerCase();
  if (needle.length === 0) return [];
  return windows.filter((window) => String(window.title ?? '').toLowerCase().includes(needle));
}

function fmtAccounts(accounts, windows) {
  if (accounts.length === 0) {
    return 'No accounts mapped yet. Map one with computer_account action=set (label + a window-title substring that identifies that account).';
  }
  const lines = accounts.map((account) => {
    const matches = findTitleMatch(windows, account.titleMatch);
    if (matches.length === 0) {
      return `- ${account.label} -> no matching window (title must contain ${JSON.stringify(account.titleMatch)})`;
    }
    const active = matches.find((window) => window.active);
    return `- ${account.label} -> ${matches.length} window(s)${active ? ` [active: ${JSON.stringify(active.title)}]` : ''}: ${matches.map((window) => `handle=${window.handle} ${JSON.stringify(window.title)}`).join(', ')}`;
  });
  return `Known accounts (${accounts.length}):\n${lines.join('\n')}`;
}

async function listDownloadFiles(downloadsDir) {
  const dir = downloadsDir ?? path.join(os.homedir(), 'Downloads');
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`cannot read the Downloads folder ${dir}: ${error?.message ?? error}`);
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (/\.(crdownload|tmp|part)$/i.test(entry.name)) continue;
    const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
    if (!stat) continue;
    files.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs, isFile: true });
  }
  return files;
}

function newDownloads(files, baseline) {
  const known = new Set(baseline ?? []);
  return files.filter((file) => !known.has(file.name));
}

function downloadBaselineOf(store, account) {
  try {
    return store.downloadBaseline(account) ?? [];
  } catch {
    return [];
  }
}

function uniqueTarget(dir, name) {
  const base = path.basename(name);
  const ext = path.extname(base);
  const stem = ext.length > 0 ? base.slice(0, -ext.length) : base;
  let candidate = path.join(dir, base);
  let counter = 2;
  return { candidate, unique: () => {
    candidate = path.join(dir, counter === 1 ? base : `${stem} (${counter})${ext}`);
    counter += 1;
    return candidate;
  } };
}

async function moveFileInto(sourcePath, targetDir, name) {
  const { candidate, unique } = uniqueTarget(targetDir, name);
  const target = candidate;
  try {
    await fsp.access(target);
    const next = unique();
    await fsp.rename(sourcePath, next);
    return path.basename(next);
  } catch (error) {
    if (error?.code === 'EXDEV') {
      await fsp.copyFile(sourcePath, target);
      await fsp.unlink(sourcePath);
      return path.basename(target);
    }
    if (error?.code === 'ENOENT') {
      await fsp.rename(sourcePath, target);
      return path.basename(target);
    }
    throw error;
  }
}

export function createComputerTools({ bridge, isEnabled, saveImage, store, logger, paths = {}, paceOf }) {
  const timeoutFor = (base, extraMs = 0) => Math.min(60_000, base + extraMs);
  const downloadsDir = typeof paths?.downloadsDir === 'string' && paths.downloadsDir.length > 0 ? paths.downloadsDir : path.join(os.homedir(), 'Downloads');
  const collectionRoot =
    typeof paths?.collectionRoot === 'string' && paths.collectionRoot.length > 0
      ? paths.collectionRoot
      : path.join(os.homedir(), 'Pictures', 'dsh-gui-agent');

  async function cursorPoint() {
    const info = await bridge.call('screen.info', {}, 10_000);
    return { x: Math.round(info.cursor?.x ?? 0), y: Math.round(info.cursor?.y ?? 0) };
  }

  async function checkDanger(x, y) {
    try {
      const at = await bridge.call('uia.at', { x, y }, 10_000);
      const name = String(at?.hit?.name ?? '');
      const title = String(at?.windowTitle ?? '');
      return { blocked: name.length > 0 && DANGER_RE.test(name), name, title };
    } catch (error) {
      logger?.warn?.(`computer_mouse: UI Automation danger check skipped (${error?.message ?? error})`);
      return { blocked: false, skipped: true };
    }
  }

  const screenshot = {
    name: 'computer_screenshot',
    description:
      'Capture the Windows desktop and return it as an image together with the screen geometry, cursor position and active window title. Call it before acting, and again after acting to verify the result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        monitor: {
          description: "Which display to capture: 'all' for the whole virtual desktop (default), or a 0-based monitor index.",
          oneOf: [{ type: 'string', enum: ['all'] }, { type: 'integer', minimum: 0, maximum: 7 }],
          default: 'all',
        },
        scale: {
          description: 'Downscale factor between 0.2 and 1; use a smaller value to shrink large images. Coordinates stay in screen pixels.',
          type: 'number',
          minimum: 0.2,
          maximum: 1,
          default: 1,
        },
        name: { type: 'string', description: 'Optional display name for the image.' },
      },
    },
    output: SCREENSHOT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      const monitor = args?.monitor ?? 'all';
      const scale = typeof args?.scale === 'number' ? args.scale : 1;
      const tmp = path.join(os.tmpdir(), `dsh-gui-agent-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
      try {
        const info = await bridge.call('screen.capture', { path: tmp, monitor, scale }, timeoutFor(15_000));
        let data;
        try {
          data = await fsp.readFile(tmp);
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => {});
        }
        const ref = await saveImage({
          data,
          mediaType: 'image/png',
          name: typeof args?.name === 'string' && args.name ? args.name : `screenshot-${Date.now()}.png`,
        });
        const geometry =
          `screen ${info.screenWidth}x${info.screenHeight} at (${info.screenX},${info.screenY}); ` +
          `image ${info.width}x${info.height} (scale ${info.scale}); ` +
          `cursor (${info.cursor?.x ?? '?'},${info.cursor?.y ?? '?'}); ` +
          `active window ${JSON.stringify(info.activeWindow ?? '')}`;
        return {
          text: `Screenshot captured. ${geometry}. Use image pixels as screen coordinates when scale is 1.`,
          image: {
            attachmentId: String(ref.attachmentId),
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name !== undefined ? { name: ref.name } : {}),
          },
        };
      } catch (error) {
        logger?.warn?.(`computer_screenshot failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  const mouse = {
    name: 'computer_mouse',
    description: 'Move the real mouse cursor, click, scroll or drag on the Windows desktop. Coordinates are screen pixels.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'down', 'up', 'wheel', 'drag'],
          description: 'The pointer action to perform.',
        },
        x: { type: 'number', description: 'Target X in screen pixels (move/click/drag start).' },
        y: { type: 'number', description: 'Target Y in screen pixels (move/click/drag start).' },
        toX: { type: 'number', description: 'Drag end X.' },
        toY: { type: 'number', description: 'Drag end Y.' },
        deltaY: { type: 'number', description: 'Wheel delta: positive scrolls up, negative scrolls down; multiples of 120 are one notch each.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left', description: 'Button for down/up/wheel.' },
        clicks: { type: 'integer', minimum: 1, maximum: 5, default: 1, description: 'Click count for click actions.' },
        intervalMs: { type: 'integer', minimum: 0, maximum: 2000, default: 0, description: 'Fixed delay between repeated clicks; 0 picks a natural interval.' },
        durationMs: { type: 'integer', minimum: 60, maximum: 5000, default: 220, description: 'Drag duration.' },
        instant: {
          type: 'boolean',
          description:
            'Default false: the cursor travels a smooth eased path with slight jitter and the click has natural press/interval timing. Set true to jump straight there with fixed fast timings.',
        },
        pace: {
          type: 'string',
          enum: ['human', 'fast', 'custom'],
          description:
            'Override the session input pace for this call: human = native eased motion and natural timings, fast = instant jump with minimal delays, custom = human path with the session slowdown multiplier. Defaults to the composer pace control.',
        },
        confirm: {
          type: 'boolean',
          description:
            'Set true only after the user explicitly approved this click. Required when the click lands on a destructive control (send, submit, buy, pay, delete, publish...).',
        },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      const action = args?.action;
      try {
        switch (action) {
          case 'move': {
            if (typeof args.x !== 'number' || typeof args.y !== 'number') throw new Error('move requires x and y');
            const instant = args?.instant === true || resolvePace(args, exec, paceOf) === 'fast';
            const result = await bridge.call('mouse.move', {
              x: Math.round(args.x),
              y: Math.round(args.y),
              instant,
              durationMs: args?.durationMs,
            });
            return { text: `Cursor moved to (${result.x},${result.y}).` };
          }
          case 'click':
          case 'double_click':
          case 'right_click':
          case 'middle_click': {
            const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : (args?.button ?? 'left');
            const clicks = action === 'double_click' ? 2 : Math.max(1, Math.min(5, Math.round(args?.clicks ?? 1)));
            if (args?.confirm !== true) {
              const point = typeof args.x === 'number' && typeof args.y === 'number' ? { x: Math.round(args.x), y: Math.round(args.y) } : await cursorPoint();
              const danger = await checkDanger(point.x, point.y);
              if (danger.blocked) {
                throw new Error(
                  `refusing to click ${JSON.stringify(danger.name)} in window ${JSON.stringify(danger.title)}: that control looks destructive ` +
                    '(send/submit/buy/pay/delete/publish...). Ask the user first, then retry with confirm:true if they approved this exact click.',
                );
              }
            }
            const result = await bridge.call('mouse.click', {
              ...(typeof args.x === 'number' && typeof args.y === 'number' ? { x: Math.round(args.x), y: Math.round(args.y) } : {}),
              button,
              clicks,
              intervalMs: args?.intervalMs,
              instant: args?.instant === true || resolvePace(args, exec, paceOf) === 'fast',
              durationMs: args?.durationMs,
            });
            const where = typeof args.x === 'number' ? ` at (${result.x},${result.y})` : '';
            return { text: `${button} button x${clicks}${where}.` };
          }
          case 'down':
          case 'up': {
            await bridge.call(action === 'down' ? 'mouse.down' : 'mouse.up', { button: args?.button ?? 'left' });
            return { text: `Mouse ${action} (${args?.button ?? 'left'}).` };
          }
          case 'wheel': {
            const deltaY = typeof args?.deltaY === 'number' ? args.deltaY : 0;
            if (deltaY === 0) throw new Error('wheel requires a non-zero deltaY');
            const notches = Math.max(1, Math.round(Math.abs(deltaY) / 120));
            await bridge.call('mouse.wheel', { delta: deltaY > 0 ? 120 : -120, notches });
            return { text: `Scrolled ${deltaY > 0 ? 'up' : 'down'} ${notches} notch(es).` };
          }
          case 'drag': {
            if ([args?.x, args?.y, args?.toX, args?.toY].some((value) => typeof value !== 'number')) {
              throw new Error('drag requires x, y, toX and toY');
            }
            await bridge.call('mouse.drag', {
              fromX: Math.round(args.x),
              fromY: Math.round(args.y),
              toX: Math.round(args.toX),
              toY: Math.round(args.toY),
              durationMs: args?.durationMs,
              instant: args?.instant === true || resolvePace(args, exec, paceOf) === 'fast',
            });
            return { text: `Dragged from (${args.x},${args.y}) to (${args.toX},${args.toY}).` };
          }
          default:
            throw new Error(`unsupported mouse action: ${String(action)}`);
        }
      } catch (error) {
        logger?.warn?.(`computer_mouse failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  const keyboard = {
    name: 'computer_keyboard',
    description: 'Type text or press key combinations on the real Windows desktop. Text is sent as Unicode, so it works without switching the input method.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['type', 'press'], description: 'type writes text; press sends one or more key combinations.' },
        text: { type: 'string', description: "Text for action='type'. Use \\n for Enter." },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: "Combos for action='press', e.g. [\"ctrl+l\",\"enter\"] or [\"f5\"].",
        },
        key: { type: 'string', description: "Single combo for action='press', shorthand for keys=[key]." },
        holdMs: {
          type: 'integer',
          minimum: 0,
          maximum: 2000,
          default: 0,
          description: 'How long to hold the key combination; 0 picks a natural duration.',
        },
        instant: {
          type: 'boolean',
          description:
            'Default false: characters are typed with a natural, slightly uneven cadence and key presses have human durations. Set true for fast deterministic typing.',
        },
        slowdown: {
          type: 'number',
          minimum: 0.2,
          maximum: 8,
          default: 1,
          description: 'Multiplier for the natural per-character delay; 2 types half as fast, 0.5 twice as fast.',
        },
        pace: {
          type: 'string',
          enum: ['human', 'fast', 'custom'],
          description:
            'Override the session input pace for this call: human = natural keystroke cadence, fast = instant typing with minimal delays, custom = natural cadence with the session slowdown multiplier. Defaults to the composer pace control.',
        },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      try {
        if (args?.action === 'type') {
          const value = typeof args?.text === 'string' ? args.text : '';
          if (value.length === 0) throw new Error('type requires text');
          const instant = args?.instant === true || resolvePace(args, exec, paceOf) === 'fast';
          const slowdown = resolveSlowdown(args, exec, paceOf, store);
          await bridge.call(
            'key.type',
            { text: value, instant, slowdown },
            timeoutFor(15_000, value.length * (instant ? 20 : 200 * Math.max(1, slowdown))),
          );
          const preview = value.length > 60 ? `${value.slice(0, 60)}…` : value;
          return { text: `Typed ${value.length} character(s): ${JSON.stringify(preview)}` };
        }
        if (args?.action === 'press') {
          const combos = Array.isArray(args?.keys) && args.keys.length > 0 ? args.keys : typeof args?.key === 'string' ? [args.key] : [];
          if (combos.length === 0) throw new Error('press requires key or keys');
          const parsed = parseComboList(combos.map((combo) => String(combo)));
          for (const vks of parsed) {
            await bridge.call('key.combo', {
              vks,
              holdMs: args?.holdMs,
              instant: args?.instant === true || resolvePace(args, exec, paceOf) === 'fast',
            });
          }
          return { text: `Pressed ${combos.map((combo) => JSON.stringify(combo)).join(', ')}.` };
        }
        throw new Error(`unsupported keyboard action: ${String(args?.action)}`);
      } catch (error) {
        logger?.warn?.(`computer_keyboard failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  const windowTool = {
    name: 'computer_window',
    description:
      'List top-level Windows windows, or bring one to the foreground / minimize / maximize / restore / close it. Activate the target window before clicking or typing into it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'activate', 'minimize', 'maximize', 'restore', 'close'],
          description: 'What to do with the window.',
        },
        title: { type: 'string', description: 'Case-insensitive substring of the window title (alternative to handle).' },
        handle: { type: 'integer', description: 'Window handle from action=list; more precise than title.' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      try {
        const action = args?.action;
        if (action === 'list') {
          const windows = await bridge.call('window.list');
          return { text: describeWindows(Array.isArray(windows) ? windows : []) };
        }
        let handle = typeof args?.handle === 'number' && args.handle > 0 ? args.handle : null;
        if (handle === null && typeof args?.title === 'string' && args.title.length > 0) {
          const windows = await bridge.call('window.list');
          const needle = args.title.toLowerCase();
          const hit = (Array.isArray(windows) ? windows : []).find((item) => String(item.title).toLowerCase().includes(needle));
          if (!hit) throw new Error(`no visible window title contains ${JSON.stringify(args.title)}`);
          handle = hit.handle;
        }
        if (handle === null) throw new Error('handle or title is required');
        if (action === 'activate') {
          const result = await bridge.call('window.activate', { handle });
          return { text: `Window ${handle} foreground=${result.foreground === true ? 'yes' : 'no'}.` };
        }
        const commands = { minimize: 6, maximize: 3, restore: 9 };
        if (action in commands) {
          await bridge.call('window.show', { handle, cmd: commands[action] });
          return { text: `Window ${handle}: ${action}.` };
        }
        if (action === 'close') {
          await bridge.call('window.close', { handle });
          return { text: `Close requested for window ${handle}.` };
        }
        throw new Error(`unsupported window action: ${String(action)}`);
      } catch (error) {
        logger?.warn?.(`computer_window failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  const wait = {
    name: 'computer_wait',
    description: 'Pause briefly before the next action, for example after activating a window or submitting a page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ms: { type: 'integer', minimum: 50, maximum: 10_000, default: 400, description: 'Delay in milliseconds.' },
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      const ms = Math.max(50, Math.min(10_000, Math.round(args?.ms ?? 400)));
      await sleep(ms);
      return { text: `Waited ${ms}ms.` };
    },
  };

  const uia = {
    name: 'computer_uia',
    description:
      'Read Windows UI Automation to locate controls in a window without injecting into the page: find buttons/edits by name, or describe the element under a screen point. Use the returned centerX/centerY with computer_mouse.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['find', 'at'], description: "find lists matching elements; at describes the element under (x,y)." },
        title: { type: 'string', description: 'Case-insensitive window-title substring to search in (defaults to the foreground window).' },
        handle: { type: 'integer', description: 'Window handle from computer_window list.' },
        name: { type: 'string', description: "For find: only elements whose accessible name contains this text (case-insensitive)." },
        controlType: { type: 'string', description: 'For find: only this control type, e.g. Button, Edit, Hyperlink, Text, TabItem.' },
        max: { type: 'integer', minimum: 1, maximum: 500, default: 60, description: 'Maximum number of elements returned.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 40, default: 16, description: 'Maximum tree depth to walk.' },
        x: { type: 'number', description: 'For at: screen X.' },
        y: { type: 'number', description: 'For at: screen Y.' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      try {
        if (args?.action === 'find') {
          const result = await bridge.call(
            'uia.find',
            {
              ...(typeof args?.handle === 'number' ? { handle: args.handle } : {}),
              ...(typeof args?.title === 'string' ? { title: args.title } : {}),
              ...(typeof args?.name === 'string' ? { name: args.name } : {}),
              ...(typeof args?.controlType === 'string' ? { controlType: args.controlType } : {}),
              ...(typeof args?.max === 'number' ? { max: args.max } : {}),
              ...(typeof args?.maxDepth === 'number' ? { maxDepth: args.maxDepth } : {}),
            },
            25_000,
          );
          const items = Array.isArray(result?.items) ? result.items : [];
          const lines = items.map(
            (item) =>
              `- ${item.controlType} ${JSON.stringify(item.name)} center=(${item.centerX},${item.centerY}) rect=${item.x},${item.y},${item.width}x${item.height}${item.enabled === false ? ' [disabled]' : ''}`,
          );
          return {
            text:
              `UI Automation in window ${JSON.stringify(result?.windowTitle ?? '')}: scanned ${result?.scanned ?? 0} node(s), ` +
              `${items.length} match(es).\n${lines.join('\n') || '(no matches)'}`,
          };
        }
        if (args?.action === 'at') {
          const x = Math.round(args?.x ?? NaN);
          const y = Math.round(args?.y ?? NaN);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('at requires x and y');
          const result = await bridge.call('uia.at', { x, y }, 15_000);
          const chain = Array.isArray(result?.chain) ? result.chain : [];
          const lines = chain.map((item) => `  ${item.controlType} ${JSON.stringify(item.name)} rect=${item.x},${item.y},${item.width}x${item.height}`);
          return {
            text:
              `Point (${x},${y}) is in window ${JSON.stringify(result?.windowTitle ?? '')} (handle=${result?.windowHandle ?? 0}).\n` +
              `Hit: ${result?.hit ? `${result.hit.controlType} ${JSON.stringify(result.hit.name)}` : 'no element'}\n` +
              `Owner chain (outermost last):\n${lines.join('\n')}`,
          };
        }
        throw new Error(`unsupported uia action: ${String(args?.action)}`);
      } catch (error) {
        logger?.warn?.(`computer_uia failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  const accountTool = {
    name: 'computer_account',
    description:
      'Map each browser window to an account by a window-title substring, list which account owns which window, and switch to an account window while verifying the foreground changed. Use it before acting on a multi-account batch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'set', 'remove', 'switch'], description: 'list | set | remove | switch' },
        label: { type: 'string', description: 'Account label, e.g. "acc-a".' },
        titleMatch: { type: 'string', description: 'Case-insensitive window-title substring that identifies this account (defaults to label for set).' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      try {
        const state = requireStore(store);
        const action = args?.action;
        if (action === 'list') {
          const windows = await bridge.call('window.list');
          return { text: fmtAccounts(state.accounts(), Array.isArray(windows) ? windows : []) };
        }
        if (action === 'set') {
          const label = typeof args?.label === 'string' ? args.label.trim() : '';
          if (label.length === 0) throw new Error('set requires label');
          const titleMatch = typeof args?.titleMatch === 'string' && args.titleMatch.trim().length > 0 ? args.titleMatch : label;
          const accounts = state.setAccount(label, titleMatch);
          const windows = await bridge.call('window.list');
          return { text: `Mapped ${JSON.stringify(label)} to a title containing ${JSON.stringify(titleMatch)}.\n${fmtAccounts(accounts, Array.isArray(windows) ? windows : [])}` };
        }
        if (action === 'remove') {
          const label = typeof args?.label === 'string' ? args.label.trim() : '';
          if (label.length === 0) throw new Error('remove requires label');
          const result = state.removeAccount(label);
          return { text: result.removed ? `Removed account ${JSON.stringify(label)}.` : `No account named ${JSON.stringify(label)}.` };
        }
        if (action === 'switch') {
          const label = typeof args?.label === 'string' ? args.label.trim() : '';
          if (label.length === 0) throw new Error('switch requires label');
          const account = state.accounts().find((entry) => entry.label === label);
          if (!account) throw new Error(`unknown account ${JSON.stringify(label)}; map it first with action=set`);
          const windows = await bridge.call('window.list');
          const matches = findTitleMatch(Array.isArray(windows) ? windows : [], account.titleMatch);
          if (matches.length === 0) throw new Error(`no visible window title contains ${JSON.stringify(account.titleMatch)}`);
          const target = matches.find((window) => window.active) ?? matches[0];
          if (matches.find((window) => window.active)) {
            return { text: `Account ${JSON.stringify(label)} is already in the foreground (handle=${target.handle} ${JSON.stringify(target.title)}).` };
          }
          await bridge.call('window.activate', { handle: target.handle });
          await sleep(250);
          const active = await bridge.call('window.active', {}, 10_000);
          const activeTitle = String(active?.title ?? '');
          if (active?.handle !== target.handle && !activeTitle.toLowerCase().includes(account.titleMatch.toLowerCase())) {
            throw new Error(
              `could not bring account ${JSON.stringify(label)} to the foreground; the active window is ${JSON.stringify(activeTitle)} ` +
                `(handle=${active?.handle ?? 0}). Ask the user to click it once, or activate another window first.`,
            );
          }
          return { text: `Switched to account ${JSON.stringify(label)}: handle=${target.handle} ${JSON.stringify(activeTitle)}.` };
        }
        throw new Error(`unsupported account action: ${String(action)}`);
      } catch (error) {
        logger?.warn?.(`computer_account failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  const queueTool = {
    name: 'computer_queue',
    description:
      'Keep a batch of prompts (for example image-generation prompts per account): add items, take the next pending one, mark it done or failed, list and clear. Pair with computer_account and computer_downloads for an unattended batch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['add', 'next', 'complete', 'fail', 'list', 'clear'], description: 'Queue operation.' },
        prompt: { type: 'string', description: 'Prompt text for add (single item).' },
        account: { type: 'string', description: 'Account label this item belongs to.' },
        items: {
          type: 'array',
          description: 'Batch add: array of {prompt, account}.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { prompt: { type: 'string' }, account: { type: 'string' } },
            required: ['prompt'],
          },
        },
        id: { type: 'string', description: 'Queue item id for complete/fail.' },
        note: { type: 'string', description: 'Short note stored with the completed item, e.g. the saved file name.' },
        status: { type: 'string', enum: ['done', 'failed', 'running', 'pending'], description: 'For clear: only remove items with this status (default: clear everything).' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      try {
        const state = requireStore(store);
        const action = args?.action;
        const fmtItem = (item) => `- [${item.status}] ${item.id} account=${JSON.stringify(item.account || '')} ${JSON.stringify(item.prompt)}${item.note ? ` note=${JSON.stringify(item.note)}` : ''}`;
        if (action === 'add') {
          const items = Array.isArray(args?.items) && args.items.length > 0 ? args.items : [{ prompt: args?.prompt, account: args?.account }];
          const added = state.addQueue(items);
          return { text: `Added ${added.length} queue item(s).\n${added.map(fmtItem).join('\n')}` };
        }
        if (action === 'next') {
          const item = state.queueNext();
          if (!item) return { text: 'The queue has no pending items.' };
          return { text: `Next item:\n${fmtItem(item)}\nWhen it is finished, call action=complete (or action=fail) with id=${item.id}.` };
        }
        if (action === 'complete' || action === 'fail') {
          const id = typeof args?.id === 'string' ? args.id : '';
          if (id.length === 0) throw new Error(`${action} requires id`);
          const item = state.finishQueue(id, action === 'complete' ? 'done' : 'failed', args?.note ?? '');
          if (!item) throw new Error(`unknown queue id ${JSON.stringify(id)}`);
          return { text: `Queue item ${id} marked ${item.status}.` };
        }
        if (action === 'list') {
          const items = state.queue();
          if (items.length === 0) return { text: 'The queue is empty.' };
          const counts = items.reduce((acc, item) => ((acc[item.status] = (acc[item.status] ?? 0) + 1), acc), {});
          return { text: `Queue (${items.length}): ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' ')}\n${items.map(fmtItem).join('\n')}` };
        }
        if (action === 'clear') {
          const removed = state.clearQueue(typeof args?.status === 'string' ? args.status : undefined);
          return { text: `Removed ${removed} queue item(s).` };
        }
        throw new Error(`unsupported queue action: ${String(action)}`);
      } catch (error) {
        logger?.warn?.(`computer_queue failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  const downloadsTool = {
    name: 'computer_downloads',
    description:
      "Work with the user's Downloads folder: list current files, wait for a new download to finish, or move the new files into ~/Pictures/dsh-gui-agent/<account> as the collected dataset. The first collect records a baseline instead of moving existing files.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'wait', 'collect'], description: 'list | wait | collect' },
        account: { type: 'string', description: 'Account label; picks the baseline and the destination subfolder.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 30000, description: 'For wait: how long to wait for a new file.' },
        settleMs: { type: 'integer', minimum: 0, maximum: 10000, default: 800, description: 'For wait: how long the file size must stay unchanged to count as finished.' },
      },
      required: ['action'],
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const blocked = guardText(isEnabled(exec?.agent?.id));
      if (blocked) return { text: blocked };
      try {
        const state = requireStore(store);
        const account = typeof args?.account === 'string' ? args.account.trim() : '';
        const label = account || 'unassigned';
        const action = args?.action;
        if (action === 'list') {
          const files = await listDownloadFiles(downloadsDir);
          const baseline = downloadBaselineOf(state, account);
          const fresh = newDownloads(files, baseline);
          return {
            text:
              `${files.length} file(s) in Downloads; ${fresh.length} not in the baseline for ${JSON.stringify(label)}.\n` +
              files.slice(0, 40).map((file) => `- ${JSON.stringify(file.name)} ${file.size}B`).join('\n'),
          };
        }
        if (action === 'wait') {
          const baseline = downloadBaselineOf(state, account);
          const timeoutMs = Math.max(1000, Math.min(120_000, Math.round(args?.timeoutMs ?? 30_000)));
          const settleMs = Math.max(0, Math.min(10_000, Math.round(args?.settleMs ?? 800)));
          const deadline = Date.now() + timeoutMs;
          let signature = '';
          let stableSince = 0;
          while (Date.now() < deadline) {
            const fresh = newDownloads(await listDownloadFiles(downloadsDir), baseline);
            if (fresh.length > 0) {
              const next = fresh.map((file) => `${file.name}:${file.size}`).join('|');
              if (next !== signature) {
                signature = next;
                stableSince = Date.now();
              } else if (Date.now() - stableSince >= settleMs) {
                return { text: `New download(s) finished:\n${fresh.map((file) => `- ${JSON.stringify(file.name)} ${file.size}B`).join('\n')}` };
              }
            }
            await sleep(400);
          }
          return errorText(`no new download finished within ${timeoutMs}ms`);
        }
        if (action === 'collect') {
          const files = await listDownloadFiles(downloadsDir);
          const baseline = state.downloadBaseline(account);
          if (baseline === null) {
            state.setDownloadBaseline(account, files.map((file) => file.name));
            return { text: `Recorded a baseline of ${files.length} existing download(s) for ${JSON.stringify(label)}; nothing moved. Download the images, then collect again.` };
          }
          const fresh = newDownloads(files, baseline);
          if (fresh.length === 0) return { text: `No new downloads since the baseline for ${JSON.stringify(label)}.` };
          const targetDir = path.join(collectionRoot, label === 'unassigned' ? '_unassigned' : label);
          await fsp.mkdir(targetDir, { recursive: true });
          const moved = [];
          for (const file of fresh) {
            try {
              const source = path.join(downloadsDir, file.name);
              moved.push(await moveFileInto(source, targetDir, file.name));
            } catch (error) {
              logger?.warn?.(`computer_downloads: could not move ${file.name}: ${error.message}`);
            }
          }
          const remaining = await listDownloadFiles(downloadsDir);
          state.setDownloadBaseline(account, remaining.map((file) => file.name));
          return {
            text: `Moved ${moved.length} file(s) into ${targetDir}:\n${moved.map((name) => `- ${JSON.stringify(name)}`).join('\n') || '(none)'}`,
          };
        }
        throw new Error(`unsupported downloads action: ${String(action)}`);
      } catch (error) {
        logger?.warn?.(`computer_downloads failed: ${error.message}`);
        return errorText(error.message);
      }
    },
  };

  return [screenshot, mouse, keyboard, windowTool, wait, uia, accountTool, queueTool, downloadsTool];
}
