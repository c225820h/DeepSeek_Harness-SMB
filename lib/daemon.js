/**
 * One authenticated SMB session, many requests.
 *
 * `smb_worker.py` pays process start plus an NTLMv2 handshake per call — about
 * 1.1 s for a thumbnail. This daemon authenticates once and answers requests
 * over a line-oriented pipe, so the per-request cost collapses to the decode.
 *
 * The protocol is deliberately tiny and strictly serial: requests are queued,
 * written one at a time, and the reader is a small state machine that knows
 * whether the next bytes are a JSON line or a counted binary payload. No
 * request concurrency is lost by this — SMB would serialize on one session
 * anyway, and the Host's routes are independent HTTP requests.
 *
 * Deliberate limits: streaming an original file does NOT come through here (it
 * would block every other request for the length of the transfer), and an idle
 * daemon is closed so a share is never held open indefinitely.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerError } from './bridge.js';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAEMON = join(PLUGIN_ROOT, 'lib', 'smb_daemon.py');
const VENV_PYTHON = join(PLUGIN_ROOT, '.venv', 'bin', 'python');
/** One request may decode a large image; keep the ceiling well above that. */
const REQUEST_TIMEOUT_MS = 60000;
const STARTUP_TIMEOUT_MS = 20000;
/** Close an idle session so the share is not held open forever. */
const IDLE_CLOSE_MS = 5 * 60 * 1000;
/**
 * A session that died under us — killed, OOM, a crashed interpreter — is worth
 * exactly one silent retry: the next call starts a fresh process, and a request
 * that lost its process should not surface as an error the user has to dismiss.
 */
const RETRYABLE = new Set(['daemon_exited', 'daemon_failed', 'daemon_closed', 'bad_daemon_output']);

/** One queued call waiting for its answer. */
class Pending {
	constructor(id, wantsBinary, resolve, reject) {
		this.id = id;
		this.wantsBinary = wantsBinary;
		this.resolve = resolve;
		this.reject = reject;
		this.timer = undefined;
	}
}

/**
 * A lazily started, automatically restarted daemon for one connection.
 */
export class SmbDaemon {
	#settings;
	#child = null;
	#queue = [];
	#pending = null;
	#buffer = Buffer.alloc(0);
	#binaryRemaining = 0;
	#binaryFor = null;
	#binaryChunks = [];
	#nextId = 1;
	#idleTimer = undefined;
	#starting = null;
	#closed = false;

	/** @param {object} settings - host, port, domain, username, password, share. */
	constructor(settings) {
		this.#settings = settings;
	}

