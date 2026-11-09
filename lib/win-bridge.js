/**
 * Persistent PowerShell worker bridge.
 *
 * Spawns helper/computer.ps1 once and speaks JSON lines with it:
 *   host  -> {"id": <n>, "op": "<name>", "args": {...}}
 *   helper-> {"id": <n>, "ok": true,  "result": ...}
 *          | {"id": <n>, "ok": false, "error": "<message>"}
 *
 * Calls are serialized through a promise chain because the helper is a single
 * stdin loop. The child is killed on timeout or unexpected exit and restarted
 * on the next call, so a wedged helper cannot poison later operations.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HELPER_PATH = fileURLToPath(new URL('../helper/computer.ps1', import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;

function resolvePowerShell() {
  if (process.platform !== 'win32') return null;
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export class WinBridge {
  constructor(options = {}) {
    this.logger = options.logger ?? null;
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.stderrTail = '';
    this.disposed = false;
  }

  get running() {
    return this.child !== null;
  }

  async start() {
    if (this.disposed) throw new Error('agent bridge has been disposed');
    if (this.child) return;
    const exe = resolvePowerShell();
    if (!exe) throw new Error('agent control requires Windows');

    const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PATH], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.#onStderr(chunk));
    child.on('error', (error) => this.#failAll(`agent helper failed to start: ${error.message}`));
    child.on('exit', (code, signal) => {
      this.child = null;
      this.#failAll(`agent helper exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`);
    });
  }

  /** Run one helper operation. Serialized with every other call. */
  async call(op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const run = async () => {
      await this.start();
      return this.#request(op, args, timeoutMs);
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  dispose() {
    this.disposed = true;
    this.#failAll('agent bridge disposed');
    this.#kill();
  }

  #kill() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  #request(op, args, timeoutMs) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('agent helper is not running'));
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, op, args })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.#kill();
        reject(new Error(`agent helper timed out after ${timeoutMs}ms (op=${op})`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        child.stdin.write(payload, 'utf8', (error) => {
          if (!error) return;
          const entry = this.pending.get(id);
          this.pending.delete(id);
          if (entry) entry.reject(new Error(`agent helper write failed: ${error.message}`));
        });
      } catch (error) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        if (entry) entry.reject(new Error(`agent helper write failed: ${error.message}`));
      }
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.#onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger?.warn?.(`agent helper produced non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(typeof message.error === 'string' && message.error ? message.error : 'agent helper operation failed'));
  }

  #onStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk).slice(-4096);
  }

  #failAll(reason) {
    const suffix = this.stderrTail.trim() ? ` :: ${this.stderrTail.trim().slice(-600)}` : '';
    for (const [, entry] of this.pending) entry.reject(new Error(`${reason}${suffix}`));
    this.pending.clear();
  }
}
