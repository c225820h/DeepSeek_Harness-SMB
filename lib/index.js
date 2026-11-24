/**
 * HOST half of dsh-smb-picker.
 *
 * Four exact Fetch routes on Connection's authenticated `/api` channel: the
 * share browser runs on the machine DSH itself runs on, so a phone never has
 * to speak SMB — it asks this Host to list a directory or stream one file and
 * then hands the bytes to the composer through the ordinary attachment path.
 *
 * Trust boundary: Connection applies its Host/Origin fence and browser
 * authentication before any handler here runs, so the routes carry no auth of
 * their own. They are read-only apart from the connection table below, where
 * the single mutation is local credential bookkeeping — no route accepts a
 * filesystem path, a mount, or a remote write.
 *
 * SMB is spoken by `smb3-client` (pure ESM, no native bindings, no kernel CIFS
 * module), so this works on a Host with neither `smbclient` nor `mount.cifs`.
 */

import { appendFile, chmod, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Client } from 'smb3-client';
import { WorkerError, openRead } from './bridge.js';
import { SmbDaemon } from './daemon.js';

export const name = 'smb-picker';
export const inject = ['connection'];

/** Route table. Each entry is an exact path below `/api`. */
const ROUTES = {
	connections: '/api/smb-picker.connections',
	shares: '/api/smb-picker.shares',
	list: '/api/smb-picker.list',
	raw: '/api/smb-picker.raw',
	thumb: '/api/smb-picker.thumb',
};

/** Idle pooled connections are closed after this long. */
const POOL_IDLE_MS = 5 * 60 * 1000;
/** One directory listing is capped; a hostile share cannot stream forever. */
const MAX_ENTRIES = 4000;
const CONNECT_TIMEOUT_MS = 8000;
/** Grid thumbnails live on disk so a second visit costs no SMB round trip at all. */
const THUMB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const THUMB_SWEEP_AT = 2000;
const THUMB_SWEEP_KEEP = 1500;
const THUMB_WIDTH_MIN = 96;
const THUMB_WIDTH_MAX = 1024;
const REQUEST_TIMEOUT_MS = 30000;

const MIME_BY_EXTENSION = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.bmp': 'image/bmp',
	'.avif': 'image/avif',
	'.svg': 'image/svg+xml',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.txt': 'text/plain; charset=utf-8',
	'.json': 'application/json',
	'.pdf': 'application/pdf',
};

/** `$DSH_HOME` (or `~/.dsh`) — the same home the rest of the profile writes to. */
function configPath() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
		? process.env.DSH_HOME
		: join(homedir(), '.dsh');
	return join(home, 'smb-picker.json');
}

/** Reject traversal, NUL, and control characters before they reach the share. */
function assertRelativePath(path) {
	if (path.includes('\0') || /[\u0000-\u001f]/.test(path)) throw new RequestError(400, 'bad_path', 'path contains control characters');
	for (const segment of path.split('/')) {
		if (segment === '..') throw new RequestError(400, 'bad_path', 'path may not traverse upward');
	}
}

/** One path inside the share: the configured subdirectory plus the request. */
function relPathOf(connection, relative) {
	return [connection.path ?? '', relative]
		.map((part) => part.replace(/^\/+|\/+$/g, ''))
		.filter((part) => part.length > 0)
		.join('/');
}

/** Full worker settings, for the one-shot process that streams an original file. */
function settingsOf(connection, relative) {
	return {
		host: connection.host,
		port: connection.port ?? 445,
		domain: connection.domain ?? '',
		username: connection.username,
		password: connection.password,
		share: connection.share,
		path: relPathOf(connection, relative),
	};
}

/**
 * Newest first inside each group, directories ahead of files.
 *
 * Directories keep their own group: on a share whose root mixes folders with
 * output files, letting a fresh file jump above every folder makes the folders
 * unreachable without scrolling. Everything else sorts by modification time,
 * which is what "show me the picture I just made" actually means.
 */
