import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import SveditTest from './testing_components/SveditTest.svelte';
import create_test_session from './create_test_session.js';

async function render_with_media_handler(handle_media_paste: (...args: any[]) => any) {
	const session = create_test_session();
	session.config = { ...session.config, handle_media_paste };
	const { container } = await render(SveditTest, { session });
	await tick();
	return { session, canvas: container.querySelector('.svedit-canvas') as HTMLElement };
}

function drop_on(target: Element, files: File[]) {
	const data_transfer = new DataTransfer();
	for (const file of files) data_transfer.items.add(file);
	const event = new DragEvent('drop', {
		bubbles: true,
		cancelable: true,
		dataTransfer: data_transfer
	});
	target.dispatchEvent(event);
	return event;
}

const image = () => new File(['png'], 'photo.png', { type: 'image/png' });

describe('media drop', () => {
	it('selects the node under the pointer and hands the files to handle_media_paste', async () => {
		let seen: unknown = null;
		const handler = vi.fn((session: any, media: any[]) => {
			seen = { selection: session.selection, media };
			return null;
		});
		const { canvas } = await render_with_media_handler(handler);
		const list = canvas.querySelector('[data-path="page_1__body__2"]')!;
		const event = drop_on(list, [image(), new File(['x'], 'notes.txt', { type: 'text/plain' })]);

		expect(event.defaultPrevented).toBe(true);
		expect(handler).toHaveBeenCalledOnce();
		expect(seen).toEqual({
			selection: { type: 'node', path: ['page_1', 'body'], anchor_offset: 2, focus_offset: 3 },
			media: [expect.objectContaining({ type: 'image/png', size: 3 })]
		});
	});

	it('inserts a node payload returned by the handler', async () => {
		const { session, canvas } = await render_with_media_handler(() => ({
			main_nodes: ['dropped'],
			nodes: {
				dropped: {
					id: 'dropped',
					type: 'paragraph',
					content: { content: 'dropped', marks: [], annotations: [] }
				}
			}
		}));
		drop_on(canvas.querySelector('[data-path="page_1__body__0"]')!, [image()]);
		await vi.waitFor(() =>
			expect(session.get(['page_1', 'body']).nodes).toEqual(['dropped', 'story_1', 'list_1'])
		);
	});

	it('ignores drops without media', async () => {
		const handler = vi.fn();
		const { canvas } = await render_with_media_handler(handler);
		const event = drop_on(canvas.querySelector('[data-path="page_1__body__0"]')!, [
			new File(['x'], 'notes.txt', { type: 'text/plain' })
		]);
		expect(event.defaultPrevented).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});
});
