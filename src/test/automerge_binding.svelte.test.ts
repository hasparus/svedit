import { describe, expect, it } from 'vitest';
import create_test_session from './create_test_session.js';
import {
	ANNOTATION_PREFIX,
	MARK_PREFIX,
	apply_text_splice,
	normalize_attachments,
	reconcile_remote_nodes
} from '../lib/session_automerge.js';
import type {
	AutomergeChangePayload,
	AutomergeDoc,
	AutomergeHandle,
	AutomergeMark,
	AutomergeTextFns
} from '../lib/session_automerge.js';
import { decode_selection, encode_selection } from '../lib/presence_cursors.js';

/**
 * A minimal stand-in for an Automerge doc handle. Text lives in plain
 * strings; marks and a splice log live beside the nodes so marks shift and
 * cursors resolve the way Automerge's do.
 */
type FakeDoc = AutomergeDoc & {
	_marks: Record<string, AutomergeMark[]>;
	_splices: Array<{ key: string; index: number; delete_count: number; insert: number }>;
};

const key_of = (path: Array<string | number>) => path.join('/');

function read_at(doc: any, path: Array<string | number>) {
	return path.reduce((value, segment) => value?.[segment], doc);
}

function write_at(doc: any, path: Array<string | number>, value: unknown) {
	const parent = read_at(doc, path.slice(0, -1));
	parent[path.at(-1)!] = value;
}

function shift(position: number, index: number, delete_count: number, insert: number) {
	if (position <= index) return position;
	if (position < index + delete_count) return index;
	return position - delete_count + insert;
}

const fake_fns: AutomergeTextFns = {
	splice(doc: any, path, index, delete_count, value = '') {
		const text: string = read_at(doc, path);
		write_at(doc, path, text.slice(0, index) + value + text.slice(index + delete_count));
		const key = key_of(path);
		doc._splices.push({ key, index, delete_count, insert: value.length });
		for (const mark of doc._marks[key] ?? []) {
			mark.start = shift(mark.start, index, delete_count, value.length);
			mark.end = shift(mark.end, index, delete_count, value.length);
		}
	},
	mark(doc: any, path, range, name, value) {
		const key = key_of(path);
		doc._marks[key] = [...(doc._marks[key] ?? []), { name, value, ...range }].map(
			({ name, value, start, end }) => ({ name, value, start, end })
		);
	},
	unmark(doc: any, path, _range, name) {
		const key = key_of(path);
		doc._marks[key] = (doc._marks[key] ?? []).filter((mark: AutomergeMark) => mark.name !== name);
	},
	marks: (doc: any, path) => structuredClone(doc._marks[key_of(path)] ?? []),
	getCursor: (doc: any, path, position) =>
		JSON.stringify({ key: key_of(path), position, at: doc._splices.length }),
	getCursorPosition(doc: any, _path, cursor) {
		const { key, position, at } = JSON.parse(cursor);
		let result = position;
		for (const s of doc._splices.slice(at)) {
			if (s.key === key) result = shift(result, s.index, s.delete_count, s.insert);
		}
		return result;
	}
};

function create_handle(initial: AutomergeDoc) {
	let doc: FakeDoc = { ...structuredClone(initial), _marks: {}, _splices: [] };
	const listeners = new Set<(payload: AutomergeChangePayload) => void>();
	const handle: AutomergeHandle = {
		change(fn) {
			const before = doc;
			const draft = structuredClone(doc);
			fn(draft);
			doc = draft;
			for (const listener of listeners) listener({ patchInfo: { before, after: doc } });
		},
		doc: () => doc,
		on: (_event, listener) => listeners.add(listener),
		off: (_event, listener) => listeners.delete(listener)
	};
	return {
		handle,
		get doc() {
			return doc;
		}
	};
}

function create_bound_session(fns: AutomergeTextFns = fake_fns) {
	const session = create_test_session();
	session.schema = structuredClone(session.schema);
	session.schema.strong = { kind: 'mark', properties: {} };
	session.schema.comment = { kind: 'annotation', properties: {} };
	(session.schema.story.properties.title as any).mark_types = ['strong'];
	(session.schema.story.properties.title as any).annotation_types = ['comment'];
	const remote = create_handle(structuredClone(session.doc));
	session.attach_automerge_handle(remote.handle, fns);
	return { session, remote };
}

const title_path = ['story_1', 'title'];
const title_content_path = ['nodes', 'story_1', 'title', 'content'];

