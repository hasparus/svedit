/**
 * Automerge binding for `Session`.
 *
 * Session keeps only the stateful glue (the handle, the threaded fns and the
 * re-entry flags). The pure mechanics live here: mirroring Svedit ops into an
 * Automerge draft, rebuilding marks and annotations from Automerge marks,
 * text splicing, and a node-identity-preserving merge of remote changes.
 *
 * Svedit does not depend on Automerge. The app passes the few Automerge
 * functions it needs (`splice`, `mark`, `unmark`, `marks`, `getCursor`,
 * `getCursorPosition`) when attaching a handle.
 */

import type { Attachment, DocumentNode, DocumentOperation, Text } from './types.js';
import { char_to_utf16_offset, get_char_length, utf16_to_char_offset } from './utils.js';

export type AutomergePath = Array<string | number>;

export type SpliceFn = (
	doc: unknown,
	path: AutomergePath,
	index: number,
	delete_count: number,
	value?: string
) => void;

export type MarkRange = { start: number; end: number; expand?: string };

export type MarkFn = (
	doc: unknown,
	path: AutomergePath,
	range: MarkRange,
	name: string,
	value: unknown
) => void;

export type UnmarkFn = (doc: unknown, path: AutomergePath, range: MarkRange, name: string) => void;

/** An Automerge mark as returned by `Automerge.marks`. */
export type AutomergeMark = { name: string; value: unknown; start: number; end: number };

export type MarksFn = (doc: unknown, path: AutomergePath) => AutomergeMark[];

/** Automerge cursor fns: stable text positions across concurrent edits. */
export type GetCursorFn = (doc: unknown, path: AutomergePath, position: number) => string;
export type GetCursorPositionFn = (doc: unknown, path: AutomergePath, cursor: string) => number;

/**
 * The Automerge functions Session uses. Keys match the Automerge API names.
 * Without `splice`, text is replaced wholesale. Without `mark`/`unmark`/
 * `marks`, marks and annotations travel only as plain arrays. Without the
 * cursor fns, the local caret is not remapped across remote edits.
 */
export type AutomergeTextFns = {
	splice?: SpliceFn;
	mark?: MarkFn;
	unmark?: UnmarkFn;
	marks?: MarksFn;
	getCursor?: GetCursorFn;
	getCursorPosition?: GetCursorPositionFn;
};

export type AutomergeDoc = {
	nodes?: Record<string, DocumentNode>;
	[key: string]: unknown;
};

/**
 * The `change` event payload. `patches` lists what changed, `patchInfo`
 * carries the docs before and after the change.
 */
export type AutomergeChangePayload = {
	patches?: Array<{ action: string; path: Array<string | number> }>;
	patchInfo?: { before?: AutomergeDoc; after?: AutomergeDoc };
};

/**
 * Whether a change replaced a doc's whole `nodes` map (a reset done outside
 * the editor), as opposed to node-level edits.
 */
export function is_nodes_reset(payload: AutomergeChangePayload | undefined): boolean {
	return !!payload?.patches?.some(
		(p) => p.action === 'put' && p.path.length === 1 && p.path[0] === 'nodes'
	);
}

/**
 * Property values that stay in this session, e.g. a `blob:` preview before
 * its upload lands. They never reach a bound doc, and remote changes do not
 * overwrite them unless they set that same property.
 */
export type LocalOnlyFn = (value: unknown) => boolean;

/** The slice of an Automerge `DocHandle` Session uses. */
export type AutomergeHandle = {
	change: (fn: (d: AutomergeDoc) => void) => void;
	doc: () => AutomergeDoc | undefined;
	on: (event: 'change', fn: (payload: AutomergeChangePayload) => void) => void;
	off: (event: 'change', fn: (payload: AutomergeChangePayload) => void) => void;
};

/** Automerge mark name prefixes for text marks and text annotations. */
export const MARK_PREFIX = 'mark:';
export const ANNOTATION_PREFIX = 'annotation:';

/**
 * Structural check for a `text` property value
 * (`{ content, marks, annotations }`).
 */
export function is_text_value(value: unknown): value is Text {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as { content?: unknown }).content === 'string' &&
		Array.isArray((value as { marks?: unknown }).marks) &&
		Array.isArray((value as { annotations?: unknown }).annotations)
	);
}

