import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import SveditTest from './testing_components/SveditTest.svelte';
import create_test_session from './create_test_session.js';
import { caret_rect_for_selection, selection_highlight_rects } from '../lib/presence_geometry.js';

async function render_canvas() {
	const session = create_test_session();
	const { container } = await render(SveditTest, { session });
	await tick();
	return container.querySelector('.svedit-canvas') as HTMLElement;
}

const title_path = ['page_1', 'body', 0, 'title'];

describe('presence geometry', () => {
	it('places a text caret inside its text property', async () => {
		const canvas = await render_canvas();
		const title_el = canvas.querySelector('[data-path="page_1__body__0__title"]') as HTMLElement;
		const box = title_el.getBoundingClientRect();
		const start = caret_rect_for_selection(canvas, {
			type: 'text',
			path: title_path,
			anchor_offset: 0,
			focus_offset: 0
		});
		const later = caret_rect_for_selection(canvas, {
			type: 'text',
			path: title_path,
			anchor_offset: 5,
			focus_offset: 5
		});
		expect(start).not.toBeNull();
		expect(later!.left).toBeGreaterThan(start!.left);
		expect(start!.top).toBeGreaterThanOrEqual(box.top - 1);
		expect(start!.top).toBeLessThan(box.bottom);
	});

	it('returns one highlight per selected node and none for a caret', async () => {
		const canvas = await render_canvas();
		const body = ['page_1', 'body'];
		const node_selection = { type: 'node' as const, path: body, anchor_offset: 0, focus_offset: 2 };
		expect(selection_highlight_rects(canvas, node_selection)).toHaveLength(2);
		expect(
			selection_highlight_rects(canvas, { ...node_selection, anchor_offset: 1, focus_offset: 1 })
		).toEqual([]);
		expect(caret_rect_for_selection(canvas, { ...node_selection, focus_offset: 3 })).not.toBeNull();
	});

	it('returns no rectangles for paths that are not rendered', async () => {
		const canvas = await render_canvas();
		const missing = { type: 'text' as const, path: ['page_1', 'body', 9, 'title'] };
		expect(
			caret_rect_for_selection(canvas, { ...missing, anchor_offset: 0, focus_offset: 0 })
		).toBeNull();
		expect(
			selection_highlight_rects(canvas, { ...missing, anchor_offset: 0, focus_offset: 2 })
		).toEqual([]);
	});
});
