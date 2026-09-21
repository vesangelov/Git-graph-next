import type { Commit, Hash } from '../types.ts';

/**
 * Reconnects a filtered history.
 *
 * When commits are dropped from the middle of history (filtering by author,
 * or following a file with `--follow`), git still reports each remaining
 * commit's real parents — commits that are not in the result. Drawn as is,
 * every edge would trail off the bottom of the graph.
 *
 * This replaces each parent that is not shown with the nearest shown
 * ancestors reachable through it, using `ancestry` (hash → real parents) for
 * the commits in between. It is the same rewriting git itself performs for
 * pathspec filters. A parent whose ancestry is unknown (beyond the walked
 * window) is kept, so its edge still trails off rather than attaching to the
 * wrong commit.
 */
export function rewriteParents(commits: readonly Commit[], ancestry: ReadonlyMap<Hash, readonly Hash[]>): Commit[] {
	const shown = new Set(commits.map((commit) => commit.hash));
	const resolved = new Map<Hash, Hash[]>();

	/**
	 * The shown ancestors a hidden commit stands for. Iterative post-order
	 * walk: linear runs of tens of thousands of hidden commits are normal, and
	 * recursion that deep would overflow the stack.
	 */
	const resolve = (start: Hash): Hash[] => {
		if (shown.has(start)) return [start];
		const done = resolved.get(start);
		if (done !== undefined) return done;

		const stack: Hash[] = [start];
		while (stack.length > 0) {
			const hash = stack[stack.length - 1];
			if (resolved.has(hash)) {
				stack.pop();
				continue;
			}
			const parents = ancestry.get(hash);
			if (parents === undefined) {
				// Outside the walked window: keep the hash itself.
				resolved.set(hash, [hash]);
				stack.pop();
				continue;
			}
			const pending = parents.filter((parent) => !shown.has(parent) && !resolved.has(parent));
			if (pending.length > 0) {
				stack.push(...pending);
				continue;
			}
			const result: Hash[] = [];
			for (const parent of parents) {
				for (const ancestor of shown.has(parent) ? [parent] : resolved.get(parent)!) {
					if (!result.includes(ancestor)) result.push(ancestor);
				}
			}
			resolved.set(hash, result);
			stack.pop();
		}
		return resolved.get(start)!;
	};

	return commits.map((commit) => {
		if (commit.parents.every((parent) => shown.has(parent))) return commit;
		const parents: Hash[] = [];
		for (const parent of commit.parents) {
			for (const ancestor of resolve(parent)) {
				if (!parents.includes(ancestor)) parents.push(ancestor);
			}
		}
		return { ...commit, parents };
	});
}