/**
 * Key-order-insensitive structural equality for node payloads.
 *
 * The Automerge-materialised node can list the same fields in a different
 * order than the local one, so `JSON.stringify` comparison would report
 * untouched nodes as changed and drop their identity (and the caret in them).
 */
export function node_payload_equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return false;
	if (typeof a !== 'object') return false;
	const a_is_array = Array.isArray(a);
	if (a_is_array !== Array.isArray(b)) return false;
	if (a_is_array) {
		const aa = a as unknown[];
		const bb = b as unknown[];
		if (aa.length !== bb.length) return false;
		for (let i = 0; i < aa.length; i++) {
			if (!node_payload_equal(aa[i], bb[i])) return false;
		}
		return true;
	}
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const a_keys = Object.keys(ao);
	if (a_keys.length !== Object.keys(bo).length) return false;
	for (const key of a_keys) {
		if (!Object.hasOwn(bo, key)) return false;
		if (!node_payload_equal(ao[key], bo[key])) return false;
	}
	return true;
}

/**
 * Turn a text change into the smallest single Automerge splice that produces
 * it (common prefix and suffix stay untouched). Insert, delete and paste
 * collapse to one splice that still merges with concurrent edits elsewhere in
 * the same string.
 */
export function apply_text_splice(
	splice_fn: SpliceFn,
	doc: unknown,
	path: AutomergePath,
	old_text: string,
	new_text: string
): void {
	if (old_text === new_text) return;
	let prefix = 0;
	const max_prefix = Math.min(old_text.length, new_text.length);
	while (prefix < max_prefix && old_text.charCodeAt(prefix) === new_text.charCodeAt(prefix)) {
		prefix++;
	}
	let suffix = 0;
	const max_suffix = Math.min(old_text.length - prefix, new_text.length - prefix);
	while (
		suffix < max_suffix &&
		old_text.charCodeAt(old_text.length - 1 - suffix) ===
			new_text.charCodeAt(new_text.length - 1 - suffix)
	) {
		suffix++;
	}
	const delete_count = old_text.length - prefix - suffix;
	const insert_text = new_text.slice(prefix, new_text.length - suffix);
	if (delete_count === 0 && insert_text.length === 0) return;
	splice_fn(doc, path, prefix, delete_count, insert_text);
}

type MarkOp = { name: string; value: string; start: number; end: number };

const attachment_key = (a: Attachment) => `${a.node_id}:${a.start_offset}:${a.end_offset}`;

/**
 * Diff two attachment arrays into Automerge mark ops. `add` offsets are
 * UTF-16 indexes into `new_content`. `remove` lists mark names only: names
 * are unique per payload node, so a removal unmarks the whole text, which
 * also covers ranges Automerge shifted since they were marked.
 */
export function diff_attachments_to_mark_ops(
	prefix: string,
	old_attachments: Attachment[],
	new_attachments: Attachment[],
	new_content: string
): { add: MarkOp[]; remove: string[] } {
	const old_keys = new Set(old_attachments.map(attachment_key));
	const new_keys = new Set(new_attachments.map(attachment_key));
	return {
		add: new_attachments
			.filter((a) => !old_keys.has(attachment_key(a)))
			.map((a) => ({
				name: prefix + a.node_id,
				value: a.node_id,
				start: char_to_utf16_offset(new_content, a.start_offset),
				end: char_to_utf16_offset(new_content, a.end_offset)
			})),
		remove: old_attachments
			.filter((a) => !new_keys.has(attachment_key(a)))
			.map((a) => prefix + a.node_id)
	};
}

/** Automerge marks with the given prefix, as Svedit attachments (grapheme offsets). */
export function marks_to_attachments(
	prefix: string,
	marks: AutomergeMark[],
	content: string
): Attachment[] {
	const attachments: Attachment[] = [];
	for (const m of marks) {
		if (!m.name.startsWith(prefix)) continue;
		if (m.end <= m.start) continue;
		attachments.push({
			node_id: String(m.value ?? m.name.slice(prefix.length)),
			start_offset: utf16_to_char_offset(content, m.start),
			end_offset: utf16_to_char_offset(content, m.end)
		});
	}
	return attachments;
}

