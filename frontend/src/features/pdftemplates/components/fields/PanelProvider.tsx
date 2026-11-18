import { useEffect, useRef, type ReactNode } from 'react';
import type { PdfTemplateSchema } from '../../../../api/generated/models';
import type { ChangeKind } from '../../history';
import type { TemplateDocument } from '../../model';
import { PanelContext } from './panelContext';

/** Provides the document and an `edit` that chains edits made before the next render. */
export function PanelProvider({
  doc,
  schema,
  onChange,
  children,
}: {
  doc: TemplateDocument;
  schema: PdfTemplateSchema;
  onChange: (next: TemplateDocument, kind?: ChangeKind) => void;
  children: ReactNode;
}) {
  const latest = useRef(doc);
  useEffect(() => {
    latest.current = doc;
  }, [doc]);
  const edit = (change: (doc: TemplateDocument) => TemplateDocument, kind: ChangeKind = 'step') => {
    const next = change(latest.current);
    if (next === latest.current) return;
    latest.current = next;
    onChange(next, kind);
  };
  return <PanelContext.Provider value={{ doc, schema, edit }}>{children}</PanelContext.Provider>;
}
