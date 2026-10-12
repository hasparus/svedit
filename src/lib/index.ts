// Main exports for the svedit library
export { default as Svedit } from './Svedit.svelte';
export { default as TextProperty } from './TextProperty.svelte';
export { default as CustomProperty } from './CustomProperty.svelte';
export { default as Node } from './Node.svelte';
export { default as NodeArrayProperty } from './NodeArrayProperty.svelte';
export { default as NodeGap } from './NodeGap.svelte';
export { default as NodeGapMarkers } from './NodeGapMarkers.svelte';
export { default as NodeCaret } from './NodeCaret.svelte';
export { default as NodeSelectionMarkers } from './NodeSelectionMarkers.svelte';

// Core classes and utilities
export { default as Session } from './Session.svelte.js';
export { default as Transaction } from './Transaction.svelte.js';

// Public types
export type {
	// Schema definition
	DocumentSchema,
	NodeSchema,
	NodeKind,
	PropertyDefinition,
	PropertyType,
	// Schema-derived node types
	PropertyValue,
	NodeOfType,
	AnyNode,
	NodeMap,
	DynamicRecord,
	SessionConfig,
	CommandRegistry,
	DocumentOperation,
	Inspection,
	// Documents and nodes
	Document,
	DocumentNode,
	DocumentPath,
	NodeId,
	// Values
	Text,
	NodeArray,
	Attachment,
	Mark,
	Annotation,
	// Selections
	Selection,
	TextSelection,
	NodeSelection,
	PropertySelection,
	SelectionRange,
	// Component props and render contexts
	SveditProps,
	SveditContext,
	TextPropertyProps,
	CustomPropertyProps,
	NodeArrayPropertyProps,
	NodeGapToolsProps,
	NodeProps,
	NodeArrayAttachmentContext
} from './types.js';
export type { SelectedAttachment } from './doc_utils.js';
export type { Keymap } from './KeyMapper.svelte.js';

// Document utilities
export {
	define_document_schema,
	is_primitive_type,
	get_default_node_type,
	get_property_default,
	fill_node_defaults,
	fill_document_defaults,
	validate_document_schema,
	validate_document,
	validate_node,
	get_referencing_node_ids
} from './doc_utils.js';

// Command system
export { default as Command } from './Command.svelte.js';
export * from './Command.svelte.js';

// Keyboard handling
export { KeyMapper, define_keymap } from './KeyMapper.svelte.js';

// Transforms and utilities
export * from './transforms.svelte.js';
export * from './utils.js';

export type {
	HtmlPasteConfig,
	HtmlBlockTag,
	HtmlBlockMapping,
	HtmlMarkMapping,
	HtmlListTag,
	HtmlListMapping,
	HtmlContainerMapping
} from './html_paste.js';

export { export_text_html } from './html_export.js';
export type { MarkHtmlExporter } from './html_export.js';
export { escape_html, safe_html_href } from './html_utils.js';

// Automerge binding and selection cursors
export {
	apply_text_splice,
	is_nodes_reset,
	mirror_ops_to_doc,
	normalize_attachments,
	partition_ops,
	reconcile_remote_nodes,
	MARK_PREFIX,
	ANNOTATION_PREFIX
} from './session_automerge.js';
export type {
	AutomergeChangePayload,
	AutomergeDoc,
	AutomergeHandle,
	AutomergeMark,
	AutomergeTextFns,
	SpliceFn,
	MarkFn,
	UnmarkFn,
	MarksFn,
	GetCursorFn,
	GetCursorPositionFn,
	LocalOnlyFn
} from './session_automerge.js';
export { encode_selection, decode_selection } from './presence_cursors.js';
export type { CursorApi, WireSelection } from './presence_cursors.js';
export { caret_rect_for_selection, selection_highlight_rects } from './presence_geometry.js';
export type { CaretRect, HighlightRect } from './presence_geometry.js';
