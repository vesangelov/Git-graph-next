import type { Commit, GraphEdge, GraphLayout, GraphVertex, Hash, PinnedBranch } from '../types.ts';

/**
 * A column of the graph that is waiting for a particular commit to appear.
 *
 * A lane is created when a commit's parent is first referenced and is released
 * when that parent is drawn, so the number of live lanes is the number of
 * branches genuinely open at that point in history.
 */
interface Lane {
	/** The commit this lane is drawn towards. */
	expects: Hash;
	colour: number;
	/** Edges that end at `expects`, waiting for its row index to be known. */
	pending: PendingEdge[];
	/** Reserved lanes keep their column even while empty, for straight branches. */
	pinned: boolean;
}

interface PendingEdge {
	readonly fromIndex: number;
	readonly fromColumn: number;
	readonly laneColumn: number;
	readonly colour: number;
	readonly dashed: boolean;
}

export interface LayoutOptions {
	/**
	 * Branches reserved a column of their own, in priority order. Their line is
	 * drawn straight down the graph instead of weaving between lanes (#207).
	 */
	readonly pinnedBranches: readonly PinnedBranch[];
	/** Number of colours available; lane colours cycle through them. */
	readonly colourCount: number;
	/** Synthetic rows (uncommitted, staged) whose edge downwards is drawn dashed. */
	readonly dashedRows: ReadonlySet<Hash>;
	/**
	 * Fixed colours for branch tips (#254): the lane starting at, or passing
	 * through, one of these commits takes this colour index, and its first
	 * parents inherit it. Indices may lie beyond `colourCount`; the rotation
	 * for other lanes never hands them out.
	 */
	readonly laneColours: ReadonlyMap<Hash, number>;
}

const DEFAULT_OPTIONS: LayoutOptions = {
	pinnedBranches: [],
	colourCount: 12,
	dashedRows: new Set<Hash>(),
	laneColours: new Map()
};

/**
 * Assigns each commit a column and colour, and produces the edges between them.
 *
 * Commits must already be in display order (whatever ordering `git log` was
 * asked for); the layout never reorders them, so what is drawn always matches
 * what git reported.
 *
 * The approach is the standard lane-allocation sweep: walk the commits in
 * order, place each on the leftmost lane awaiting it, then hand its parents
 * lanes of their own. The first parent inherits the commit's lane and colour,
 * which is what keeps a long-lived branch a single straight line of one colour
 * rather than a rainbow that changes at every merge (#254).
 */
