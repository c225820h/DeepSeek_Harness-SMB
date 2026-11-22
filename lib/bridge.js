/**
 * Node side of the SMB worker bridge.
 *
 * Why a subprocess: the pure-JS SMB client authenticate fine against this
 * Samba share but had every directory query refused, while `smbprotocol` —
 * the Samba-side reference implementation — lists it immediately. Rather than
 * reimplement MS-SMB2 directory enumeration, one short-lived worker process
 * performs each read and the Host only shapes the answer.
 *
 * Credentials travel on stdin, never argv or the environment, so a password
 * cannot be read back out of `ps` or `/proc/<pid>/environ`.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER = join(PLUGIN_ROOT, 'lib', 'smb_worker.py');
const VENV_PYTHON = join(PLUGIN_ROOT, '.venv', 'bin', 'python');
/** One directory listing is small; reading a whole file is unbounded by nature. */
const JSON_TIMEOUT_MS = 45000;

/** A refusal the HTTP layer can render, carrying the worker's own classification. */
export class WorkerError extends Error {
	constructor(code, message, status) {
		super(message);
		this.code = code;
		this.status = status;
	}

	/** HTTP status for this failure class. */
	get httpStatus() {
		switch (this.code) {
			case 'auth_failed': return 401;
			case 'denied': return 403;
			case 'no_such_share':
			case 'not_found': return 404;
			case 'wrong_type':
			case 'bad_settings':
			case 'bad_op':
			case 'bad_invocation': return 400;
			default: return 502;
		}
	}
}

/** Resolve the interpreter that has `smbprotocol` installed. */
async function interpreter() {
	try {
		await access(VENV_PYTHON);
		return VENV_PYTHON;
	} catch {
		throw new WorkerError('worker_missing', `插件自带的 Python 环境不见了：${VENV_PYTHON}（在该目录执行 python3 -m venv .venv && .venv/bin/pip install smbprotocol）`);
	}
}

/** Spawn one worker with its settings on stdin. */
async function spawnWorker(op, settings) {
	const python = await interpreter();
	const child = spawn(python, [WORKER, op], { stdio: ['pipe', 'pipe', 'pipe'] });
	child.stdin.on('error', () => {});
	child.stdin.end(JSON.stringify(settings));
	return child;
}

/** Read one worker to completion, returning stdout bytes and parsing stderr on failure. */
function collect(child, timeoutMs) {
	return new Promise((resolve, reject) => {
		const out = [];
		const err = [];
		let settled = false;
		const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill('SIGKILL');
			reject(new WorkerError('timeout', 'SMB 服务在超时内没有回应'));
		}, timeoutMs);
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			fn(value);
		};
		child.stdout.on('data', (chunk) => out.push(chunk));
		child.stderr.on('data', (chunk) => err.push(chunk));
		child.on('error', (error) => finish(reject, new WorkerError('worker_failed', `启动 SMB worker 失败：${error.message}`)));
		child.on('close', (code) => {
			if (code === 0) {
				finish(resolve, { stdout: Buffer.concat(out), stderr: '' });
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(err).toString('utf8'));
			} catch {
				parsed = undefined;
			}
			const message = typeof parsed?.message === 'string' && parsed.message.length > 0
				? parsed.message
				: Buffer.concat(err).toString('utf8').trim() || `SMB worker 退出码 ${code}`;
			finish(reject, new WorkerError(typeof parsed?.code === 'string' ? parsed.code : 'smb_error', message, parsed?.status));
		});
	});
}

/**
 * Run one JSON-producing operation.
 * @param {'list'|'stat'} op - worker operation.
 * @param {object} settings - host, port, domain, username, password, share, path.
 * @returns {Promise<any>} the worker's parsed stdout.
 */
export async function runJson(op, settings) {
	const child = await spawnWorker(op, settings);
	const { stdout } = await collect(child, JSON_TIMEOUT_MS);
	try {
		return JSON.parse(stdout.toString('utf8'));
	} catch {
		throw new WorkerError('bad_worker_output', 'SMB worker 返回了无法解析的内容');
	}
}

/**
 * Stream one file's bytes.
 * @param {object} settings - as {@link runJson}, with `path` naming the file.
 * @returns {Promise<{stream: import('node:stream').Readable, done: Promise<void>}>} byte source plus its settlement.
 */
export async function openRead(settings) {
	const child = await spawnWorker('read', settings);
	let failure = '';
	child.stderr.on('data', (chunk) => { failure += chunk.toString('utf8'); });
	const done = new Promise((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(failure);
			} catch {
				parsed = undefined;
			}
			reject(new WorkerError(typeof parsed?.code === 'string' ? parsed.code : 'smb_error', typeof parsed?.message === 'string' ? parsed.message : `SMB worker 退出码 ${code}`, parsed?.status));
		});
	});
	// A consumer that stops early (a closed tab) must not leave the reader hung.
	done.catch(() => {});
	return { stream: child.stdout, done, kill: () => child.kill('SIGKILL') };
}
