import type { PdfTemplateProblem, PdfTemplateSchema } from '../../api/generated/models';
import type { ChangeKind } from './history';
import type { TemplateDocument } from './model';

/**
 * What the editor hands to the panels that edit the document (Properties, Styles, Variables). The panels are controlled:
 * they never keep a copy of the document, they compute the next document and call `onChange`.
 */
export interface EditorPanelProps {
  /** The working document. */
  doc: TemplateDocument;
  /**
   * The selected node: a node id, `'page'` for the page setup, or null for nothing. Ids always exist in `doc`
   * (the editor clears a selection that no longer does).
   */
  selectedId: string | null;
  /** Data schema of the export: groups of variables, their descriptions, and the expression filters. */
  schema: PdfTemplateSchema;
  /**
   * Replaces the document. `'typing'` edits of one field within 700 ms form a single undo step; `'step'` (the default)
   * is a step of its own. Pass a new object: never mutate `doc`.
   */
  onChange: (next: TemplateDocument, kind?: ChangeKind) => void;
  /** Selects a node (or `'page'`, or null). */
  onSelect: (id: string | null) => void;
}

/** Properties tab of the right pane: the selected node, or the page setup. Also shows the node's problems. */
export interface PropertiesPanelProps extends EditorPanelProps {
  /** Problems of the latest preview, for the notice under the selected node's fields. */
  problems: readonly PdfTemplateProblem[];
  /** Paths that stayed empty in the preview because the reader lacks a permission. */
  redacted: readonly string[];
  /** Opens these structure rows, for a block moved into a container that is collapsed in the tree. */
  onExpand?: (ids: string[]) => void;
}

/** Styles tab of the right pane: colour, text and size styles of the document. */
export type StylesPanelProps = EditorPanelProps;

/**
 * Variables tab of the left pane: searchable list of the export's fields with descriptions and examples (`schema`).
 * Inserting a variable is an edit of the document like any other, through `onChange`.
 */
export type VariablesPanelProps = EditorPanelProps;