/**
 * Union of Automerge-derived attachments and array attachments that have no
 * Automerge mark yet (e.g. a doc seeded without the mark fns). Mark-derived
 * entries win per node id, since Automerge keeps their offsets current
 * across concurrent splices.
 */
export function merge_attachments(
	from_marks: Attachment[],
	from_array: Attachment[]
): Attachment[] {
	const marked_ids = new Set(from_marks.map((a) => a.node_id));
	const array_only = from_array.filter((a) => !marked_ids.has(a.node_id));
	return [...from_marks, ...array_only].sort(
		(a, b) => a.start_offset - b.start_offset || a.end_offset - b.end_offset
	);
}

export type NormalizeOptions = {
	/**
	 * For exclusive attachments: which of two overlapping ones keeps the
	 * overlap (higher wins). Defaults to the earlier one.
	 */
	rank?: (attachment: Attachment) => number;
	/** Called for every attachment that was dropped (`after` null) or trimmed. */
	on_change?: (before: Attachment, after: Attachment | null) => void;
};

/**
 * Rank attachments whose payload node carries data in one of `fields`
 * (by default a link's `href`) above plain formatting, so formatting never
 * costs a link.
 */
export function rank_by_payload(
	get_node: (id: string) => DocumentNode | undefined,
	fields: readonly string[] = ['href']
): (attachment: Attachment) => number {
	return (attachment) => {
		const node = get_node(attachment.node_id);
		return node && fields.some((field) => node[field] != null && node[field] !== '') ? 1 : 0;
	};
}

/** The parts of [start, end) not covered by `taken`, longest first. */
function free_segments(start: number, end: number, taken: Attachment[]): Array<[number, number]> {
	let segments: Array<[number, number]> = [[start, end]];
	for (const t of taken) {
		segments = segments.flatMap(([s, e]): Array<[number, number]> => {
			if (t.end_offset <= s || t.start_offset >= e) return [[s, e]];
			const parts: Array<[number, number]> = [];
			if (t.start_offset > s) parts.push([s, t.start_offset]);
			if (t.end_offset < e) parts.push([t.end_offset, e]);
			return parts;
		});
	}
	return segments.sort((a, b) => b[1] - b[0] - (a[1] - a[0]) || a[0] - b[0]);
}

/**
 * Clamp attachments to the content length and drop empty ones. For marks
 * (`exclusive`), resolve overlaps, which concurrent edits can produce: the
 * higher-ranked mark keeps the overlap and the other one is trimmed to its
 * longest remaining part (an attachment node may be referenced only once,
 * so it can't be split), or dropped if nothing remains.
 */
export function normalize_attachments(
	attachments: Attachment[],
	content: string,
	exclusive: boolean,
	{ rank = () => 0, on_change }: NormalizeOptions = {}
): Attachment[] {
	const length = get_char_length(content);
	const clamped: Attachment[] = [];
	for (const a of attachments) {
		const start_offset = Math.max(0, Math.min(a.start_offset, length));
		const end_offset = Math.max(0, Math.min(a.end_offset, length));
		if (end_offset <= start_offset) {
			on_change?.(a, null);
			continue;
		}
		const next = { ...a, start_offset, end_offset };
		if (start_offset !== a.start_offset || end_offset !== a.end_offset) on_change?.(a, next);
		clamped.push(next);
	}
	if (!exclusive) return clamped;

	const ordered = [...clamped].sort(
		(a, b) => rank(b) - rank(a) || a.start_offset - b.start_offset || a.end_offset - b.end_offset
	);
	const kept: Attachment[] = [];
	for (const a of ordered) {
		const [best] = free_segments(a.start_offset, a.end_offset, kept);
		if (!best) {
			on_change?.(a, null);
			continue;
		}
		const next = { ...a, start_offset: best[0], end_offset: best[1] };
		if (best[0] !== a.start_offset || best[1] !== a.end_offset) on_change?.(a, next);
		kept.push(next);
	}
	return kept.sort((a, b) => a.start_offset - b.start_offset);
}

function reconcile_text_value(
	value: Text,
	am_marks: AutomergeMark[],
	rank: (attachment: Attachment) => number
): Text {
	const content = value.content;
	const marks = normalize_attachments(
		merge_attachments(marks_to_attachments(MARK_PREFIX, am_marks, content), value.marks),
		content,
		true,
		{ rank }
	);
	const annotations = normalize_attachments(
		merge_attachments(
			marks_to_attachments(ANNOTATION_PREFIX, am_marks, content),
			value.annotations
		),
		content,
		false
	);
	return { content, marks, annotations };
}

