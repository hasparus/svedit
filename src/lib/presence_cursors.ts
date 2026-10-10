/**
 * Encode and decode selections as Automerge cursors (stable positions in a
 * text sequence) instead of raw offsets.
 *
 * A peer broadcasts where its caret is. By the time another peer renders it,
 * concurrent edits may have shifted the text, so a raw offset points at the
 * wrong character. A cursor from `Automerge.getCursor` resolves to the
 * current index on any doc of the same lineage (`getCursorPosition`).
 *
 * Units: Svedit selection offsets count grapheme clusters, while Automerge
 * text is indexed in UTF-16 code units. Offsets are converted at the boundary.
 *
 * Automerge cursors are text-only, but node arrays hold stable node ids. A
 * node boundary is anchored to the id it sits before (`null` for the end of
 * the array) and resolved back to an index by id lookup. Property selections
 * have no offsets and pass through unchanged.
 */
import { char_to_utf16_offset, utf16_to_char_offset } from './utils.js';
import type { DocumentPath, Selection } from './types.js';

/** The slice of `@automerge/automerge` the codec needs. */
export type CursorApi = {
	getCursor: (doc: unknown, path: Array<string | number>, position: number) => string;
	getCursorPosition: (doc: unknown, path: Array<string | number>, cursor: string) => number;
};

/** A text selection on the wire. `anchor` and `focus` are opaque Automerge cursors. */
export type WireTextSelection = {
	type: 'text';
	path: DocumentPath;
	anchor: string;
	focus: string;
};

/** A node selection on the wire: the ids each boundary sits before, `null` for the end. */
export type WireNodeSelection = {
	type: 'node';
	path: DocumentPath;
	anchor_id: string | null;
	focus_id: string | null;
};

/** Property selections travel as-is; text and node selections are anchored. */
export type WireSelection = WireTextSelection | WireNodeSelection | Selection;

type Owner = { node_id: string; prop: string };
type NodesDoc = { nodes?: Record<string, Record<string, unknown>> };

const node_ids_of = (value: unknown): unknown[] | null => {
	const nodes = (value as { nodes?: unknown } | null)?.nodes;
	return Array.isArray(nodes) ? nodes : null;
};

/**
 * Resolve a document path (e.g. `['page_1', 'body', 0, 'content']`) to the
 * node id and property that own its final value. The Automerge doc is a flat
 * node map, so each array index is dereferenced through the node array's
 * ids and each single-node property through its id. Returns `null` when a hop
 * does not resolve (deleted node, scalar where a node was expected).
 */
function resolve_owner(doc: unknown, path: DocumentPath): Owner | null {
	const nodes = (doc as NodesDoc)?.nodes;
	if (!nodes || path.length < 2) return null;
	const prop = path[path.length - 1];
	const root = path[0];
	if (typeof prop !== 'string' || typeof root !== 'string') return null;
	let node = nodes[root];
	if (!node) return null;
	let node_id = root;

	let i = 1;
	while (i < path.length - 1) {
		const segment = path[i];
		if (typeof segment !== 'string') return null;
		const value = node[segment];
		const next = path[i + 1];
		let child_id: unknown;
		if (typeof next === 'number') {
			child_id = node_ids_of(value)?.[next];
			i += 2;
		} else {
			child_id = value;
			i += 1;
		}
		if (typeof child_id !== 'string') return null;
		const child = nodes[child_id];
		if (!child) return null;
		node = child;
		node_id = child_id;
	}
	return { node_id, prop };
}

const owned_value = (doc: unknown, owner: Owner): unknown =>
	(doc as NodesDoc)?.nodes?.[owner.node_id]?.[owner.prop];

const owned_content = (value: unknown): string | null => {
	const content = (value as { content?: unknown } | null)?.content;
	return typeof content === 'string' ? content : null;
};

const content_path = (owner: Owner): Array<string | number> => [
	'nodes',
	owner.node_id,
	owner.prop,
	'content'
];

function boundary_id(ids: unknown[], offset: number): string | null {
	const id = ids[offset];
	return typeof id === 'string' ? id : null;
}

/** A deleted boundary id clamps to the end of the array. */
function resolve_boundary(ids: unknown[], id: string | null): number {
	if (id === null) return ids.length;
	const index = ids.indexOf(id);
	return index === -1 ? ids.length : index;
}

/** Svedit selection (grapheme offsets) to wire form. Falls back to the plain selection. */
export function encode_selection(
	api: CursorApi,
	doc: unknown,
	selection: Selection | null
): WireSelection | null {
	if (!selection) return null;
	if (selection.type === 'text') {
		const owner = resolve_owner(doc, selection.path);
		const content = owner && owned_content(owned_value(doc, owner));
		if (content === null || !owner) return selection;
		const path = content_path(owner);
		try {
			return {
				type: 'text',
				path: selection.path,
				anchor: api.getCursor(doc, path, char_to_utf16_offset(content, selection.anchor_offset)),
				focus: api.getCursor(doc, path, char_to_utf16_offset(content, selection.focus_offset))
			};
		} catch {
			return selection;
		}
	}
	if (selection.type === 'node') {
		const owner = resolve_owner(doc, selection.path);
		const ids = owner && node_ids_of(owned_value(doc, owner));
		if (!ids) return selection;
		return {
			type: 'node',
			path: selection.path,
			anchor_id: boundary_id(ids, selection.anchor_offset),
			focus_id: boundary_id(ids, selection.focus_offset)
		};
	}
	return selection;
}

/**
 * Wire form to Svedit selection against the current doc. `null` when the
 * anchored text is gone or a cursor does not resolve.
 */
export function decode_selection(
	api: CursorApi,
	doc: unknown,
	wire: WireSelection | null
): Selection | null {
	if (!wire) return null;
	if (wire.type === 'text' && 'anchor' in wire && typeof wire.anchor === 'string') {
		const owner = resolve_owner(doc, wire.path);
		const content = owner && owned_content(owned_value(doc, owner));
		if (content === null || !owner) return null;
		const path = content_path(owner);
		try {
			return {
				type: 'text',
				path: wire.path,
				anchor_offset: utf16_to_char_offset(content, api.getCursorPosition(doc, path, wire.anchor)),
				focus_offset: utf16_to_char_offset(content, api.getCursorPosition(doc, path, wire.focus))
			};
		} catch {
			return null;
		}
	}
	if (wire.type === 'node' && 'anchor_id' in wire) {
		const owner = resolve_owner(doc, wire.path);
		const ids = owner && node_ids_of(owned_value(doc, owner));
		if (!ids) return null;
		return {
			type: 'node',
			path: wire.path,
			anchor_offset: resolve_boundary(ids, wire.anchor_id),
			focus_offset: resolve_boundary(ids, wire.focus_id)
		};
	}
	return wire as Selection;
}
