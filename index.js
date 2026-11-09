/**
 * dsh-gui-agent host half.
 *
 * Owns the per-session "agent control" state, the Windows input bridge, the
 * computer_* tool registrations (lazily added while at least one session has
 * the mode enabled) and the authenticated web routes the composer toggle uses.
 *
 * Durable state (enabled sessions, window↔account mapping, download baselines
 * and the prompt queue) lives in lib/store.js.
 */
import path from 'node:path';
import { WinBridge } from './lib/win-bridge.js';
import { StateStore } from './lib/store.js';
import { createComputerTools, COMPUTER_TOOL_NAMES } from './lib/tools.js';

const ROUTE_BASE = '/gui-agent';
const PROMPT_SECTION = 'gui-agent-computer-use';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;

const PROMPT_TEXT = [
  'Agent control (代理操作) is enabled for this session: the user can watch you drive their real Windows desktop.',
  'Tools: computer_window (list/activate windows), computer_uia (locate controls through UI Automation), computer_account (window↔account mapping), computer_screenshot, computer_mouse, computer_keyboard, computer_queue (batch prompts), computer_downloads (collect downloaded files), computer_wait.',
  'Input is native: every click and keystroke goes through the Win32 SendInput path, exactly like a real mouse and keyboard (never DOM events or debugger protocols), so the page receives trusted input.',
  'By default the cursor glides along an eased, slightly jittered path and clicks/keystrokes use humanised natural durations (the "仿真" pace). The user may switch the session to the "便捷" pace in the composer; do not pass instant:true unless you need a deterministic jump for one specific action. Do not add scripted "human-like" delays on top — the native path already handles it.',
  'The session input pace is one of human (仿真: eased two-segment paths with overshoot correction, log-normal keystroke timing, occasional typo+backspace) or fast (便捷: instant jumps and minimal delays), and there is a custom pace (自定义) that keeps the human path with a per-session slowdown multiplier (0.2–8×). Both tools accept an optional pace override, and the current value is reported by the session state and the composer dropdown.',
  'Work in this order: computer_window (activate the target) -> computer_wait (~300ms) -> computer_screenshot -> computer_mouse / computer_keyboard -> computer_screenshot to verify.',
  'Screenshots come back as images; their text metadata reports screen size, image size, scale, cursor position and the active window title. When scale is 1, image pixels equal screen pixels; otherwise multiply image coordinates by (screen size / image size).',
  'For a control you cannot identify visually, use computer_uia action=find or action=at to get its exact center, then click that point.',
  'Prefer keyboard paths over pixel hunting: focus the window, then use the address bar, search box or shortcuts (ctrl+l, ctrl+f, tab, enter).',
  'On multi-account batches: map accounts once with computer_account action=set (a window-title substring per account), switch with action=switch and verify the foreground before acting; take work from computer_queue, and collect results with computer_downloads action=wait / action=collect.',
  'Clicking destructive controls (send/submit/buy/pay/delete/publish...) is refused unless you pass confirm:true, and you may only do that after the user explicitly approved that exact action. Never perform irreversible actions on your own.',
].join('\n');

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': data.length,
  });
  res.end(data);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apply(ctx, config = {}) {
  const warn = (...parts) => {
    try {
      ctx.logger?.warn?.(...parts);
    } catch {
      /* logging must never break the feature */
    }
  };
  const logger = { warn };
  const service = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };

  const sessions = new Map();
  const store = new StateStore({
    ...(typeof config?.storeDir === 'string' && config.storeDir.length > 0 ? { dir: path.resolve(config.storeDir) } : {}),
    logger,
  });
  let bridge = null;
  let toolDisposers = null;
  let promptDispose = null;
  let registered = false;
  let disposed = false;

  void store
    .load()
    .then(() => {
      if (disposed) return;
      const restored = store.pruneSessions(SESSION_TTL_MS);
      for (const sessionId of restored) {
        sessions.set(sessionId, store.sessionSeen(sessionId) || Date.now());
      }
      if (restored.length > 0) {
        warn(`dsh-gui-agent: restored ${restored.length} enabled session(s) from ${store.file}`);
        syncRegistrations();
      }
    })
    .catch((error) => warn('dsh-gui-agent: could not restore state', error?.message ?? error));

  function isEnabled(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    const seen = sessions.get(sessionId);
    if (seen === undefined) return false;
    if (Date.now() - seen > SESSION_TTL_MS) {
      sessions.delete(sessionId);
      store.setSession(sessionId, false);
      return false;
    }
    return true;
  }

  function paceOf(sessionId) {
    try {
      const pace = store.paceOf(sessionId);
      return pace === 'fast' || pace === 'custom' ? pace : 'human';
    } catch {
      return 'human';
    }
  }

  function slowdownOf(sessionId) {
    try {
      return store.slowdownOf(sessionId);
    } catch {
      return 1;
    }
  }

  async function saveImage(input) {
    const attachments = ctx.get('attachments');
    if (!attachments) throw new Error('the attachment service is unavailable, so screenshots cannot be returned to the model');
    return attachments.saveImage(input);
  }

  function registerAll() {
    const tools = service('tools');
    const systemPrompt = service('systemPrompt');
    if (!tools) throw new Error('the tools service is unavailable');
    if (registered) return;
    bridge = bridge ?? new WinBridge({ logger });
    const definitions = createComputerTools({ bridge, isEnabled, saveImage, store, logger, paceOf });
    const disposers = [];
    try {
      for (const definition of definitions) disposers.push(tools.register(definition));
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      if (bridge) {
        bridge.dispose();
        bridge = null;
      }
      throw error;
    }
    toolDisposers = disposers;
    registered = true;
    if (systemPrompt) {
      try {
        promptDispose = systemPrompt.section({ name: PROMPT_SECTION, order: 890, text: PROMPT_TEXT });
      } catch (error) {
        warn('dsh-gui-agent: failed to register prompt section', error?.message ?? error);
        promptDispose = null;
      }
    }
    warn(`dsh-gui-agent: agent control tools registered (${COMPUTER_TOOL_NAMES.join(', ')})`);
  }

  function unregisterAll() {
    if (promptDispose) {
      try {
        promptDispose();
      } catch {
        /* ignore */
      }
      promptDispose = null;
    }
    if (toolDisposers) {
      for (const dispose of toolDisposers.reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      toolDisposers = null;
    }
    registered = false;
    if (bridge) {
      bridge.dispose();
      bridge = null;
    }
  }

  function syncRegistrations() {
    const any = sessions.size > 0;
    if (any && !registered) registerAll();
    else if (!any && registered) unregisterAll();
  }

  function setEnabled(sessionId, enabled) {
    const previous = sessions.get(sessionId);
    if (enabled) sessions.set(sessionId, Date.now());
    else sessions.delete(sessionId);
    try {
      syncRegistrations();
    } catch (error) {
      if (previous === undefined) sessions.delete(sessionId);
      else sessions.set(sessionId, previous);
      throw error;
    }
    store.setSession(sessionId, enabled);
    return enabled;
  }

  function authorize(req, res) {
    const connection = ctx.get('connection');
    if (!connection) {
      sendJson(res, 403, { error: 'the connection service is unavailable' });
      return false;
    }
    let rejection;
    try {
      rejection = connection.requestRejection({ headers: req.headers });
    } catch (error) {
      warn('dsh-gui-agent: request admission failed', error?.message ?? error);
      rejection = 403;
    }
    if (rejection !== undefined) {
      sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
      return false;
    }
    return true;
  }

  function stateBody(sessionId) {
    let accounts = 0;
    let queue = 0;
    try {
      accounts = store.accounts().length;
      queue = store.queue().length;
    } catch {
      /* state must never break the toggle */
    }
    return {
      enabled: isEnabled(sessionId),
      pace: paceOf(sessionId),
      slowdown: slowdownOf(sessionId),
      platform: process.platform,
      bridge: bridge !== null,
      tools: COMPUTER_TOOL_NAMES,
      accounts,
      queue,
    };
  }

  async function handleState(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!authorize(req, res)) return;
    try {
      const url = new URL(req.url ?? ROUTE_BASE, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId') ?? '';
      sendJson(res, 200, stateBody(sessionId));
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? 'bad request' });
    }
  }

  async function handleToggle(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!authorize(req, res)) return;
    try {
      const text = await readBody(req);
      const payload = JSON.parse(text || '{}');
      const sessionId = payload?.sessionId;
      const enabled = payload?.enabled;
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
        sendJson(res, 400, { error: 'sessionId is required' });
        return;
      }
      if (typeof enabled !== 'boolean') {
        sendJson(res, 400, { error: 'enabled must be a boolean' });
        return;
      }
      if (process.platform !== 'win32') {
        sendJson(res, 409, { error: 'agent control is only available on Windows' });
        return;
      }
      setEnabled(sessionId, enabled);
      sendJson(res, 200, stateBody(sessionId));
    } catch (error) {
      sendJson(res, 500, { error: error?.message ?? 'could not update agent control' });
    }
  }

  async function handlePace(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    if (!authorize(req, res)) return;
    try {
      const text = await readBody(req);
      const payload = JSON.parse(text || '{}');
      const sessionId = payload?.sessionId;
      const pace = payload?.pace;
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
        sendJson(res, 400, { error: 'sessionId is required' });
        return;
      }
      if (pace !== 'human' && pace !== 'fast' && pace !== 'custom') {
        sendJson(res, 400, { error: "pace must be 'human', 'fast' or 'custom'" });
        return;
      }
      store.setPace(sessionId, pace);
      if (pace === 'custom' && payload?.slowdown !== undefined) {
        const slowdown = Number(payload.slowdown);
        if (!Number.isFinite(slowdown) || slowdown < 0.2 || slowdown > 8) {
          sendJson(res, 400, { error: 'slowdown must be a number between 0.2 and 8' });
          return;
        }
        store.setSlowdown(sessionId, slowdown);
      }
      sendJson(res, 200, stateBody(sessionId));
    } catch (error) {
      sendJson(res, 400, { error: error?.message ?? 'bad request' });
    }
  }

  // Wait for the web server instead of capturing it at apply time: on a fresh
  // boot the plugin can be applied before the webServer service exists, and a
  // captured `undefined` would leave the composer toggle with a 404 forever.
  ctx.inject(['webServer'], (webCtx) => {
    const ws = (() => {
      try {
        return webCtx.webServer ?? webCtx.get('webServer');
      } catch {
        return undefined;
      }
    })();
    if (!ws) {
      warn('dsh-gui-agent: injected webServer is unavailable; the composer toggle cannot reach the host');
      return;
    }
    webCtx.effect(
      () => ws.register({ kind: 'exact', path: `${ROUTE_BASE}/state`, handler: handleState }),
      'dsh-gui-agent: state route',
    );
    webCtx.effect(
      () => ws.register({ kind: 'exact', path: `${ROUTE_BASE}/toggle`, handler: handleToggle }),
      'dsh-gui-agent: toggle route',
    );
    webCtx.effect(
      () => ws.register({ kind: 'exact', path: `${ROUTE_BASE}/pace`, handler: handlePace }),
      'dsh-gui-agent: pace route',
    );
    warn(`dsh-gui-agent: routes registered on ${ws.getOrigin?.() ?? 'the web server'}`);
  });

  ctx.effect(() => () => {
    disposed = true;
    unregisterAll();
    sessions.clear();
    void store.dispose();
  });

  warn(`dsh-gui-agent: ready (state: ${store.file})`);
}