/**
 * Reconcile remote Automerge docs into the next local node map. `next` is one
 * doc or several (a body plus docs it shares nodes with); a node present in
 * more than one comes from the last. In one pass it:
 *   1. rebuilds text marks and annotations from Automerge marks;
 *   2. keeps local-only values (`local_only`) unless the remote change set
 *      that same property (`before[i]` is source i's doc before the change,
 *      when known), so a peer's newer value beats a stale local preview;
 *   3. reuses the existing node object when nothing changed, so Svedit skips
 *      re-rendering it and the local caret in an untouched node survives;
 *   4. reports whether anything changed, so the caller can skip the
 *      reassignment on a no-op echo.
 */
export function reconcile_remote_nodes(
	current: Record<string, DocumentNode>,
	next: AutomergeDoc | AutomergeDoc[],
	marks_fn: MarksFn | null,
	opts: { local_only?: LocalOnlyFn | null; before?: Array<AutomergeDoc | undefined> } = {}
): { nodes: Record<string, DocumentNode>; changed: boolean } {
	const sources = Array.isArray(next) ? next : [next];
	const owner = new Map<string, number>();
	sources.forEach((doc, index) => {
		for (const id of Object.keys(doc.nodes ?? {})) owner.set(id, index);
	});
	const result: Record<string, DocumentNode> = {};
	let changed = owner.size !== Object.keys(current).length;
	const rank = rank_by_payload((id) => {
		const index = owner.get(id);
		return index === undefined ? undefined : sources[index].nodes[id];
	});
	for (const [id, index] of owner) {
		const doc = sources[index];
		const node = doc.nodes[id];
		let overlaid: DocumentNode = node;
		if (marks_fn) {
			for (const [prop, value] of Object.entries(node)) {
				if (!is_text_value(value)) continue;
				const am_marks = marks_fn(doc, ['nodes', id, prop, 'content']);
				const reconciled = reconcile_text_value(value, am_marks, rank);
				if (node_payload_equal(reconciled, value)) continue;
				if (overlaid === node) overlaid = { ...node };
				overlaid[prop] = reconciled;
			}
		}
		const cur = current[id];
		if (cur && opts.local_only) {
			const before = opts.before?.[index]?.nodes?.[id];
			for (const [prop, value] of Object.entries(cur)) {
				if (!opts.local_only(value)) continue;
				if (before && !node_payload_equal(before[prop], node[prop])) continue;
				if (overlaid === node) overlaid = { ...node };
				overlaid[prop] = value;
			}
		}
		if (cur && node_payload_equal(cur, overlaid)) {
			result[id] = cur;
		} else {
			result[id] = overlaid === node ? structuredClone(node) : overlaid;
			changed = true;
		}
	}
	return { nodes: result, changed };
}

/**
 * Split ops between bound docs by the doc owning each node
 * (`owner_of(node_id)` is a doc index). Deletes go to every doc.
 */
export function partition_ops(
	ops: DocumentOperation[],
	count: number,
	owner_of: (node_id: string) => number
): DocumentOperation[][] {
	const parts: DocumentOperation[][] = Array.from({ length: count }, () => []);
	for (const op of ops) {
		const [type, arg] = op;
		if (type === 'delete') {
			for (const part of parts) part.push(op);
		} else if (type === 'set') {
			parts[owner_of(arg[0])].push(op);
		} else if (type === 'create') {
			parts[owner_of(arg.id)].push(op);
		}
	}
	return parts;
}

function mirror_attachments(
	d: unknown,
	path: AutomergePath,
	prefix: string,
	old_attachments: Attachment[],
	new_attachments: Attachment[],
	new_content: string,
	mark_fn: MarkFn,
	unmark_fn: UnmarkFn
) {
	const { add, remove } = diff_attachments_to_mark_ops(
		prefix,
		old_attachments,
		new_attachments,
		new_content
	);
	if (new_content.length > 0) {
		for (const name of new Set(remove)) {
			unmark_fn(d, path, { start: 0, end: new_content.length, expand: 'none' }, name);
		}
	}
	for (const m of add) {
		mark_fn(d, path, { start: m.start, end: m.end, expand: 'none' }, m.name, m.value);
	}
}

