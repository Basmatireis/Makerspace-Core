import { createContext, useContext } from 'react';
import type { PdfTemplateSchema } from '../../../../api/generated/models';
import type { ChangeKind } from '../../history';
import type { TemplateDocument } from '../../model';

/**
 * What the fields of the Properties, Styles and Variables panels share. Fields never keep a copy of a style: they read it
 * from `doc` at every render, so a colour or size changed anywhere shows up everywhere.
 */
export interface PanelContextValue {
  doc: TemplateDocument;
  schema: PdfTemplateSchema;
  /**
   * Applies an edit to the latest document, also when several edits follow within one event (a colour saved as a
   * document colour and then picked): each one builds on the result of the one before.
   */
  edit: (change: (doc: TemplateDocument) => TemplateDocument, kind?: ChangeKind) => void;
}

export const PanelContext = createContext<PanelContextValue | null>(null);

export function usePanel(): PanelContextValue {
  const value = useContext(PanelContext);
  if (!value) throw new Error('usePanel needs a PanelProvider');
  return value;
}
