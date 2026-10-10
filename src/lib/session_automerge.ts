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

/** The `change` event payload. `patchInfo` carries the docs before and after the change. */
export type AutomergeChangePayload = {
	patchInfo?: { before?: AutomergeDoc; after?: AutomergeDoc };
};

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

/**
 * Clamp attachments to the content length, drop empty ones, and (for marks)
 * drop any that overlap an earlier one. Marks must be mutually exclusive, but
 * two peers can concurrently mark overlapping ranges.
 */
export function normalize_attachments(
	attachments: Attachment[],
	content: string,
	exclusive: boolean
): Attachment[] {
	const length = get_char_length(content);
	const result: Attachment[] = [];
	let last_end = -1;
	for (const a of attachments) {
		const start_offset = Math.max(0, Math.min(a.start_offset, length));
		const end_offset = Math.max(0, Math.min(a.end_offset, length));
		if (end_offset <= start_offset) continue;
		if (exclusive && start_offset < last_end) continue;
		result.push({ ...a, start_offset, end_offset });
		last_end = Math.max(last_end, end_offset);
	}
	return result;
}

function reconcile_text_value(value: Text, am_marks: AutomergeMark[]): Text {
	const content = value.content;
	const marks = normalize_attachments(
		merge_attachments(marks_to_attachments(MARK_PREFIX, am_marks, content), value.marks),
		content,
		true
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
 * Reconcile a remote Automerge doc into the next local node map, in one pass:
 *   1. rebuild text marks and annotations from Automerge marks;
 *   2. reuse the existing node object when nothing changed, so Svedit skips
 *      re-rendering it and the local caret in an untouched node survives;
 *   3. report whether anything changed, so the caller can skip the
 *      reassignment on a no-op echo.
 */
export function reconcile_remote_nodes(
	current: Record<string, DocumentNode>,
	next: AutomergeDoc,
	marks_fn: MarksFn | null
): { nodes: Record<string, DocumentNode>; changed: boolean } {
	const source = next.nodes ?? {};
	const result: Record<string, DocumentNode> = {};
	let changed = Object.keys(source).length !== Object.keys(current).length;
	for (const [id, node] of Object.entries(source)) {
		let overlaid: DocumentNode = node;
		if (marks_fn) {
			for (const [prop, value] of Object.entries(node)) {
				if (!is_text_value(value)) continue;
				const am_marks = marks_fn(next, ['nodes', id, prop, 'content']);
				const reconciled = reconcile_text_value(value, am_marks);
				if (node_payload_equal(reconciled, value)) continue;
				if (overlaid === node) overlaid = { ...node };
				overlaid[prop] = reconciled;
			}
		}
		const cur = current[id];
		if (cur && node_payload_equal(cur, overlaid)) {
			result[id] = cur;
		} else {
			result[id] = overlaid === node ? structuredClone(node) : overlaid;
			changed = true;
		}
	}
	return { nodes: result, changed };
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

/**
 * Apply Svedit ops to a bound Automerge draft:
 *   ['set', [node_id, property], value] assigns the value; `undefined`
 *     deletes the property (Automerge rejects undefined). A text value
 *     splices `content` and mirrors marks and annotations to Automerge marks,
 *     so concurrent edits merge.
 *   ['create', node] adds the node.
 *   ['delete', node_id] removes the node.
 * Unknown op types are ignored.
 */
export function mirror_ops_to_doc(
	d: AutomergeDoc,
	ops: DocumentOperation[],
	fns: { splice: SpliceFn | null; mark: MarkFn | null; unmark: UnmarkFn | null }
): void {
	if (!d.nodes) d.nodes = {};
	const nodes = d.nodes;
	const { splice: splice_fn, mark: mark_fn, unmark: unmark_fn } = fns;
	for (const [type, ...args] of ops) {
		if (type === 'set') {
			const [node_id, property] = args[0] as [string, string];
			const new_value = args[1];
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
			}
		} else if (type === 'create') {
			const node = structuredClone(args[0]) as DocumentNode;
			nodes[node.id] = node;
		} else if (type === 'delete') {
			delete nodes[args[0] as string];
		}
	}
}
