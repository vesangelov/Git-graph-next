import type { GraphEdge, GraphLayout, Hash } from '../../src/types.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface GraphGeometry {
	/** Height of one table row, in pixels. */
	readonly rowHeight: number;
	/** Horizontal distance between lanes. */
	readonly columnWidth: number;
	/** Space left of the first lane. */
	readonly paddingLeft: number;
	readonly style: 'rounded' | 'angular';
}

export const DEFAULT_GEOMETRY: GraphGeometry = { rowHeight: 24, columnWidth: 16, paddingLeft: 10, style: 'rounded' };

export function graphPixelWidth(layout: GraphLayout, geometry: GraphGeometry): number {
	return geometry.paddingLeft * 2 + Math.max(0, layout.width - 1) * geometry.columnWidth + 2;
}

/** The last row an edge touches; edges to unloaded parents run to the end. */
export function edgeEndRow(edge: GraphEdge, rowCount: number): number {
	return edge.toIndex === -1 ? rowCount : edge.toIndex;
}

/**
 * SVG path data for an edge, with row 0 at y = 0 of the drawing.
 *
 * An edge leaves its child, bends into its lane within the first row if the
 * lane is elsewhere (a merge's second parent), runs straight down the lane, and
 * bends into the parent's column within the last row if the lane converges
 * there (a branch joining back). Bends are confined to a single row so lines
 * never cross a commit circle on the way.
 */
export function edgePath(edge: GraphEdge, geometry: GraphGeometry, rowCount: number): string {
	const { rowHeight: h, columnWidth: w, paddingLeft } = geometry;
	const x = (column: number) => paddingLeft + column * w;
	const y = (row: number) => row * h + h / 2;

	const x1 = x(edge.fromColumn);
	const y1 = y(edge.fromIndex);
	const xl = x(edge.laneColumn);
	const x2 = x(edge.toColumn);
	// An edge to an unloaded parent trails off below the last loaded row.
	const y2 = edge.toIndex === -1 ? y(rowCount) + h / 2 : y(edge.toIndex);

	const bend = (xa: number, ya: number, xb: number, yb: number): string => {
		if (geometry.style === 'angular') return `L${xb},${yb}`;
		const mid = (ya + yb) / 2;
		return `C${xa},${mid} ${xb},${mid} ${xb},${yb}`;
	};

	let d = `M${x1},${y1}`;
	const bendOut = x1 !== xl;
	const bendIn = x2 !== xl && edge.toIndex !== -1;

	// Adjacent rows leave no room for two bends; go straight to the parent.
	if (bendOut && bendIn && y2 - y1 <= h) return d + bend(x1, y1, x2, y2);

	let cursor = y1;
	if (bendOut) {
		d += bend(x1, y1, xl, y1 + h);
		cursor = y1 + h;
	}
	if (bendIn) {
		if (y2 - h > cursor) d += `L${xl},${y2 - h}`;
		d += bend(xl, Math.max(cursor, y2 - h), x2, y2);
	} else if (y2 > cursor) {
		d += `L${xl},${y2}`;
	}
	return d;
}

export interface GraphRenderInput {
	readonly layout: GraphLayout;
	readonly geometry: GraphGeometry;
	readonly colours: readonly string[];
	readonly rowCount: number;
	/** First and last row index (inclusive) to draw. */
	readonly first: number;
	readonly last: number;
	readonly headHash: Hash | null;
	/** Synthetic rows (uncommitted, staged), drawn as open circles. */
	readonly uncommittedHashes: ReadonlySet<Hash>;
	/** Hashes of stash rows, drawn with a distinct marker. */
	readonly stashHashes: ReadonlySet<Hash>;
	/** Stand-in rows for collapsed runs (#387), drawn as a dashed ring. */
	readonly collapsedHashes?: ReadonlyMap<Hash, unknown>;
}

/**
 * Draws the rows `first..last` into `svg`, which the caller positions at the
 * top of row `first`. Only elements intersecting that window are created, so
 * the cost of a scroll is independent of the size of the history.
 */
export function renderGraph(svg: SVGSVGElement, input: GraphRenderInput): void {
	const { layout, geometry, colours, first, last, rowCount } = input;
	const h = geometry.rowHeight;
	const colour = (index: number) => colours[index % colours.length] ?? '#888';

	svg.replaceChildren();
	svg.setAttribute('width', String(graphPixelWidth(layout, geometry)));
	svg.setAttribute('height', String((last - first + 1) * h));

	// Everything is computed in whole-graph coordinates and shifted up once.
	const group = document.createElementNS(SVG_NS, 'g');
	group.setAttribute('transform', `translate(0,${-first * h})`);
	svg.appendChild(group);

	const edgeLayer = document.createElementNS(SVG_NS, 'g');
	const vertexLayer = document.createElementNS(SVG_NS, 'g');
	group.append(edgeLayer, vertexLayer);

	for (const edge of layout.edges) {
		if (edge.fromIndex > last || edgeEndRow(edge, rowCount) < first) continue;
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', edgePath(edge, geometry, rowCount));
		path.setAttribute('class', edge.dashed ? 'edge dashed' : 'edge');
		path.setAttribute('stroke', edge.dashed ? 'currentColor' : colour(edge.colour));
		// Lets the view dim every other line while one is hovered (#270).
		path.setAttribute('data-lane', String(edge.colour));
		edgeLayer.appendChild(path);
	}

	for (let row = Math.max(0, first); row <= Math.min(last, layout.vertices.length - 1); row++) {
		const vertex = layout.vertices[row];
		const cx = geometry.paddingLeft + vertex.column * geometry.columnWidth;
		const cy = row * h + h / 2;
		const stroke = colour(vertex.colour);

		const circle = document.createElementNS(SVG_NS, 'circle');
		circle.setAttribute('data-lane', String(vertex.colour));
		circle.setAttribute('cx', String(cx));
		circle.setAttribute('cy', String(cy));
		if (input.collapsedHashes?.has(vertex.hash) === true) {
			circle.setAttribute('r', '4.5');
			circle.setAttribute('class', 'vertex collapsed');
			circle.setAttribute('stroke', stroke);
		} else if (input.uncommittedHashes.has(vertex.hash)) {
			circle.setAttribute('r', '4');
			circle.setAttribute('class', 'vertex uncommitted');
		} else if (vertex.hash === input.headHash) {
			// The checked-out commit is hollow, so it can be found at a glance.
			circle.setAttribute('r', '4.5');
			circle.setAttribute('class', 'vertex head');
			circle.setAttribute('stroke', stroke);
		} else if (input.stashHashes.has(vertex.hash)) {
			circle.setAttribute('r', '4.5');
			circle.setAttribute('class', 'vertex stash');
			circle.setAttribute('stroke', stroke);
			const dot = document.createElementNS(SVG_NS, 'circle');
			dot.setAttribute('cx', String(cx));
			dot.setAttribute('cy', String(cy));
			dot.setAttribute('r', '1.8');
			dot.setAttribute('fill', stroke);
			vertexLayer.append(circle, dot);
			continue;
		} else {
			circle.setAttribute('r', '4');
			circle.setAttribute('class', 'vertex');
			circle.setAttribute('fill', stroke);
		}
		vertexLayer.appendChild(circle);
	}
}