function compareEntries(left, right) {
	if (left.directory !== right.directory) return left.directory ? -1 : 1;
	const leftTime = Number.isFinite(left.mtime) ? left.mtime : 0;
	const rightTime = Number.isFinite(right.mtime) ? right.mtime : 0;
	if (leftTime !== rightTime) return rightTime - leftTime;
	return left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

/** A refusal the HTTP layer can render without guessing at SMB internals. */
class RequestError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** JSON response helper. */
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

/** Directory holding cached grid thumbnails. */
function thumbDir() {
	return join(dirname(configPath()), 'cache', 'smb-thumbs');
}

/** One thumbnail's cache path: the request identity, hashed, so any filename is safe. */
function thumbPath(key) {
	return join(thumbDir(), `${createHash('sha1').update(key).digest('hex')}.webp`);
}

/** Age out and trim the cache so it cannot grow without bound. */
async function sweepThumbs() {
	const dir = thumbDir();
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	if (names.length < THUMB_SWEEP_AT) return;
	const rows = [];
	for (const name of names) {
		try {
			rows.push({ name, mtime: (await stat(join(dir, name))).mtimeMs });
		} catch {
			// A file that vanished mid-sweep needs no entry.
		}
	}
	rows.sort((left, right) => right.mtime - left.mtime);
	for (const row of rows.slice(THUMB_SWEEP_KEEP)) {
		await unlink(join(dir, row.name)).catch(() => {});
	}
}

/**
 * Serve one thumbnail from disk, or build it once and keep it.
 * @param {string} key - connection id, path, and width.
 * @param {() => Promise<Buffer>} build - producer used on a miss.
 * @returns {Promise<Buffer>} WebP bytes.
 */
async function cachedThumb(key, build) {
	const file = thumbPath(key);
	try {
		const cached = await stat(file);
		if (Date.now() - cached.mtimeMs < THUMB_MAX_AGE_MS && cached.size > 0) return await readFile(file);
	} catch {
		// No usable cache entry: fall through to the producer.
	}
	const bytes = await build();
	await mkdir(thumbDir(), { recursive: true });
	await writeFile(file, bytes).catch(() => {});
	void sweepThumbs();
	return bytes;
}

/** Live long-lived sessions, keyed by connection id and invalidated when credentials change. */
const daemons = new Map();

/** Fingerprint of everything that would invalidate a live session. */
function sessionKeyOf(connection) {
	return JSON.stringify([
		connection.host,
		connection.port ?? 445,
		connection.domain ?? '',
		connection.username,
		connection.password,
		connection.share,
	]);
}

/**
 * The daemon serving one connection, rebuilt when its credentials change.
 * @param {object} connection - stored connection row.
 * @returns {SmbDaemon} shared session.
 */
function daemonFor(connection) {
	const key = sessionKeyOf(connection);
	const existing = daemons.get(connection.id);
	if (existing !== undefined && existing.key === key) return existing.daemon;
	if (existing !== undefined) void existing.daemon.dispose();
	const daemon = new SmbDaemon({
		host: connection.host,
		port: connection.port ?? 445,
		domain: connection.domain ?? '',
		username: connection.username,
		password: connection.password,
		share: connection.share,
	});
	daemons.set(connection.id, { daemon, key });
	return daemon;
}

/** Close every live session (plugin disposal, or a credential edit). */
async function closeDaemons() {
	const entries = [...daemons.values()];
	daemons.clear();
	await Promise.all(entries.map((entry) => entry.daemon.dispose()));
}

/** Map one SMB failure onto a status and a body the browser half can explain. */
function payloadOf(error) {
	if (error instanceof RequestError) return { status: error.status, body: { error: error.message, code: error.code } };
	if (error instanceof WorkerError) {
		const friendly = {
			auth_failed: 'SMB 认证失败：检查用户名、密码与域（Windows 本地账号通常留空域）',
			denied: '这个账号对目标没有读权限（共享权限或 NTFS 权限）',
			no_such_share: '共享名不存在，或这个账号看不到它 —— 先点「列出共享」照着选',
			not_found: '共享里的这个路径不存在',
			wrong_type: '文件与目录类型不符',
			timeout: 'SMB 服务在超时内没有回应',
		}[error.code];
		return {
			status: error.httpStatus,
			body: { error: friendly ?? 'SMB 操作失败', code: error.code, detail: error.status ?? error.message },
		};
	}
	const code = typeof error?.code === 'string' ? error.code : undefined;
	const kind = error?.constructor?.name ?? 'Error';
	const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : String(error);
	// The NTSTATUS name is the one string that identifies an SMB refusal; without
	// it every branch below degrades to the same useless "operation failed".
	const statusName = typeof error?.statusName === 'string' && error.statusName.length > 0 ? error.statusName : undefined;
	const detail = statusName === undefined ? `${kind}: ${message}` : `${kind} ${statusName}: ${message}`;
	if (kind === 'SmbAuthError') {
		return { status: 401, body: { error: 'SMB 认证失败：检查用户名、密码与域（Windows 本地账号通常留空域）', code: 'auth_failed', detail } };
	}
	if (code === 'EACCES') {
		return { status: 403, body: { error: '这个账号对目标没有读权限（共享权限或 NTFS 权限）', code: 'denied', detail } };
	}
	if (code === 'ENXIO') {
		return { status: 404, body: { error: '共享名不存在，或这个账号看不到它 —— 先点「列出共享」照着选', code: 'no_such_share', detail } };
	}
	if (code === 'ENOENT') return { status: 404, body: { error: '共享里的这个路径不存在', code: 'not_found', detail } };
	if (code === 'ENOTDIR' || code === 'EISDIR') return { status: 400, body: { error: '文件与目录类型不符', code: 'wrong_type', detail } };
	if (code === 'EBUSY') return { status: 409, body: { error: '文件被其它程序占用，稍后再试', code: 'busy', detail } };
	if (code === 'EINVAL') return { status: 400, body: { error: '服务器拒绝了这个请求（路径或参数不合法）', code: 'invalid', detail } };
	if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') {
		return { status: 502, body: { error: '连不上 SMB 服务器：检查主机地址、445 端口与网络', code: 'unreachable', detail } };
	}
	return { status: 502, body: { error: 'SMB 操作失败', code: 'smb_error', detail } };
}