export function layoutGraph(commits: readonly Commit[], options: Partial<LayoutOptions> = {}): GraphLayout {
	const opts: LayoutOptions = { ...DEFAULT_OPTIONS, ...options };
	const lanes: (Lane | null)[] = [];
	const vertices: GraphVertex[] = [];
	const edges: GraphEdge[] = [];
	let nextColour = 0;

	const takeColour = (): number => {
		const colour = nextColour % Math.max(1, opts.colourCount);
		nextColour++;
		return colour;
	};

	// Reserve the leftmost columns for pinned branches before anything else, so
	// their column index never depends on the order commits happen to arrive.
	const pinnedColumns = new Map<Hash, number>();
	for (const branch of opts.pinnedBranches) {
		if (pinnedColumns.has(branch.hash)) continue;
		const column = lanes.length;
		lanes.push({ expects: branch.hash, colour: opts.laneColours.get(branch.hash) ?? takeColour(), pending: [], pinned: true });
		pinnedColumns.set(branch.hash, column);
	}

	/** Leftmost column with no live lane, extending the array when full. */
	const firstFreeColumn = (): number => {
		for (let i = 0; i < lanes.length; i++) {
			if (lanes[i] === null) return i;
		}
		lanes.push(null);
		return lanes.length - 1;
	};

	for (let index = 0; index < commits.length; index++) {
		const commit = commits[index];

		// Every lane awaiting this commit converges here. The leftmost one wins
		// the column; the rest are drawn into it and released.
		const matching: number[] = [];
		for (let column = 0; column < lanes.length; column++) {
			if (lanes[column]?.expects === commit.hash) matching.push(column);
		}

		let column: number;
		let colour: number;
		if (matching.length > 0) {
			column = matching[0];
			colour = lanes[matching[0]]!.colour;
		} else {
			// A branch tip: nothing pointed here, so start a new lane.
			column = firstFreeColumn();
			colour = opts.laneColours.get(commit.hash) ?? takeColour();
		}
		// A fixed-colour branch whose tip another lane reached first still
		// takes its colour from here down.
		colour = opts.laneColours.get(commit.hash) ?? colour;

		for (const matchedColumn of matching) {
			const lane = lanes[matchedColumn]!;
			for (const pending of lane.pending) {
				edges.push({
					fromIndex: pending.fromIndex,
					toIndex: index,
					fromColumn: pending.fromColumn,
					toColumn: column,
					laneColumn: pending.laneColumn,
					colour: pending.colour,
					dashed: pending.dashed
				});
			}
			lane.pending = [];
			// Release the merged-in lanes, but keep a pinned column reserved so
			// the branch it belongs to stays in the same place further down.
			if (matchedColumn !== column) {
				lanes[matchedColumn] = lane.pinned ? { ...lane, expects: '', pending: [] } : null;
			}
		}

		const dashed = opts.dashedRows.has(commit.hash);
		vertices.push({ hash: commit.hash, column, colour, dimmed: false });

		// The first parent continues this lane, inheriting the colour. Later
		// parents are the branches being merged in and get lanes of their own.
		const [firstParent, ...otherParents] = commit.parents;

		if (firstParent === undefined) {
			// A root commit ends its lane, unless the column is reserved.
			const lane = lanes[column];
			lanes[column] = lane !== null && lane.pinned ? { ...lane, expects: '', pending: [] } : null;
		} else {
			lanes[column] = {
				expects: firstParent,
				colour,
				pending: [{ fromIndex: index, fromColumn: column, laneColumn: column, colour, dashed }],
				pinned: lanes[column]?.pinned ?? false
			};
		}

		for (const parent of otherParents) {
			// Join an existing lane heading for the same parent rather than
			// opening a duplicate one beside it.
			const existing = lanes.findIndex((lane) => lane !== null && lane.expects === parent);
			if (existing !== -1) {
				lanes[existing]!.pending.push({
					fromIndex: index,
					fromColumn: column,
					laneColumn: existing,
					colour: lanes[existing]!.colour,
					dashed
				});
				continue;
			}

			const parentColumn = pinnedColumns.get(parent) ?? firstFreeColumn();
			const parentColour = opts.laneColours.get(parent) ?? takeColour();
			const reserved = lanes[parentColumn];
			lanes[parentColumn] = {
				expects: parent,
				colour: reserved?.pinned === true ? reserved.colour : parentColour,
				pending: [
					{
						fromIndex: index,
						fromColumn: column,
						laneColumn: parentColumn,
						colour: reserved?.pinned === true ? reserved.colour : parentColour,
						dashed
					}
				],
				pinned: reserved?.pinned ?? false
			};
		}
	}

	// Commits whose parents were not loaded still need their edge drawn, so it
	// can trail off the bottom of the view rather than stopping mid-air.
	for (let column = 0; column < lanes.length; column++) {
		const lane = lanes[column];
		if (lane === null) continue;
		for (const pending of lane.pending) {
			edges.push({
				fromIndex: pending.fromIndex,
				toIndex: -1,
				fromColumn: pending.fromColumn,
				toColumn: pending.laneColumn,
				laneColumn: pending.laneColumn,
				colour: pending.colour,
				dashed: pending.dashed
			});
		}
	}

	let width = 0;
	for (const vertex of vertices) width = Math.max(width, vertex.column + 1);
	for (const edge of edges) width = Math.max(width, edge.laneColumn + 1, edge.toColumn + 1);

	return { vertices, edges, width };
}
