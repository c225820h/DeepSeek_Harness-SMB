/**
 * BROWSER half of dsh-smb-picker.
 *
 * Hand-written `window.__ModuleLoader__.load({ id, factory })` bundle — no
 * build step, so this file IS the loadable artifact.
 *
 * What it adds: one compact control in the composer's left tool row that opens
 * a share browser. The bytes never pass through the phone's file manager — the
 * Host reads them over SMB and this half turns each chosen file into a browser
 * `File`, which then rides the ordinary draft-attachment path
 * (`conversation.createDrafts` + `inputActions.addAttachments`). Nothing here
 * reimplements upload, admission, or serialization.
 *
 * Zero peer dependencies: `react` only, requested through the client module
 * loader, with `createElement` called directly instead of transpiled JSX.
 */

if (!window.__dshSmbPickerInstalled) {
	window.__dshSmbPickerInstalled = true;

	window.__ModuleLoader__.load({
		id: 'dsh-smb-picker',
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

			const React = require('react');
			const h = React.createElement;

			const API = '/api/smb-picker';
			/** Media types the Host attachment path admits as real images. */
			const ADMITTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

			//#region styles
			const STYLE_ID = 'dsh-smb-picker-style';
			const CSS = `
.dsh-smb-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:14px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.82;transition:opacity .15s,border-color .15s}
.dsh-smb-trigger:hover{opacity:1;border-color:color-mix(in srgb,currentColor 34%,transparent)}
.dsh-smb-trigger[disabled]{opacity:.4;cursor:default}
.dsh-smb-trigger svg{width:14px;height:14px;flex:none}
@media (max-width:560px){.dsh-smb-trigger{padding:0 7px}.dsh-smb-trigger span{display:none}}
.dsh-smb-scrim{position:fixed;inset:0;z-index:2147483000;background:rgba(12,14,18,.5);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.dsh-smb-card{display:flex;flex-direction:column;width:min(860px,100%);height:min(680px,100%);background:#fff;color:#1b1d21;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.32);overflow:hidden;font-size:13px;line-height:1.45}
@media (max-width:640px){.dsh-smb-scrim{padding:0}.dsh-smb-card{width:100%;height:100%;border-radius:0}}
.dsh-smb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e8eaee;flex:none}
.dsh-smb-title{font-weight:600;font-size:14px;white-space:nowrap}
.dsh-smb-select{max-width:200px;height:28px;padding:0 6px;border:1px solid #d9dce2;border-radius:8px;background:#fff;color:inherit;font:inherit;font-size:12px}
.dsh-smb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid #d9dce2;border-radius:8px;background:#fff;color:inherit;cursor:pointer;flex:none;padding:0}
.dsh-smb-iconbtn:hover{background:#f4f5f8}
.dsh-smb-iconbtn svg{width:14px;height:14px}
.dsh-smb-iconbtn[disabled]{opacity:.4;cursor:default}
.dsh-smb-spacer{flex:1}
.dsh-smb-crumbs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid #f0f2f5;flex:none;font-size:12px}
.dsh-smb-crumb{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 6px;border-radius:6px;background:transparent;border:0;color:#3a63d0;font:inherit;cursor:pointer}
.dsh-smb-crumb:hover{background:#eef2fd}
.dsh-smb-crumb-sep{color:#b9bdc6}
.dsh-smb-tools{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #f0f2f5;flex:none}
.dsh-smb-search{flex:1;height:30px;padding:0 10px;border:1px solid #d9dce2;border-radius:8px;background:#fff;color:inherit;font:inherit;font-size:12px;min-width:0}
.dsh-smb-chip{height:26px;padding:0 10px;border:1px solid #d9dce2;border-radius:13px;background:#fff;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsh-smb-chip[data-on="1"]{background:#1b1d21;border-color:#1b1d21;color:#fff}
.dsh-smb-body{flex:1;overflow:auto;overscroll-behavior:contain;padding:10px 12px;background:#fbfbfc}
.dsh-smb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
.dsh-smb-cell{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:4px;padding:6px;border:1px solid #e6e8ec;border-radius:10px;background:#fff;cursor:pointer;overflow:hidden;text-align:left;font:inherit;color:inherit}
.dsh-smb-cell:hover{border-color:#c9cfda}
.dsh-smb-cell[data-sel="1"]{border-color:#2f6bff;box-shadow:0 0 0 1px #2f6bff inset;background:#f6f9ff}
.dsh-smb-cell[data-dir="1"]{background:#f7f8fa}
.dsh-smb-thumb{width:100%;aspect-ratio:1/1;border-radius:6px;object-fit:cover;background:#eef0f4;display:block}
.dsh-smb-fallback{width:100%;aspect-ratio:1/1;border-radius:6px;background:#eef0f4;display:flex;align-items:center;justify-content:center;color:#6b7280}
.dsh-smb-fallback svg{width:26px;height:26px}
.dsh-smb-name{font-size:11px;line-height:1.3;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:2.6em}
.dsh-smb-tick{position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:9px;background:#2f6bff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.2)}
.dsh-smb-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;height:100%;min-height:160px;color:#7a808c;font-size:12px;text-align:center;padding:20px}
.dsh-smb-foot{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #e8eaee;flex:none;background:#fff}
.dsh-smb-note{font-size:12px;color:#5c6270;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-smb-primary{height:32px;padding:0 16px;border:0;border-radius:9px;background:#2f6bff;color:#fff;font:inherit;font-weight:600;font-size:13px;cursor:pointer;flex:none}
.dsh-smb-primary[disabled]{background:#c3cad8;cursor:default}
.dsh-smb-ghost{height:32px;padding:0 12px;border:1px solid #d9dce2;border-radius:9px;background:#fff;color:inherit;font:inherit;font-size:13px;cursor:pointer;flex:none}
.dsh-smb-error{margin:0;padding:8px 12px;background:#fff1f0;color:#b3261e;font-size:12px;border-bottom:1px solid #ffd7d4}
.dsh-smb-form{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px}
.dsh-smb-form label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#5c6270}
.dsh-smb-form label[data-wide="1"]{grid-column:1/-1}
.dsh-smb-form input{height:30px;padding:0 9px;border:1px solid #d9dce2;border-radius:8px;background:#fff;color:inherit;font:inherit;font-size:12px;min-width:0}
.dsh-smb-preview{position:fixed;inset:0;z-index:2147483001;background:rgba(8,10,14,.9);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}
.dsh-smb-preview img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
.dsh-smb-preview .dsh-smb-iconbtn{position:absolute;top:12px;right:12px;width:36px;height:36px}
.dsh-smb-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dsh-smb-rotate .7s linear infinite;vertical-align:-2px}
@keyframes dsh-smb-rotate{to{transform:rotate(360deg)}}
`;
			/** Inject the stylesheet once per page. */
			function ensureStyle() {
				if (document.getElementById(STYLE_ID) !== null) return;
				const node = document.createElement('style');
				node.id = STYLE_ID;
				node.textContent = CSS;
				document.head.appendChild(node);
			}
			//#endregion

			//#region icons
			function Icon({ path, fill = 'none' }) {
				return h('svg', { viewBox: '0 0 24 24', fill, stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: path }));
			}
			const ICON_SERVER = 'M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01';
			const ICON_FOLDER = 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h7A1.5 1.5 0 0 1 19 9.5v7A1.5 1.5 0 0 1 17.5 18h-13A1.5 1.5 0 0 1 3 16.5z';
			const ICON_FILE = 'M6 3h7l5 5v13H6zM13 3v5h5';
			const ICON_BACK = 'M14 6l-6 6 6 6';
			const ICON_REFRESH = 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5';
			const ICON_GEAR = 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.6 14H3.5a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.6V3.5a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.2.8z';
			const ICON_CLOSE = 'M6 6l12 12M18 6L6 18';
			const ICON_CHECK = 'M5 12.5l4.5 4.5L19 7';
			const ICON_EYE = 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
			//#endregion

			//#region transport
			/** Build one readable failure: the operator-facing sentence plus the underlying SMB detail. */
			function failureMessage(body, status) {
				const headline = typeof body?.error === 'string' && body.error.length > 0 ? body.error : `HTTP ${status}`;
				const detail = typeof body?.detail === 'string' && body.detail.length > 0 ? body.detail : '';
				return detail.length > 0 ? `${headline} —— ${detail}` : headline;
			}

			/** One JSON GET against this plugin's Host routes. */
			async function apiGet(route, params) {
				const query = new URLSearchParams();
				for (const [key, value] of Object.entries(params ?? {})) {
					if (value !== undefined && value !== null) query.set(key, String(value));
				}
				const response = await fetch(`${API}.${route}?${query.toString()}`, { headers: { accept: 'application/json' } });
				const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
				if (!response.ok) throw new Error(failureMessage(body, response.status));
				return body;
			}

			/** One JSON POST against this plugin's Host routes. */
			async function apiPost(route, payload) {
				const response = await fetch(`${API}.${route}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				});
				const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
				if (!response.ok) throw new Error(failureMessage(body, response.status));
				return body;
			}

			/** Direct URL for one file's bytes, as served by the Host. */
			function rawUrl(connectionId, path) {
				const query = new URLSearchParams({ id: connectionId, path });
				return `${API}.raw?${query.toString()}`;
			}
			//#endregion

			//#region components
			/** Image that only subscribes to the network once it nears the viewport. */
			function LazyImage({ src, alt, onDoubleClick }) {
				const holder = React.useRef(null);
				const [visible, setVisible] = React.useState(false);
				const [broken, setBroken] = React.useState(false);
				React.useEffect(() => {
					const node = holder.current;
					if (node === null || typeof IntersectionObserver === 'undefined') {
						setVisible(true);
						return undefined;
					}
					const observer = new IntersectionObserver((rows) => {
						if (rows.some((row) => row.isIntersecting)) {
							setVisible(true);
							observer.disconnect();
						}
					}, { rootMargin: '320px' });
					observer.observe(node);
					return () => observer.disconnect();
				}, []);
				if (broken) return h('div', { className: 'dsh-smb-fallback', ref: holder }, h(Icon, { path: ICON_FILE }));
				return h('img', {
					className: 'dsh-smb-thumb',
					ref: holder,
					src: visible ? src : undefined,
					alt,
					loading: 'lazy',
					decoding: 'async',
					draggable: false,
					onError: () => setBroken(true),
					onDoubleClick,
				});
			}

			/** One grid cell: a directory to enter, or a file to select. */
			function Cell({ entry, selected, connectionId, currentPath, onOpen, onToggle, onPreview }) {
				const fullPath = currentPath.length === 0 ? entry.name : `${currentPath}/${entry.name}`;
				if (entry.directory) {
					return h('button', {
						type: 'button',
						className: 'dsh-smb-cell',
						'data-dir': '1',
						title: entry.name,
						onClick: () => onOpen(fullPath),
						onDoubleClick: () => onOpen(fullPath),
					},
						h('div', { className: 'dsh-smb-fallback' }, h(Icon, { path: ICON_FOLDER })),
						h('div', { className: 'dsh-smb-name' }, entry.name));
				}
				const preview = entry.mediaType !== undefined && ADMITTED_IMAGE_TYPES.has(entry.mediaType);
				return h('button', {
					type: 'button',
					className: 'dsh-smb-cell',
					'data-sel': selected ? '1' : '0',
					'data-dir': '0',
					title: entry.name,
					onClick: () => onToggle(fullPath),
					onDoubleClick: (event) => {
						event.preventDefault();
						if (preview) onPreview(fullPath);
					},
				},
					preview
						? h(LazyImage, { src: rawUrl(connectionId, fullPath), alt: entry.name })
						: h('div', { className: 'dsh-smb-fallback' }, h(Icon, { path: ICON_FILE })),
					h('div', { className: 'dsh-smb-name' }, entry.name),
					selected ? h('div', { className: 'dsh-smb-tick' }, h(Icon, { path: ICON_CHECK })) : null);
			}

			/** The connection editor: add or patch one SMB target. */
			function ConnectionForm({ draft, onChange, onSubmit, onCancel, busy, shareOptions, exploring, onExplore, onPickShare }) {
				const field = (key, label, options = {}) => h('label', { 'data-wide': options.wide ? '1' : '0' },
					label,
					h('input', {
						value: draft[key] ?? '',
						type: options.secret ? 'password' : 'text',
						inputMode: options.numeric ? 'numeric' : undefined,
						autoComplete: options.secret ? 'new-password' : 'off',
						placeholder: options.placeholder,
						onChange: (event) => onChange({ ...draft, [key]: event.target.value }),
					}));
				return h('form', {
					className: 'dsh-smb-form',
					onSubmit: (event) => {
						event.preventDefault();
						onSubmit();
					},
				},
					field('label', '名称（可留空）', { wide: true, placeholder: '生图机' }),
					field('host', '主机 / IP', { placeholder: '192.168.1.10' }),
					field('port', '端口', { numeric: true, placeholder: '445' }),
					field('share', '共享名', { placeholder: '点右下角「列出共享」' }),
					field('username', '用户名', { placeholder: 'Administrator' }),
					field('domain', '域（本地账号留空）', { placeholder: '' }),
					field('password', '密码', { wide: true, secret: true, placeholder: draft.hasPassword ? '已保存，留空则不修改' : '' }),
					field('path', '起始子目录（可留空）', { wide: true, placeholder: 'outputs' }),
					shareOptions.length > 0
						? h('div', { 'data-wide': '1', style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
							shareOptions.map((row) => h('button', {
								key: row.name,
								type: 'button',
								className: 'dsh-smb-chip',
								'data-on': draft.share === row.name ? '1' : '0',
								title: row.comment ?? '',
								onClick: () => onPickShare(row.name),
							}, row.name)))
						: null,
					h('div', { 'data-wide': '1', style: { display: 'flex', gap: 8, alignItems: 'center' } },
						h('button', { type: 'button', className: 'dsh-smb-ghost', onClick: onExplore, disabled: busy || exploring },
							exploring ? h('span', { className: 'dsh-smb-spin' }) : '列出共享'),
						h('div', { style: { flex: 1 } }),
						h('button', { type: 'button', className: 'dsh-smb-ghost', onClick: onCancel, disabled: busy }, '取消'),
						h('button', { type: 'submit', className: 'dsh-smb-primary', disabled: busy }, busy ? h('span', { className: 'dsh-smb-spin' }) : '保存并测试')));
			}

			/** The whole picker: connection switch, breadcrumb browser, and attach bar. */
			function Picker({ sessionId, inputActions, conversationOf, onClose }) {
				const [connections, setConnections] = React.useState([]);
				const [connectionId, setConnectionId] = React.useState('');
				const [path, setPath] = React.useState('');
				const [entries, setEntries] = React.useState([]);
				const [selected, setSelected] = React.useState(() => new Set());
				const [query, setQuery] = React.useState('');
				const [imagesOnly, setImagesOnly] = React.useState(false);
				const [loading, setLoading] = React.useState(false);
				const [error, setError] = React.useState('');
				const [notice, setNotice] = React.useState('');
				const [editing, setEditing] = React.useState(false);
				const [draft, setDraft] = React.useState({ port: '445' });
				const [busy, setBusy] = React.useState(false);
				const [previewing, setPreviewing] = React.useState('');
				const [attaching, setAttaching] = React.useState(false);
				const [shareOptions, setShareOptions] = React.useState([]);
				const [exploring, setExploring] = React.useState(false);

				const active = connections.find((row) => row.id === connectionId);

				/** Pull the connection table, opening the editor when nothing is configured yet. */
				const loadConnections = React.useCallback(async () => {
					try {
						const body = await apiGet('connections');
						setConnections(body.connections);
						setConnectionId((current) => {
							if (current.length > 0 && body.connections.some((row) => row.id === current)) return current;
							return body.connections[0]?.id ?? '';
						});
						if (body.connections.length === 0) setEditing(true);
						return body.connections;
					} catch (failure) {
						setError(failure.message);
						return [];
					}
				}, []);

				/** Load one directory. */
				const browse = React.useCallback(async (id, nextPath) => {
					if (id.length === 0) return;
					setLoading(true);
					setError('');
					try {
						const body = await apiGet('list', { id, path: nextPath });
						setEntries(body.entries);
						setPath(body.path);
						setSelected(new Set());
					} catch (failure) {
						setError(failure.message);
						setEntries([]);
					} finally {
						setLoading(false);
					}
				}, []);

				React.useEffect(() => { void loadConnections(); }, [loadConnections]);
				React.useEffect(() => {
					if (connectionId.length > 0) void browse(connectionId, '');
				}, [connectionId, browse]);

				const shown = entries.filter((entry) => {
					if (imagesOnly && !entry.directory && (entry.mediaType === undefined || !ADMITTED_IMAGE_TYPES.has(entry.mediaType))) return false;
					if (query.length === 0) return true;
					return entry.name.toLowerCase().includes(query.toLowerCase());
				});

				const toggle = (fullPath) => {
					setSelected((current) => {
						const next = new Set(current);
						if (next.has(fullPath)) next.delete(fullPath);
						else next.add(fullPath);
						return next;
					});
				};

				/** Turn every chosen file into a draft attachment the composer already understands. */
				const attach = async () => {
					if (selected.size === 0 || active === undefined) return;
					setAttaching(true);
					setError('');
					try {
						const conversation = conversationOf();
						if (conversation === undefined || typeof conversation.createDrafts !== 'function') {
							throw new Error('这个 DSH 版本没有暴露程序化添加附件的接口');
						}
						const files = [];
						const failed = [];
						for (const fullPath of selected) {
							const response = await fetch(rawUrl(active.id, fullPath));
							if (!response.ok) {
								failed.push(fullPath.split('/').pop() ?? fullPath);
								continue;
							}
							const blob = await response.blob();
							const entry = entries.find((row) => (path.length === 0 ? row.name : `${path}/${row.name}`) === fullPath);
							const mediaType = entry?.mediaType ?? blob.type ?? 'application/octet-stream';
							const name = fullPath.split('/').pop() ?? 'file';
							files.push(new File([blob], name, { type: mediaType }));
						}
						// All-or-nothing: a half-attached batch is harder to reason about than a retry.
						if (failed.length > 0) throw new Error(`这 ${failed.length} 个文件没取回来：${failed.slice(0, 3).join('、')}${failed.length > 3 ? ' 等' : ''}`);
						if (files.length === 0) throw new Error('一个文件都没取回来');
						const drafts = conversation.createDrafts(sessionId, files);
						if (!inputActions.addAttachments(drafts.map((row) => row.id))) throw new Error('输入框正忙，稍后再试');
						onClose();
					} catch (failure) {
						setError(failure.message);
					} finally {
						setAttaching(false);
					}
				};

				/** Persist the editor, then re-test the connection. */
				const submitDraft = async () => {
					setBusy(true);
					setError('');
					try {
						const port = Number.parseInt(draft.port ?? '445', 10);
						const body = await apiPost('connections', {
							id: draft.id,
							label: draft.label,
							host: draft.host,
							port: Number.isInteger(port) ? port : 445,
							share: draft.share,
							username: draft.username,
							domain: draft.domain,
							password: draft.password,
							path: draft.path,
						});
						setConnections(body.connections);
						setConnectionId(body.connection.id);
						setEditing(false);
						setShareOptions(body.check?.ok ? body.check.shares : []);
						if (body.check?.ok) setNotice(`连接成功，可见 ${body.check.shares.length} 个共享`);
						else setError(body.check?.error ?? '连接测试失败');
					} catch (failure) {
						setError(failure.message);
					} finally {
						setBusy(false);
					}
				};

				/** Ask the server which shares this account can see, before anything is saved. */
				const explore = async () => {
					setExploring(true);
					setError('');
					setShareOptions([]);
					try {
						const port = Number.parseInt(draft.port ?? '445', 10);
						const body = await apiPost('connections', {
							action: 'explore',
							id: draft.id,
							host: draft.host,
							port: Number.isInteger(port) ? port : 445,
							username: draft.username,
							domain: draft.domain,
							password: draft.password,
						});
						const usable = body.shares.filter((row) => row.type !== 'ipc' && row.type !== 'print');
						setShareOptions(usable);
						if (usable.length === 0) setError('连上了，但这个账号看不到可浏览的共享');
					} catch (failure) {
						setError(failure.message);
					} finally {
						setExploring(false);
					}
				};

				const crumbs = path.length === 0 ? [] : path.split('/');

				return h('div', { className: 'dsh-smb-scrim', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); } },
					h('div', { className: 'dsh-smb-card' },
						h('div', { className: 'dsh-smb-head' },
							h('span', { className: 'dsh-smb-title' }, 'SMB 选图'),
							connections.length > 0
								? h('select', {
									className: 'dsh-smb-select',
									value: connectionId,
									onChange: (event) => setConnectionId(event.target.value),
								}, connections.map((row) => h('option', { key: row.id, value: row.id }, row.label)))
								: null,
							h('div', { className: 'dsh-smb-spacer' }),
							h('button', {
								type: 'button',
								className: 'dsh-smb-iconbtn',
								title: '刷新',
								disabled: loading || connectionId.length === 0,
								onClick: () => void browse(connectionId, path),
							}, h(Icon, { path: ICON_REFRESH })),
							h('button', {
								type: 'button',
								className: 'dsh-smb-iconbtn',
								title: '连接设置',
								onClick: () => {
									setDraft(active !== undefined ? { ...active, port: String(active.port), password: '' } : { port: '445' });
									setShareOptions([]);
									setEditing((value) => !value);
								},
							}, h(Icon, { path: ICON_GEAR })),
							h('button', { type: 'button', className: 'dsh-smb-iconbtn', title: '关闭', onClick: onClose }, h(Icon, { path: ICON_CLOSE }))),
						error.length > 0 ? h('p', { className: 'dsh-smb-error' }, error) : null,
						editing
							? h(ConnectionForm, {
								draft,
								busy,
								shareOptions,
								exploring,
								onChange: setDraft,
								onExplore: () => void explore(),
								onPickShare: (name) => setDraft((current) => ({ ...current, share: name })),
								onCancel: () => {
									setEditing(false);
									if (draft.id !== undefined && connections.length > 0) void browse(connectionId, path);
								},
								onSubmit: () => void submitDraft(),
							})
							: h(React.Fragment, null,
								h('div', { className: 'dsh-smb-crumbs' },
									h('button', {
										type: 'button',
										className: 'dsh-smb-crumb',
										onClick: () => void browse(connectionId, ''),
								}, active?.label ?? '共享'),
									crumbs.map((segment, index) => h(React.Fragment, { key: `${segment}-${index}` },
										h('span', { className: 'dsh-smb-crumb-sep' }, '/'),
										h('button', {
											type: 'button',
											className: 'dsh-smb-crumb',
											onClick: () => void browse(connectionId, crumbs.slice(0, index + 1).join('/')),
										}, segment)))),
								h('div', { className: 'dsh-smb-tools' },
									path.length > 0
										? h('button', {
											type: 'button',
											className: 'dsh-smb-iconbtn',
											title: '上一级',
											onClick: () => void browse(connectionId, crumbs.slice(0, -1).join('/')),
										}, h(Icon, { path: ICON_BACK }))
										: null,
									h('input', {
										className: 'dsh-smb-search',
										placeholder: '在当前目录里筛名字',
										value: query,
										onChange: (event) => setQuery(event.target.value),
									}),
									h('button', {
										type: 'button',
										className: 'dsh-smb-chip',
										'data-on': imagesOnly ? '1' : '0',
										onClick: () => setImagesOnly((value) => !value),
									}, '只看图片')),
								h('div', { className: 'dsh-smb-body' },
									loading
										? h('div', { className: 'dsh-smb-empty' }, h('span', { className: 'dsh-smb-spin' }), '正在读共享…')
										: shown.length === 0
											? h('div', { className: 'dsh-smb-empty' },
												h(Icon, { path: ICON_FOLDER }),
												entries.length === 0 ? '这个目录是空的' : '没有符合条件的条目')
											: h('div', { className: 'dsh-smb-grid' }, shown.map((entry) => {
												const fullPath = path.length === 0 ? entry.name : `${path}/${entry.name}`;
												return h(Cell, {
													key: fullPath,
													entry,
													connectionId,
													currentPath: path,
													selected: selected.has(fullPath),
													onOpen: (next) => void browse(connectionId, next),
													onToggle: toggle,
													onPreview: setPreviewing,
												});
											})),
									notice.length > 0 ? h('div', { className: 'dsh-smb-crumbs', style: { borderTop: '1px solid #f0f2f5', borderBottom: 0, color: '#2b7a3d' } }, notice) : null),
								h('div', { className: 'dsh-smb-foot' },
									h('div', { className: 'dsh-smb-note' }, selected.size === 0 ? '点一下选中，双击预览' : `已选 ${selected.size} 个`),
									h('div', { className: 'dsh-smb-spacer' }),
									selected.size === 1
										? h('button', {
											type: 'button',
											className: 'dsh-smb-ghost',
											onClick: () => setPreviewing([...selected][0]),
										}, h('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } }, h(Icon, { path: ICON_EYE }), '预览'))
										: null,
									h('button', {
										type: 'button',
										className: 'dsh-smb-primary',
										disabled: selected.size === 0 || attaching,
										onClick: () => void attach(),
									}, attaching ? h('span', { className: 'dsh-smb-spin' }) : `加入对话${selected.size > 0 ? ` (${selected.size})` : ''}`))),
						previewing.length > 0
							? h('div', {
								className: 'dsh-smb-preview',
								onMouseDown: (event) => { if (event.target === event.currentTarget) setPreviewing(''); },
							},
								h('img', { src: rawUrl(connectionId, previewing), alt: previewing }),
								h('button', { type: 'button', className: 'dsh-smb-iconbtn', title: '关闭', onClick: () => setPreviewing('') }, h(Icon, { path: ICON_CLOSE })))
							: null));
			}

			/** Composer control: opens the picker over the current session. */
			function makeTrigger(conversationOf) {
				return function SmbTrigger(props) {
					const [open, setOpen] = React.useState(false);
					const sessionId = props.sessionId;
					const inputActions = props.inputActions;
					const ready = typeof sessionId === 'string' && sessionId.length > 0 && inputActions !== undefined;
					return h(React.Fragment, null,
						h('button', {
							type: 'button',
							className: 'dsh-smb-trigger',
							title: ready ? '从 SMB 共享里选图' : '先打开一个会话',
							disabled: !ready,
							onClick: () => setOpen(true),
						}, h(Icon, { path: ICON_SERVER }), h('span', null, 'SMB')),
						open && ready
							? h(Picker, {
								sessionId,
								inputActions,
								conversationOf,
								onClose: () => setOpen(false),
							})
							: null);
				};
			}
			//#endregion

			/** Slot registry plus the scope-addressed Conversation service. */
			const inject = ['slots', 'conversation'];

			/**
			 * Contribute the composer control.
			 * @param ctx - client plugin context.
			 */
			function apply(ctx) {
				ensureStyle();
				const conversationOf = () => Reflect.get(ctx, 'conversation');
				const Trigger = makeTrigger(conversationOf);
				ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
					name: 'conversation.input.left',
					id: 'smb-picker',
					order: 40,
				}, Trigger));
			}

			exports.apply = apply;
			exports.inject = inject;
			return module.exports;
		},
	});
}