/** Add Automerge marks for every mark and annotation of a freshly assigned text value. */
function mark_text_value(d: unknown, path: AutomergePath, value: Text, mark_fn: MarkFn) {
	for (const [prefix, attachments] of [
		[MARK_PREFIX, value.marks],
		[ANNOTATION_PREFIX, value.annotations]
	] as const) {
		for (const a of attachments) {
			const start = char_to_utf16_offset(value.content, a.start_offset);
			const end = char_to_utf16_offset(value.content, a.end_offset);
			mark_fn(d, path, { start, end, expand: 'none' }, prefix + a.node_id, a.node_id);
		}
	}
}

function mark_text_properties(d: AutomergeDoc, node: DocumentNode, mark_fn: MarkFn | null) {
	if (!mark_fn) return;
	for (const [property, value] of Object.entries(node)) {
		if (is_text_value(value)) {
			mark_text_value(d, ['nodes', node.id, property, 'content'], value, mark_fn);
		}
	}
}

/**
 * Apply Svedit ops to a bound Automerge draft:
 *   ['set', [node_id, property], value] assigns the value; `undefined`
 *     deletes the property (Automerge rejects undefined). A text value
 *     splices `content` and mirrors marks and annotations to Automerge marks,
 *     so concurrent edits merge.
 *   ['create', node] adds the node, with Automerge marks for its text.
 *   ['delete', node_id] removes the node.
 * Unknown op types are ignored. Local-only values are withheld: a `set` of
 * one is skipped, a created node carries `''` in its place.
 */
export function mirror_ops_to_doc(
	d: AutomergeDoc,
	ops: DocumentOperation[],
	fns: {
		splice: SpliceFn | null;
		mark: MarkFn | null;
		unmark: UnmarkFn | null;
		local_only?: LocalOnlyFn | null;
	}
): void {
	if (!d.nodes) d.nodes = {};
	const nodes = d.nodes;
	const { splice: splice_fn, mark: mark_fn, unmark: unmark_fn, local_only } = fns;
	for (const [type, ...args] of ops) {
		if (type === 'set') {
			const [node_id, property] = args[0] as [string, string];
			const new_value = args[1];
			if (local_only?.(new_value)) continue;
			if (new_value === undefined) {
				if (nodes[node_id]) delete nodes[node_id][property];
				continue;
			}
			if (!nodes[node_id]) nodes[node_id] = { id: node_id } as DocumentNode;
			const old_value = nodes[node_id][property];
			if (splice_fn && is_text_value(new_value) && is_text_value(old_value)) {
				const content_path = ['nodes', node_id, property, 'content'];
				// Plain copies: the draft's list items are replaced below.
				const old_marks = old_value.marks.map((a) => ({ ...a }));
				const old_annotations = old_value.annotations.map((a) => ({ ...a }));
				apply_text_splice(splice_fn, d, content_path, old_value.content, new_value.content);
				const target = nodes[node_id][property] as Text;
				target.marks = structuredClone(new_value.marks);
				target.annotations = structuredClone(new_value.annotations);
				if (mark_fn && unmark_fn) {
					mirror_attachments(
						d,
						content_path,
						MARK_PREFIX,
						old_marks,
						new_value.marks,
						new_value.content,
						mark_fn,
						unmark_fn
					);
					mirror_attachments(
						d,
						content_path,
						ANNOTATION_PREFIX,
						old_annotations,
						new_value.annotations,
						new_value.content,
						mark_fn,
						unmark_fn
					);
				}
			} else {
				nodes[node_id][property] = structuredClone(new_value);
				if (mark_fn && is_text_value(new_value)) {
					mark_text_value(d, ['nodes', node_id, property, 'content'], new_value, mark_fn);
				}
			}
		} else if (type === 'create') {
			const node = structuredClone(args[0]) as DocumentNode;
			if (local_only) {
				for (const [prop, value] of Object.entries(node)) {
					if (local_only(value)) node[prop] = '';
				}
			}
			nodes[node.id] = node;
			mark_text_properties(d, node, mark_fn);
		} else if (type === 'delete') {
			delete nodes[args[0] as string];
		}
	}
}
