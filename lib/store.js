/**
 * Durable plugin state: enabled sessions, the window↔account mapping, download
 * baselines and the batch prompt queue.
 *
 * Stored at %LOCALAPPDATA%\dsh-gui-agent\state.json (the plugin's `storeDir`
 * config overrides the directory). Writes are debounced and atomic; every
 * failure is logged and swallowed so a read-only disk never breaks the tools.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultStoreDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'dsh-gui-agent');
}

function emptyState() {
  return { version: 1, sessions: {}, paces: {}, slowdowns: {}, accounts: {}, downloads: {}, queue: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sanitize(raw) {
  const state = emptyState();
  const sessions = asObject(raw.sessions);
  for (const [id, seen] of Object.entries(sessions)) {
    if (typeof id === 'string' && typeof seen === 'number' && Number.isFinite(seen)) state.sessions[id] = seen;
  }
  const paces = asObject(raw.paces);
  for (const [id, pace] of Object.entries(paces)) {
    if (typeof id === 'string' && (pace === 'human' || pace === 'fast' || pace === 'custom')) state.paces[id] = pace;
  }
  const slowdowns = asObject(raw.slowdowns);
  for (const [id, value] of Object.entries(slowdowns)) {
    if (typeof id !== 'string') continue;
    const slowdown = typeof value === 'number' && Number.isFinite(value) ? value : 1;
    state.slowdowns[id] = Math.min(8, Math.max(0.2, slowdown));
  }
  const accounts = asObject(raw.accounts);
  for (const [label, entry] of Object.entries(accounts)) {
    if (typeof label !== 'string' || label.length === 0) continue;
    const titleMatch = typeof entry?.titleMatch === 'string' ? entry.titleMatch : '';
    if (titleMatch.length === 0) continue;
    state.accounts[label] = {
      titleMatch,
      addedAt: typeof entry?.addedAt === 'number' ? entry.addedAt : 0,
    };
  }
  const downloads = asObject(raw.downloads);
  for (const [account, entry] of Object.entries(downloads)) {
    if (typeof account !== 'string') continue;
    const baseline = Array.isArray(entry?.baseline) ? entry.baseline.filter((name) => typeof name === 'string') : [];
    state.downloads[account] = {
      baseline,
      capturedAt: typeof entry?.capturedAt === 'number' ? entry.capturedAt : 0,
    };
  }
  if (Array.isArray(raw.queue)) {
    for (const item of raw.queue) {
      const prompt = typeof item?.prompt === 'string' ? item.prompt : '';
      if (prompt.length === 0) continue;
      state.queue.push({
        id: typeof item?.id === 'string' && item.id.length > 0 ? item.id : `q-${Date.now().toString(36)}-${state.queue.length}`,
        account: typeof item?.account === 'string' ? item.account : '',
        prompt,
        status: ['pending', 'running', 'done', 'failed'].includes(item?.status) ? item.status : 'pending',
        createdAt: typeof item?.createdAt === 'number' ? item.createdAt : Date.now(),
        updatedAt: typeof item?.updatedAt === 'number' ? item.updatedAt : Date.now(),
        note: typeof item?.note === 'string' ? item.note : '',
      });
    }
  }
  return state;
}

export class StateStore {
  #file;
  #logger;
  #state = emptyState();
  #timer = null;
  #writing = null;
  #closed = false;

  constructor({ dir = defaultStoreDir(), file, logger } = {}) {
    this.#file = file ?? path.join(dir, 'state.json');
    this.#logger = logger;
  }

  get file() {
    return this.#file;
  }

  get dir() {
    return path.dirname(this.#file);
  }

  async load() {
    try {
      const text = await fsp.readFile(this.#file, 'utf8');
      const parsed = JSON.parse(text);
      this.#state = sanitize(parsed);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger?.warn?.(`dsh-gui-agent: could not load ${this.#file} (${error?.message ?? error}); starting empty`);
      }
    }
    return this;
  }

  snapshot() {
    return clone(this.#state);
  }

  /* ── sessions ─────────────────────────────────────────────── */

  sessionIds() {
    return Object.keys(this.#state.sessions);
  }

  sessionSeen(sessionId) {
    return typeof this.#state.sessions[sessionId] === 'number' ? this.#state.sessions[sessionId] : 0;
  }

  setSession(sessionId, enabled) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (enabled) this.#state.sessions[sessionId] = Date.now();
    else delete this.#state.sessions[sessionId];
    this.#schedule();
  }

  /** Drops expired entries; returns the session ids that are still valid. */
  pruneSessions(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    let changed = false;
    for (const [id, seen] of Object.entries(this.#state.sessions)) {
      if (seen < cutoff) {
        delete this.#state.sessions[id];
        delete this.#state.paces[id];
        delete this.#state.slowdowns[id];
        changed = true;
      }
    }
    if (changed) this.#schedule();
    return this.sessionIds();
  }

  /* ── input pace ───────────────────────────────────────────── */

  paceOf(sessionId) {
    const pace = this.#state.paces[sessionId];
    return pace === 'fast' || pace === 'custom' ? pace : 'human';
  }

  slowdownOf(sessionId) {
    const value = this.#state.slowdowns[sessionId];
    return typeof value === 'number' ? value : 1;
  }

  setPace(sessionId, pace) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 'human';
    if (pace === 'fast' || pace === 'custom') this.#state.paces[sessionId] = pace;
    else delete this.#state.paces[sessionId];
    this.#schedule();
    return this.paceOf(sessionId);
  }

  setSlowdown(sessionId, value) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 1;
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 1;
    this.#state.slowdowns[sessionId] = Math.min(8, Math.max(0.2, numeric));
    this.#schedule();
    return this.slowdownOf(sessionId);
  }

  /* ── accounts ─────────────────────────────────────────────── */

  accounts() {
    return Object.entries(this.#state.accounts)
      .map(([label, entry]) => ({ label, titleMatch: entry.titleMatch, addedAt: entry.addedAt }))
      .sort((a, b) => a.addedAt - b.addedAt);
  }

  setAccount(label, titleMatch) {
    if (typeof label !== 'string' || label.trim().length === 0) throw new Error('label is required');
    if (label.length > 64) throw new Error('label is longer than 64 characters');
    if (typeof titleMatch !== 'string' || titleMatch.trim().length === 0) throw new Error('titleMatch is required');
    if (titleMatch.length > 200) throw new Error('titleMatch is longer than 200 characters');
    const key = label.trim();
    const existing = this.#state.accounts[key];
    this.#state.accounts[key] = { titleMatch: titleMatch.trim(), addedAt: existing?.addedAt ?? Date.now() };
    this.#schedule();
    return this.accounts();
  }

  removeAccount(label) {
    const key = typeof label === 'string' ? label.trim() : '';
    if (!key || !(key in this.#state.accounts)) return { removed: false, accounts: this.accounts() };
    delete this.#state.accounts[key];
    delete this.#state.downloads[key];
    this.#schedule();
    return { removed: true, accounts: this.accounts() };
  }

  /** Accounts whose titleMatch occurs in `title`. */
  matchAccounts(title) {
    const haystack = String(title ?? '').toLowerCase();
    return this.accounts().filter((account) => account.titleMatch.toLowerCase() && haystack.includes(account.titleMatch.toLowerCase()));
  }

  /* ── downloads ────────────────────────────────────────────── */

  downloadBaseline(account) {
    return this.#state.downloads[account]?.baseline ?? null;
  }

  setDownloadBaseline(account, baseline) {
    if (typeof account !== 'string' || account.length === 0) return;
    this.#state.downloads[account] = {
      baseline: Array.isArray(baseline) ? baseline.filter((name) => typeof name === 'string') : [],
      capturedAt: Date.now(),
    };
    this.#schedule();
  }

  /* ── queue ────────────────────────────────────────────────── */

  queue() {
    return clone(this.#state.queue);
  }

  addQueue(items) {
    const list = Array.isArray(items) ? items : [items];
    const added = [];
    for (const item of list) {
      const prompt = typeof item?.prompt === 'string' ? item.prompt.trim() : '';
      if (prompt.length === 0) throw new Error('every queue item needs a prompt');
      if (prompt.length > 2000) throw new Error('a prompt is longer than 2000 characters');
      const entry = {
        id: `q-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
        account: typeof item?.account === 'string' ? item.account.trim() : '',
        prompt,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        note: '',
      };
      this.#state.queue.push(entry);
      added.push(entry);
    }
    this.#schedule();
    return added;
  }

  queueNext() {
    const item = this.#state.queue.find((entry) => entry.status === 'pending');
    if (!item) return null;
    item.status = 'running';
    item.updatedAt = Date.now();
    this.#schedule();
    return clone(item);
  }

  finishQueue(id, status, note = '') {
    const item = this.#state.queue.find((entry) => entry.id === id);
    if (!item) return null;
    if (!['done', 'failed', 'pending'].includes(status)) throw new Error(`unsupported queue status: ${String(status)}`);
    item.status = status;
    item.note = typeof note === 'string' ? note.slice(0, 500) : '';
    item.updatedAt = Date.now();
    this.#schedule();
    return clone(item);
  }

  clearQueue(status) {
    const before = this.#state.queue.length;
    this.#state.queue = typeof status === 'string' ? this.#state.queue.filter((entry) => entry.status !== status) : [];
    this.#schedule();
    return before - this.#state.queue.length;
  }

  /* ── persistence ──────────────────────────────────────────── */

  #schedule() {
    if (this.#closed) return;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, 250);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  async flush() {
    if (this.#closed) return false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const run = async () => {
      const text = `${JSON.stringify(this.#state, null, 2)}\n`;
      try {
        await fsp.mkdir(this.dir, { recursive: true });
        const tmp = `${this.#file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, text, 'utf8');
        await fsp.rename(tmp, this.#file);
        return true;
      } catch (error) {
        this.#logger?.warn?.(`dsh-gui-agent: could not save ${this.#file}: ${error?.message ?? error}`);
        return false;
      }
    };
    const next = (this.#writing ?? Promise.resolve()).then(run, run);
    this.#writing = next.catch(() => false);
    return next;
  }

  async dispose() {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#closed = false;
    await this.flush();
    this.#closed = true;
    try {
      await this.#writing;
    } catch {
      /* ignore */
    }
  }
}
