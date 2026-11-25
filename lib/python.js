/**
 * Locate the plugin's own Python virtualenv on any platform.
 *
 * The venv layout differs by platform: POSIX puts the interpreter at
 * `.venv/bin/python`, Windows at `.venv/Scripts/python.exe`. Resolve both
 * families in platform order so a venv created with the documented command is
 * always found, and report every path tried when none exists.
 */

import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root, derived from this module's own location. */
export const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const WINDOWS = process.platform === 'win32';

/** Candidate interpreters, native layout first. */
const CANDIDATES = WINDOWS
	? [
		['.venv', 'Scripts', 'python.exe'],
		['.venv', 'Scripts', 'python3.exe'],
		['.venv', 'bin', 'python'],
		['.venv', 'bin', 'python3'],
	]
	: [
		['.venv', 'bin', 'python'],
		['.venv', 'bin', 'python3'],
		['.venv', 'Scripts', 'python.exe'],
	];

/** Every interpreter path this plugin would accept, in order. */
export function pythonCandidates() {
	return CANDIDATES.map((parts) => join(PLUGIN_ROOT, ...parts));
}

/** Shell command that creates the venv on this platform. */
export function venvCreateHint() {
	return WINDOWS
		? 'python -m venv .venv && .venv\\Scripts\\pip install smbprotocol Pillow'
		: 'python3 -m venv .venv && .venv/bin/pip install smbprotocol Pillow';
}

/**
 * Find the venv interpreter.
 * @returns {Promise<{ python: string } | { missing: string[] }>} the interpreter, or every path tried.
 */
export async function findPython() {
	const tried = [];
	for (const candidate of pythonCandidates()) {
		try {
			await access(candidate);
			return { python: candidate };
		} catch {
			tried.push(candidate);
		}
	}
	return { missing: tried };
}

/** Message for a missing venv, naming the paths tried and the platform's command. */
export function missingPythonMessage(missing) {
	return `插件自带的 Python 环境不见了：${missing.join(' / ')}（在插件目录执行 ${venvCreateHint()}）`;
}
