import type { GraphData, PinnedBranch } from '../src/types.ts';

/**
 * Matches a branch name against a pattern where `*` is any run of characters
 * (including `/`), `?` one character, and `\` makes the next one literal —
 * the same reading git gives `--exclude`, so both settings behave alike.
 */
export function globMatches(pattern: string, name: string): boolean {
	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '*') source += '.*';
		else if (ch === '?') source += '.';
		else if (ch === '\\' && i + 1 < pattern.length) source += escapeRegExp(pattern[++i]);
		else source += escapeRegExp(ch);
	}
	return new RegExp(`^${source}$`, 's').test(name);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escapes a literal name for use as a glob pattern (by git or `globMatches`). */
export function escapeGlob(name: string): string {
	return name.replace(/[*?[\]\\]/g, '\\$&');
}

/**
 * The branches to draw in reserved columns, in priority order: each pattern
 * in turn, local branches before remote ones. Branches whose tip is not
 * loaded are skipped — their column would stay empty down the whole graph —
 * and a commit is pinned only once, by the first branch that claims it.
 */
export function resolvePins(data: GraphData, patterns: readonly string[]): PinnedBranch[] {
	const loaded = new Set(data.commits.map((commit) => commit.hash));
	const excluded = new Set(data.excludedRefs);
	const candidates = [
		...data.heads.filter((head) => !excluded.has(`refs/heads/${head.name}`)),
		...data.remoteHeads.filter((remote) => !excluded.has(`refs/remotes/${remote.name}`))
	];
	const pins: PinnedBranch[] = [];
	const taken = new Set<string>();
	for (const pattern of patterns) {
		for (const branch of candidates) {
			if (taken.has(branch.hash) || !loaded.has(branch.hash) || !globMatches(pattern, branch.name)) continue;
			taken.add(branch.hash);
			pins.push({ hash: branch.hash, name: branch.name });
		}
	}
	return pins;
}
