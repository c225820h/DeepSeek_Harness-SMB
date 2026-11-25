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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findPython, missingPythonMessage } from './python.js';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER = join(PLUGIN_ROOT, 'lib', 'smb_worker.py');
/** One directory listing is small; reading a whole file is unbounded by nature. */

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
	const found = await findPython();
	if (found.python) return found.python;
	throw new WorkerError('worker_missing', missingPythonMessage(found.missing));
}

/** Spawn one worker with its settings on stdin. */
async function spawnWorker(op, settings) {
	const python = await interpreter();
	const child = spawn(python, [WORKER, op], { stdio: ['pipe', 'pipe', 'pipe'] });
	child.stdin.on('error', () => {});
	child.stdin.end(JSON.stringify(settings));
	return child;
}

/**
 * Stream one file's bytes.
 * @param {object} settings - connection identity plus the file path inside the share.
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