	/** Resolve the interpreter, refusing clearly when the venv is gone. */
	static async #interpreter() {
		try {
			await access(VENV_PYTHON);
			return VENV_PYTHON;
		} catch {
			throw new WorkerError('worker_missing', `插件自带的 Python 环境不见了：${VENV_PYTHON}`);
		}
	}

	/** Start the daemon if it is not already running, and wait for its ready line. */
	async #ensure() {
		if (this.#closed) throw new WorkerError('daemon_closed', 'SMB 会话已关闭');
		if (this.#child !== null) return;
		if (this.#starting !== null) {
			await this.#starting;
			return;
		}
		this.#starting = this.#start();
		try {
			await this.#starting;
		} finally {
			this.#starting = null;
		}
	}

	/** Spawn and authenticate, resolving once the daemon reports ready. */
	async #start() {
		const python = await SmbDaemon.#interpreter();
		const child = spawn(python, [DAEMON], { stdio: ['pipe', 'pipe', 'pipe'] });
		this.#child = child;
		this.#buffer = Buffer.alloc(0);
		this.#binaryRemaining = 0;
		this.#binaryFor = null;

		let stderr = '';
		child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
		child.stdout.on('data', (chunk) => this.#ingest(chunk));
		child.stdin.on('error', () => {});
		child.on('close', () => this.#teardown(new WorkerError('daemon_exited', stderr.trim() || 'SMB 会话进程退出了')));
		child.on('error', (error) => this.#teardown(new WorkerError('daemon_failed', `启动 SMB 会话失败：${error.message}`)));

		// The first line carries the credentials; everything after it is requests.
		child.stdin.write(`${JSON.stringify(this.#settings)}\n`);

		await new Promise((resolve, reject) => {
			// The process may already be gone (a missing interpreter fails in
			// milliseconds); resolving on that instead of waiting out the timer is
			// the difference between "no such file" and a 20-second silence.
			if (this.#child === null) {
				reject(new WorkerError('daemon_failed', stderr.trim() || 'SMB 会话进程没有起来'));
				return;
			}
			const timer = setTimeout(() => reject(new WorkerError('timeout', 'SMB 会话启动超时')), STARTUP_TIMEOUT_MS);
			const settle = (fn, value) => {
				clearTimeout(timer);
				fn(value);
			};
			this.#awaitReady = (payload) => settle(payload.ok ? resolve : reject, payload.ok ? undefined : new WorkerError(payload.code ?? 'auth_failed', payload.message ?? '认证失败', payload.status));
		});
		this.#awaitReady = null;
	}

	/** Callback installed while the startup handshake is in flight. */
	#awaitReady = null;

	/** Feed bytes into the response state machine. */
	#ingest(chunk) {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			if (this.#binaryRemaining > 0) {
				const take = Math.min(this.#binaryRemaining, this.#buffer.length);
				if (take === 0) return;
				this.#binaryChunks.push(this.#buffer.subarray(0, take));
				this.#buffer = this.#buffer.subarray(take);
				this.#binaryRemaining -= take;
				if (this.#binaryRemaining === 0) this.#settleBinary();
				continue;
			}
			const newline = this.#buffer.indexOf(0x0a);
			if (newline < 0) return;
			const line = this.#buffer.subarray(0, newline).toString('utf8');
			this.#buffer = this.#buffer.subarray(newline + 1);
			let payload;
			try {
				payload = JSON.parse(line);
			} catch {
				this.#teardown(new WorkerError('bad_daemon_output', 'SMB 会话返回了无法解析的内容'));
				return;
			}
			this.#handleLine(payload);
		}
	}

	/** Act on one decoded header line. */
	#handleLine(payload) {
		if (this.#awaitReady !== null) {
			this.#awaitReady(payload);
			return;
		}
		const pending = this.#pending;
		if (pending === null) return;
		if (typeof payload.size === 'number' && payload.size >= 0) {
			this.#binaryFor = pending;
			this.#binaryRemaining = payload.size;
			this.#binaryChunks = [];
			return;
		}
		this.#settle(pending, payload);
	}

	/** Finish a counted binary payload. */
	#settleBinary() {
		const pending = this.#binaryFor;
		this.#binaryFor = null;
		if (pending === null) return;
		this.#settle(pending, null, Buffer.concat(this.#binaryChunks));
	}

	/** Resolve or reject one pending request and start the next. */
	#settle(pending, payload, bytes) {
		if (pending.timer !== undefined) clearTimeout(pending.timer);
		this.#pending = null;
		if (payload !== null && payload.ok !== true) {
			pending.reject(new WorkerError(payload.code ?? 'smb_error', payload.message ?? 'SMB 操作失败', payload.status));
		} else if (bytes !== undefined) {
			pending.resolve(bytes);
		} else {
			pending.resolve(payload?.json ?? {});
		}
		this.#pump();
	}

	/** Send the next queued request if the pipe is free. */
	#pump() {
		if (this.#pending !== null || this.#queue.length === 0 || this.#child === null) return;
		const next = this.#queue.shift();
		this.#pending = next;
		next.timer = setTimeout(() => {
			// A daemon that stopped answering cannot be trusted with the next
			// request either: tear it down so the following call starts fresh.
			this.#teardown(new WorkerError('timeout', 'SMB 会话在超时内没有回应'));
		}, REQUEST_TIMEOUT_MS);
		this.#child.stdin.write(`${JSON.stringify(next.payload)}\n`);
	}

	/** Fail everything in flight and forget the process. */
	#teardown(error) {
		const child = this.#child;
		this.#child = null;
		if (child !== null) {
			child.stdout.removeAllListeners();
			child.stderr.removeAllListeners();
			child.removeAllListeners();
			child.kill('SIGKILL');
		}
		const pending = this.#pending;
		this.#pending = null;
		if (pending !== null) {
			if (pending.timer !== undefined) clearTimeout(pending.timer);
			pending.reject(error);
		}
		const queued = this.#queue;
		this.#queue = [];
		for (const item of queued) item.reject(error);
		this.#buffer = Buffer.alloc(0);
		this.#binaryRemaining = 0;
		this.#binaryFor = null;
		this.#binaryChunks = [];
		if (this.#awaitReady !== null) {
			const ready = this.#awaitReady;
			this.#awaitReady = null;
			ready({ ok: false, code: error.code, message: error.message });
		}
	}

	/** Note activity so the idle timer does not close a session in use. */
	#touch() {
		if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			void this.dispose();
		}, IDLE_CLOSE_MS);
		this.#idleTimer.unref?.();
	}

	/**
	 * Run one JSON request.
	 * @param {'list'|'stat'} op - daemon operation.
	 * @param {object} [params] - `path` and any op-specific fields.
	 * @returns {Promise<object>} the daemon's JSON answer.
	 */
	async json(op, params = {}) {
		return this.#call(op, params, false, true);
	}

	/**
	 * Run one binary request.
	 * @param {'thumb'} op - daemon operation.
	 * @param {object} params - `path` and `width`.
	 * @returns {Promise<Buffer>} the produced bytes.
	 */
	async bytes(op, params = {}) {
		return this.#call(op, params, true, true);
	}

	/** Run one request, restarting a dead session once. */
	async #call(op, params, wantsBinary, mayRetry) {
		try {
			return await this.#enqueue({ op, ...params }, wantsBinary);
		} catch (error) {
			if (!mayRetry || !RETRYABLE.has(error?.code)) throw error;
			await this.dispose();
			return this.#call(op, params, wantsBinary, false);
		}
	}

	/** Queue one request behind any in-flight work. */
	#enqueue(payload, wantsBinary) {
		this.#touch();
		return new Promise((resolve, reject) => {
			const entry = new Pending(this.#nextId++, wantsBinary, resolve, reject);
			entry.payload = { id: entry.id, ...payload };
			this.#queue.push(entry);
			void this.#ensure().then(() => this.#pump()).catch((error) => {
				const index = this.#queue.indexOf(entry);
				if (index >= 0) this.#queue.splice(index, 1);
				reject(error);
			});
		});
	}

	/** Close the session; the next request starts a new one. */
	async dispose() {
		if (this.#idleTimer !== undefined) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		this.#teardown(new WorkerError('daemon_closed', 'SMB 会话已关闭'));
	}
}
