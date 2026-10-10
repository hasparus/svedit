/**
 * Map a model selection to screen rectangles, e.g. to render a remote peer's
 * caret and selection highlight. This is the read-only counterpart of the DOM
 * walk Svedit uses to render the local selection: find the element holding
 * the property, walk its text nodes to the character offset, and measure a
 * DOM Range there.
 *
 * Rectangles are in viewport coordinates (raw `getBoundingClientRect`), so a
 * `position: fixed` overlay can render them without touching the canvas DOM.
 * Targets that are not rendered yield `null` or no rectangles.
 */
import { get_char_length, char_to_utf16_offset, serialize_path } from './utils.js';
import type { DocumentPath, Selection } from './types.js';

export type CaretRect = {
	/** Left edge of the caret, in viewport coordinates */
	left: number;
	/** Top edge, in viewport coordinates */
	top: number;
	/** Caret height (line height at that position) */
	height: number;
};

export type HighlightRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

/** Resolve a character offset within a property element to a DOM position. */
function dom_position_for_offset(
	el: HTMLElement,
	char_offset: number
): { node: Node; offset: number } | null {
	let current = 0;
	let found: { node: Node; offset: number } | null = null;

	function walk(node: Node): boolean {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? '';
			const length = get_char_length(text);
			if (current + length >= char_offset) {
				found = { node, offset: char_to_utf16_offset(text, char_offset - current) };
				return true;
			}
			current += length;
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			for (const child of node.childNodes) if (walk(child)) return true;
		}
		return false;
	}

	for (const child of el.childNodes) if (walk(child)) break;
	// Empty text renders as `<div><br></div>`; the caret sits after the <br>.
	if (!found && char_offset === 0) return { node: el, offset: el.childNodes.length };
	return found;
}

function caret_rect(rect: DOMRect): CaretRect {
	return { left: rect.left, top: rect.top, height: rect.height || 18 };
}

function find(
	canvas_el: HTMLElement,
	path: DocumentPath,
	type?: 'text' | 'node' | 'node_array' | 'property'
): HTMLElement | null {
	const type_selector = type ? `[data-type="${type}"]` : '';
	return canvas_el.querySelector(`[data-path="${serialize_path(path)}"]${type_selector}`);
}

/** The element of the node at `index` in the node array at `path`, if rendered. */
function node_child_el(canvas_el: HTMLElement, path: DocumentPath, index: number) {
	if (index < 0) return null;
	return find(canvas_el, [...path, index], 'node');
}

function text_range(el: HTMLElement, start: number, end: number): Range | null {
	const start_pos = dom_position_for_offset(el, start);
	const end_pos = start === end ? start_pos : dom_position_for_offset(el, end);
	if (!start_pos || !end_pos) return null;
	const range = window.document.createRange();
	try {
		range.setStart(start_pos.node, start_pos.offset);
		range.setEnd(end_pos.node, end_pos.offset);
	} catch {
		return null;
	}
	return range;
}

/** The caret rectangle at a selection's focus. */
export function caret_rect_for_selection(
	canvas_el: HTMLElement,
	selection: Selection | null
): CaretRect | null {
	if (!selection) return null;

	if (selection.type === 'text') {
		const el = find(canvas_el, selection.path, 'text');
		if (!el) return null;
		const range = text_range(el, selection.focus_offset, selection.focus_offset);
		if (!range) return null;
		// A collapsed range can report no rects; fall back to the element box.
		const rects = range.getClientRects();
		return caret_rect(rects.length ? rects[0] : el.getBoundingClientRect());
	}

	if (selection.type === 'node') {
		// Anchor on the focused child, or the previous one for a caret past
		// the last node, falling back to the node array itself.
		const el =
			node_child_el(canvas_el, selection.path, selection.focus_offset) ??
			node_child_el(canvas_el, selection.path, selection.focus_offset - 1) ??
			find(canvas_el, selection.path);
		return el ? caret_rect(el.getBoundingClientRect()) : null;
	}

	const el = find(canvas_el, selection.path);
	return el ? caret_rect(el.getBoundingClientRect()) : null;
}

/**
 * Rectangles covering a non-collapsed selection: one per wrapped line for
 * text, one per selected child node for node selections. Empty for a
 * collapsed caret or a property selection.
 */
export function selection_highlight_rects(
	canvas_el: HTMLElement,
	selection: Selection | null
): HighlightRect[] {
	if (!selection || selection.type === 'property') return [];
	if (selection.anchor_offset === selection.focus_offset) return [];
	const start = Math.min(selection.anchor_offset, selection.focus_offset);
	const end = Math.max(selection.anchor_offset, selection.focus_offset);
	const to_rect = (r: DOMRect) => ({ left: r.left, top: r.top, width: r.width, height: r.height });

	if (selection.type === 'text') {
		const el = find(canvas_el, selection.path, 'text');
		const range = el && text_range(el, start, end);
		if (!range) return [];
		return Array.from(range.getClientRects())
			.filter((r) => r.width > 0 && r.height > 0)
			.map(to_rect);
	}

	const rects: HighlightRect[] = [];
	for (let i = start; i < end; i++) {
		const r = node_child_el(canvas_el, selection.path, i)?.getBoundingClientRect();
		if (r && r.width > 0 && r.height > 0) rects.push(to_rect(r));
	}
	return rects;
}