/** Render one failure as a JSON response. */
function failureOf(error) {
	const { status, body } = payloadOf(error);
	return json(body, status);
}

/**
 * Append one failed request to the plugin's own log. The Host's stdout is a
 * socket the operator never sees, and the browser half only surfaces the
 * operator-facing sentence, so the underlying SMB failure — the actual
 * diagnostic — would otherwise be lost.
 * @param route - short tag naming the route that failed.
 * @param error - whatever the handler threw.
 */
async function recordFailure(route, error) {
	const line = [
		new Date().toISOString(),
		route,
		error?.constructor?.name ?? typeof error,
		error?.code ?? '-',
		String(error?.message ?? error).replace(/\s+/g, ' '),
	].join('\t');
	try {
		await mkdir(dirname(configPath()), { recursive: true });
		await appendFile(join(dirname(configPath()), 'smb-picker.log'), `${line}\n`);
	} catch {
		// Logging must never turn one failure into two.
	}
}

/** The connection table: one small JSON file beside the rest of the DSH home. */
class ConnectionStore {
	#file;
	#cache = null;
	#writing = Promise.resolve();

	constructor(file) {
		this.#file = file;
	}

	/** @returns {Promise<{id:string,label:string,host:string,port:number,share:string,path:string,domain:string,username:string,password:string}[]>} */
	async all() {
		if (this.#cache !== null) return this.#cache;
		let raw;
		try {
			raw = JSON.parse(await readFile(this.#file, 'utf8'));
		} catch {
			this.#cache = [];
			return this.#cache;
		}
		const list = Array.isArray(raw?.connections) ? raw.connections : [];
		this.#cache = list.filter((row) => typeof row?.id === 'string' && typeof row?.host === 'string');
		return this.#cache;
	}

	/** Find one connection or refuse the request. */
	async require(id) {
		const list = await this.all();
		const found = list.find((row) => row.id === id);
		if (found === undefined) throw new RequestError(404, 'unknown_connection', '没有这个连接，重开面板刷新一下');
		return found;
	}

	/** Replace or append one row, then persist. Passwords are kept when the patch omits them. */
	async save(patch) {
		const host = String(patch.host ?? '').trim();
		const share = String(patch.share ?? '').replace(/^\/+|\/+$/g, '').trim();
		const username = String(patch.username ?? '').trim();
		if (host.length === 0) throw new RequestError(400, 'bad_connection', '主机地址不能为空');
		if (share.length === 0) throw new RequestError(400, 'bad_connection', '共享名不能为空');
		if (username.length === 0) throw new RequestError(400, 'bad_connection', '用户名不能为空');
		const list = [...(await this.all())];
		const id = typeof patch.id === 'string' && patch.id.length > 0 ? patch.id : randomUUID();
		const index = list.findIndex((row) => row.id === id);
		const previous = index >= 0 ? list[index] : undefined;
		// An empty field means "leave the stored secret alone" — the browser never
		// receives the password back, so a blank box must not read as "clear it".
		const password = typeof patch.password === 'string' && patch.password.length > 0
			? patch.password
			: previous?.password ?? '';
		const row = {
			id,
			label: String(patch.label ?? '').trim() || `${host}/${share}`,
			host,
			port: Number.isInteger(patch.port) && patch.port > 0 ? patch.port : 445,
			share,
			path: String(patch.path ?? '').replace(/^\/+|\/+$/g, '').trim(),
			domain: String(patch.domain ?? '').trim(),
			username,
			password,
		};
		if (index >= 0) list[index] = row;
		else list.push(row);
		await this.#persist(list);
		return row;
	}

	/** Remove one row. */
	async remove(id) {
		const list = (await this.all()).filter((row) => row.id !== id);
		await this.#persist(list);
	}

	/** Seed from plugin config only when the file has nothing yet. */
	async seed(rows) {
		if (!Array.isArray(rows) || rows.length === 0) return;
		if ((await this.all()).length > 0) return;
		const list = [];
		for (const row of rows) {
			if (typeof row?.host !== 'string' || typeof row?.share !== 'string') continue;
			list.push({
				id: typeof row.id === 'string' && row.id.length > 0 ? row.id : randomUUID(),
				label: String(row.label ?? '').trim() || `${row.host}/${row.share}`,
				host: row.host,
				port: Number.isInteger(row.port) ? row.port : 445,
				share: row.share,
				path: String(row.path ?? '').replace(/^\/+|\/+$/g, ''),
				domain: String(row.domain ?? ''),
				username: String(row.username ?? ''),
				password: String(row.password ?? ''),
			});
		}
		if (list.length > 0) await this.#persist(list);
	}

	/** Serialize writes so two taps cannot interleave into a truncated file. */
	#persist(list) {
		this.#cache = list;
		this.#writing = this.#writing.then(async () => {
			await mkdir(dirname(this.#file), { recursive: true });
			await writeFile(this.#file, `${JSON.stringify({ version: 1, connections: list }, null, '\t')}\n`, { mode: 0o600 });
			await chmod(this.#file, 0o600).catch(() => {});
		}).catch(() => {});
		return this.#writing;
	}
}

/** Pool of live SMB sessions, keyed by connection identity plus its current credentials. */
class SmbPool {
	#entries = new Map();
	#sweeper;

	constructor() {
		this.#sweeper = setInterval(() => this.#sweep(), 60 * 1000);
		this.#sweeper.unref?.();
	}

	/** Stable fingerprint so a credential edit tears the old session down. */
	static #fingerprint(connection) {
		return [connection.host, connection.port ?? 445, connection.domain ?? '', connection.username, connection.password].join('\u0000');
	}

	/** Connect (or reuse) one authenticated session for this connection. */
	async clientFor(connection) {
		const fingerprint = SmbPool.#fingerprint(connection);
		const existing = this.#entries.get(connection.id);
		if (existing !== undefined && existing.fingerprint === fingerprint) {
			existing.lastUsed = Date.now();
			return existing.client;
		}
		if (existing !== undefined) await this.drop(connection.id);
		const client = new Client({
			host: connection.host,
			port: connection.port ?? 445,
			domain: connection.domain ?? '',
			username: connection.username,
			password: connection.password,
			connectTimeout: CONNECT_TIMEOUT_MS,
			requestTimeout: REQUEST_TIMEOUT_MS,
		});
		await client.connect();
		this.#entries.set(connection.id, { client, fingerprint, lastUsed: Date.now() });
		return client;
	}

	/** Close and forget one session. */
	async drop(id) {
		const entry = this.#entries.get(id);
		if (entry === undefined) return;
		this.#entries.delete(id);
		await entry.client.close().catch(() => {});
	}

	/** Close idle sessions; a dropped idle session is re-established on demand. */
	#sweep() {
		const cutoff = Date.now() - POOL_IDLE_MS;
		for (const [id, entry] of this.#entries) {
			if (entry.lastUsed < cutoff) void this.drop(id);
		}
	}

	/** Close everything (plugin disposal). */
	async dispose() {
		clearInterval(this.#sweeper);
		const ids = [...this.#entries.keys()];
		await Promise.all(ids.map((id) => this.drop(id)));
	}
}

/** Read one JSON request body, refusing anything that is not an object. */
async function readJsonBody(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		throw new RequestError(400, 'bad_body', '请求体不是合法 JSON');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new RequestError(400, 'bad_body', '请求体必须是对象');
	return body;
}

/** Strip secrets before anything leaves the Host. */
function presentable(connection) {
	return {
		id: connection.id,
		label: connection.label,
		host: connection.host,
		port: connection.port,
		share: connection.share,
		path: connection.path,
		domain: connection.domain,
		username: connection.username,
		hasPassword: typeof connection.password === 'string' && connection.password.length > 0,
	};
}

/**
 * Register the routes and own their lifetime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {{connections?: object[]}} [config] - optional seed table from the profile patch.
 */
export function apply(ctx, config) {
	const store = new ConnectionStore(configPath());
	const pool = new SmbPool();
	const register = (path, route) => ctx.effect(
		() => Reflect.get(ctx, 'connection').fetch.register({ path, requestBody: 'buffered', ...route }),
		`smb-picker: ${path}`,
	);

	ctx.effect(() => {
		void store.seed(config?.connections);
		return () => {
			void pool.dispose();
			void closeDaemons();
		};
	}, 'smb-picker: connection pool');

	// Connection table: list, save/test, delete.
	register(ROUTES.connections, {
		methods: ['GET', 'POST'],
		fetch: async (request) => {
			try {
				if (request.method === 'GET') {
					const list = await store.all();
					return json({ connections: list.map(presentable) });
				}
				const body = await readJsonBody(request);
				const action = typeof body.action === 'string' ? body.action : 'save';
				if (action === 'delete') {
					if (typeof body.id !== 'string' || body.id.length === 0) throw new RequestError(400, 'bad_body', '缺少 id');
					await store.remove(body.id);
					await pool.drop(body.id);
					const doomed = daemons.get(body.id);
					if (doomed !== undefined) {
						daemons.delete(body.id);
						await doomed.daemon.dispose();
					}
					return json({ ok: true, connections: (await store.all()).map(presentable) });
				}
				// `explore` answers "which shares exist here" BEFORE anything is saved:
				// the share name is the one field a user cannot know without asking the
				// server, so the form must be able to ask it with just host + account.
				// It uses a throwaway session so a half-filled form never enters the pool.
				if (action === 'explore') {
					const host = String(body.host ?? '').trim();
					const username = String(body.username ?? '').trim();
					if (host.length === 0) throw new RequestError(400, 'bad_connection', '先填主机地址');
					if (username.length === 0) throw new RequestError(400, 'bad_connection', '先填用户名');
					let password = typeof body.password === 'string' ? body.password : '';
					if (password.length === 0 && typeof body.id === 'string' && body.id.length > 0) {
						const previous = await store.require(body.id).catch(() => undefined);
						password = previous?.password ?? '';
					}
					const port = Number.isInteger(body.port) && body.port > 0 ? body.port : 445;
					const probe = new Client({
						host,
						port,
						domain: String(body.domain ?? '').trim(),
						username,
						password,
						connectTimeout: CONNECT_TIMEOUT_MS,
						requestTimeout: REQUEST_TIMEOUT_MS,
					});
					try {
						await probe.connect();
						const shares = await probe.listShares();
						return json({ shares: shares.slice(0, 200).map((row) => ({ name: row.name, type: row.type, comment: row.comment })) });
					} finally {
						await probe.close().catch(() => {});
					}
				}
				const saved = await store.save(body);
				await pool.drop(saved.id);
				const stale = daemons.get(saved.id);
				if (stale !== undefined) {
					daemons.delete(saved.id);
					await stale.daemon.dispose();
				}
				let check;
				try {
					const client = await pool.clientFor(saved);
					const shares = await client.listShares();
					check = { ok: true, shares: shares.slice(0, 40).map((row) => ({ name: row.name, type: row.type, comment: row.comment })) };
				} catch (error) {
					const failure = payloadOf(error);
					check = { ok: false, error: failure.body.error, code: failure.body.code, detail: failure.body.detail };
				}
				return json({ connection: presentable(saved), check, connections: (await store.all()).map(presentable) });
			} catch (error) {
				await recordFailure('connections', error);
				return failureOf(error);
			}
		},
	});

	// Share enumeration, used by the connection form to offer real share names.
	register(ROUTES.shares, {
		methods: ['GET'],
		fetch: async (request) => {
			try {
				const id = new URL(request.url).searchParams.get('id');
				if (id === null || id.length === 0) throw new RequestError(400, 'bad_request', '缺少 id');
				const connection = await store.require(id);
				const client = await pool.clientFor(connection);
				const shares = await client.listShares();
				return json({ shares: shares.slice(0, 200).map((row) => ({ name: row.name, type: row.type, comment: row.comment })) });
			} catch (error) {
				await recordFailure('shares', error);
				return failureOf(error);
			}
		},
	});

	// One directory listing, relative to the connection's configured subdirectory.
	register(ROUTES.list, {
		methods: ['GET'],
		fetch: async (request) => {
			try {
				const params = new URL(request.url).searchParams;
				const id = params.get('id');
				if (id === null || id.length === 0) throw new RequestError(400, 'bad_request', '缺少 id');
				const relative = params.get('path') ?? '';
				assertRelativePath(relative);
				const connection = await store.require(id);
				const listed = await daemonFor(connection).json('list', { path: relPathOf(connection, relative) });
				const entries = Array.isArray(listed?.entries) ? listed.entries : [];
				const rows = entries
					.filter((entry) => typeof entry?.name === 'string' && entry.name !== '.' && entry.name !== '..')
					.map((entry) => ({
						name: entry.name,
						directory: entry.directory === true,
						size: Number.isFinite(entry.size) ? entry.size : undefined,
						mtime: Number.isFinite(entry.mtime) ? entry.mtime : undefined,
						mediaType: entry.directory === true ? undefined : MIME_BY_EXTENSION[extname(entry.name).toLowerCase()],
					}))
					.sort(compareEntries)
					.slice(0, MAX_ENTRIES);
				const trimmed = relative.replace(/^\/+|\/+$/g, '');
				const parent = trimmed.length === 0 ? null : trimmed.split('/').slice(0, -1).join('/');
				return json({ path: trimmed, parent, total: entries.length, entries: rows });
			} catch (error) {
				await recordFailure('list', error);
				return failureOf(error);
			}
		},
	});

	// One grid thumbnail. Cached on disk by (connection, path, width), so revisiting a
	// directory costs the browser nothing but the local file read.
	register(ROUTES.thumb, {
		methods: ['GET'],
		fetch: async (request) => {
			try {
				const params = new URL(request.url).searchParams;
				const id = params.get('id');
				const relative = params.get('path') ?? '';
				if (id === null || id.length === 0) throw new RequestError(400, 'bad_request', '缺少 id');
				if (relative.length === 0) throw new RequestError(400, 'bad_request', '缺少 path');
				assertRelativePath(relative);
				const requested = Number.parseInt(params.get('w') ?? '400', 10);
				const width = Number.isInteger(requested) ? Math.min(THUMB_WIDTH_MAX, Math.max(THUMB_WIDTH_MIN, requested)) : 400;
				const connection = await store.require(id);
				const bytes = await cachedThumb(`${connection.id}\u0000${relative}\u0000${width}`, () => daemonFor(connection).bytes('thumb', {
					path: relPathOf(connection, relative),
					width,
				}));
				return new Response(bytes, {
					headers: {
						'content-type': 'image/webp',
						'content-length': String(bytes.length),
						'cache-control': 'private, max-age=86400',
					},
				});
			} catch (error) {
				await recordFailure('thumb', error);
				return failureOf(error);
			}
		},
	});

	// Stream one file. `stat` runs first so an auth or path failure surfaces as JSON rather than a broken stream.
	register(ROUTES.raw, {
		methods: ['GET'],
		fetch: async (request) => {
			try {
				const params = new URL(request.url).searchParams;
				const id = params.get('id');
				const relative = params.get('path') ?? '';
				if (id === null || id.length === 0) throw new RequestError(400, 'bad_request', '缺少 id');
				if (relative.length === 0) throw new RequestError(400, 'bad_request', '缺少 path');
				assertRelativePath(relative);
				const connection = await store.require(id);
				const settings = settingsOf(connection, relative);
				// Stat first: an authorization or path refusal must arrive as JSON,
				// not as a body that dies halfway through streaming.
				const stat = await daemonFor(connection).json('stat', { path: settings.path });
				if (stat?.directory === true) throw new RequestError(400, 'wrong_type', '这是一个目录，不是文件');
				const mediaType = MIME_BY_EXTENSION[extname(relative).toLowerCase()] ?? 'application/octet-stream';
				const { stream } = await openRead(settings);
				const body = Readable.toWeb(stream);
				return new Response(body, {
					headers: {
						'content-type': mediaType,
						'content-length': String(stat?.size ?? ''),
						'cache-control': 'private, max-age=300',
					},
				});
			} catch (error) {
				await recordFailure('raw', error);
				return failureOf(error);
			}
		},
	});
}