describe('automerge binding', () => {
	it('mirrors local transactions, undo and redo into the bound doc', () => {
		const { session, remote } = create_bound_session();
		session.selection = { type: 'text', path: title_path, anchor_offset: 5, focus_offset: 5 };
		session.apply(session.tr.insert_text(' great'));
		expect(remote.doc.nodes.story_1.title.content).toBe('First great story');
		expect(remote.doc._splices).toHaveLength(1);

		session.undo();
		expect(remote.doc.nodes.story_1.title.content).toBe('First story');
		session.redo();
		expect(remote.doc.nodes).toEqual(session.doc.nodes);
	});

	it('reconciles remote changes and keeps untouched nodes', () => {
		const { session, remote } = create_bound_session();
		const list_before = session.doc.nodes.list_1;
		remote.handle.change((d) => {
			apply_text_splice(fake_fns.splice!, d, title_content_path, 'First story', 'First story!');
		});
		expect(session.get([...title_path, 'content'])).toBe('First story!');
		expect(session.doc.nodes.list_1).toBe(list_before);
	});

	it('keeps the local caret on its character across a remote insert before it', () => {
		const { session, remote } = create_bound_session();
		session.selection = { type: 'text', path: title_path, anchor_offset: 6, focus_offset: 6 };
		remote.handle.change((d) => fake_fns.splice!(d, title_content_path, 0, 0, 'The '));
		expect(session.selection).toMatchObject({ anchor_offset: 10, focus_offset: 10 });
	});

	it('clears a selection that points into a remotely deleted node', () => {
		const { session, remote } = create_bound_session();
		session.selection = {
			type: 'text',
			path: ['list_1', 'list_items', 1, 'content'],
			anchor_offset: 2,
			focus_offset: 2
		};
		remote.handle.change((d) => {
			d.nodes!.list_1.list_items.nodes = ['list_item_1'];
			delete d.nodes!.list_item_2;
		});
		expect(session.selection).toBeNull();
	});

	it('mirrors marks and annotations to prefixed Automerge marks', () => {
		const { session, remote } = create_bound_session();
		session.selection = { type: 'text', path: title_path, anchor_offset: 0, focus_offset: 5 };
		session.apply(session.tr.toggle_mark('strong'));
		session.selection = { type: 'text', path: title_path, anchor_offset: 6, focus_offset: 11 };
		session.apply(session.tr.toggle_annotation('comment'));
		const names = remote.doc._marks[key_of(title_content_path)].map((m) => m.name);
		expect(names).toHaveLength(2);
		expect(names.some((name) => name.startsWith(MARK_PREFIX))).toBe(true);
		expect(names.some((name) => name.startsWith(ANNOTATION_PREFIX))).toBe(true);
	});

	it('shifts marks with a concurrent remote splice', () => {
		const { session, remote } = create_bound_session();
		session.selection = { type: 'text', path: title_path, anchor_offset: 6, focus_offset: 11 };
		session.apply(session.tr.toggle_mark('strong'));
		remote.handle.change((d) => fake_fns.splice!(d, title_content_path, 0, 0, 'My '));
		const title = session.get(title_path);
		expect(title.content).toBe('My First story');
		expect(title.marks[0]).toMatchObject({ start_offset: 9, end_offset: 14 });
	});

	it('works without the text fns by replacing values wholesale', () => {
		const { session, remote } = create_bound_session({});
		session.selection = { type: 'text', path: title_path, anchor_offset: 0, focus_offset: 0 };
		session.apply(session.tr.insert_text('A '));
		expect(remote.doc.nodes).toEqual(session.doc.nodes);
		expect(remote.doc._splices).toHaveLength(0);
	});

	it('stops mirroring after detach', () => {
		const { session, remote } = create_bound_session();
		session.detach_automerge_handle();
		session.selection = { type: 'text', path: title_path, anchor_offset: 0, focus_offset: 0 };
		session.apply(session.tr.insert_text('A '));
		expect(remote.doc.nodes.story_1.title.content).toBe('First story');
	});
});

describe('reconcile_remote_nodes', () => {
	it('reports no change for an equal doc with reordered keys', () => {
		const current = { a: { id: 'a', type: 'x', value: 1, other: 'y' } };
		const result = reconcile_remote_nodes(
			current,
			{ nodes: { a: { other: 'y', value: 1, type: 'x', id: 'a' } } },
			null
		);
		expect(result.changed).toBe(false);
		expect(result.nodes.a).toBe(current.a);
	});
});

describe('normalize_attachments', () => {
	it('drops overlapping marks and clamps to the content', () => {
		const marks = [
			{ node_id: 'a', start_offset: 0, end_offset: 4 },
			{ node_id: 'b', start_offset: 2, end_offset: 6 },
			{ node_id: 'c', start_offset: 6, end_offset: 20 }
		];
		expect(normalize_attachments(marks, 'abcdefgh', true)).toEqual([
			{ node_id: 'a', start_offset: 0, end_offset: 4 },
			{ node_id: 'c', start_offset: 6, end_offset: 8 }
		]);
		expect(normalize_attachments(marks, 'abcdefgh', false)).toHaveLength(3);
	});
});

describe('selection cursors', () => {
	it('anchors node selections to node ids', () => {
		const { session, remote } = create_bound_session();
		const api = { getCursor: fake_fns.getCursor!, getCursorPosition: fake_fns.getCursorPosition! };
		const selection = {
			type: 'node' as const,
			path: ['list_1', 'list_items'],
			anchor_offset: 1,
			focus_offset: 2
		};
		const wire = encode_selection(api, remote.doc, selection);
		expect(wire).toMatchObject({ anchor_id: 'list_item_2', focus_id: null });
		remote.handle.change((d) => {
			d.nodes!.list_item_0 = {
				id: 'list_item_0',
				type: 'list_item',
				content: { content: '', marks: [], annotations: [] }
			};
			d.nodes!.list_1.list_items.nodes.unshift('list_item_0');
		});
		expect(decode_selection(api, remote.doc, wire)).toEqual({
			...selection,
			anchor_offset: 2,
			focus_offset: 3
		});
		expect(session.get(['list_1', 'list_items']).nodes).toHaveLength(3);
	});

	it('resolves text cursors through node array paths', () => {
		const { remote } = create_bound_session();
		const api = { getCursor: fake_fns.getCursor!, getCursorPosition: fake_fns.getCursorPosition! };
		const path = ['page_1', 'body', 2, 'list_items', 0, 'content'];
		const wire = encode_selection(api, remote.doc, {
			type: 'text',
			path,
			anchor_offset: 6,
			focus_offset: 10
		});
		remote.handle.change((d) =>
			fake_fns.splice!(d, ['nodes', 'list_item_1', 'content', 'content'], 0, 0, 'my ')
		);
		expect(decode_selection(api, remote.doc, wire)).toEqual({
			type: 'text',
			path,
			anchor_offset: 9,
			focus_offset: 13
		});
	});
});
