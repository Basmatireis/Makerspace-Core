import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { PdfTemplateDetail, PdfTemplateVersion, PdfTemplateVersionMeta } from '../../api/generated/models';
import {
  discardPdfTemplateDraft,
  publishPdfTemplateDraft,
  restorePdfTemplateVersion,
  savePdfTemplateDraft,
} from '../../api/generated/pdf-templates/pdf-templates';
import { useNotify } from '../../app/toasts';
import { useDocumentHistory } from './history';
import { apiDocument, documentOf, type TemplateDocument } from './model';
import { pdfTemplateKey } from './queries';
import { nextVersion, statusOf } from './status';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

/**
 * The working document of one export: its undo history, what the server holds (draft and published version), and the
 * save, publish, restore, discard and reset actions. `dirty` compares the document with what was saved last.
 */
export function useTemplateEditor(detail: PdfTemplateDetail) {
  const kind = detail.export;
  const queryClient = useQueryClient();
  const notify = useNotify();
  const [server, setServer] = useState({ draft: detail.draft, published: detail.published });
  const initial = documentOf((detail.draft ?? detail.published)?.document ?? detail.builtin);
  const history = useDocumentHistory<TemplateDocument>(initial);
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial));
  const [error, setError] = useState<string | null>(null);

  // The JSON text is the comparison key: undoing back to the saved state makes the document clean again.
  const json = useMemo(() => JSON.stringify(history.doc), [history.doc]);
  const dirty = json !== baseline;
  const refresh = () => queryClient.invalidateQueries({ queryKey: pdfTemplateKey(kind) });

  const adopt = (version: PdfTemplateVersion | null, fallback: TemplateDocument) => {
    const doc = version ? documentOf(version.document) : fallback;
    history.reset(doc);
    setBaseline(JSON.stringify(doc));
  };

  const save = useMutation({
    mutationFn: async (doc: TemplateDocument) => {
      const result = await savePdfTemplateDraft(kind, {
        document: apiDocument(doc),
        expectedRevision: server.draft?.revision,
      });
      return { result, doc };
    },
    onSuccess: ({ result, doc }) => {
      setServer((now) => ({ ...now, draft: result.version }));
      setBaseline(JSON.stringify(doc));
      setError(null);
      void refresh();
      notify({
        kind: 'success',
        title: 'Draft saved',
        subtitle: 'The published version stays in use until you publish.',
      });
    },
    onError: (e) => setError(messageOf(e)),
  });

  const publish = useMutation({
    // Unsaved edits are saved as the draft first: the server publishes the draft, never a document sent with the call.
    mutationFn: async (doc: TemplateDocument) => {
      let revision = server.draft?.revision;
      if (dirty || !server.draft) {
        const saved = await savePdfTemplateDraft(kind, { document: apiDocument(doc), expectedRevision: revision });
        revision = saved.version.revision;
      }
      return { version: await publishPdfTemplateDraft(kind, { expectedRevision: revision as number }), doc };
    },
    onSuccess: ({ version, doc }) => {
      setServer({ draft: null, published: version });
      setBaseline(JSON.stringify(doc));
      setError(null);
      void refresh();
      notify({ kind: 'success', title: `Version ${version.version} published` });
    },
    onError: (e) => setError(messageOf(e)),
  });

  const restore = useMutation({
    mutationFn: (version: PdfTemplateVersionMeta) => restorePdfTemplateVersion(kind, version.id),
    onSuccess: (draft) => {
      setServer((now) => ({ ...now, draft }));
      adopt(draft, history.doc);
      setError(null);
      void refresh();
      notify({ kind: 'success', title: 'Version copied into a new draft' });
    },
    onError: (e) => setError(messageOf(e)),
  });

  const discard = useMutation({
    mutationFn: () => discardPdfTemplateDraft(kind),
    onSuccess: () => {
      setServer((now) => ({ ...now, draft: null }));
      adopt(server.published, documentOf(detail.builtin));
      setError(null);
      void refresh();
      notify({ kind: 'success', title: 'Draft discarded' });
    },
    onError: (e) => setError(messageOf(e)),
  });

  return {
    ...history,
    dirty,
    server,
    error,
    clearError: () => setError(null),
    status: statusOf({ dirty, ...server }),
    nextVersion: nextVersion(server.draft, server.published),
    save: () => save.mutate(history.doc),
    publish: (done?: () => void) => publish.mutate(history.doc, { onSuccess: done }),
    restore: (version: PdfTemplateVersionMeta, done?: () => void) => restore.mutate(version, { onSuccess: done }),
    discard: (done?: () => void) => discard.mutate(undefined, { onSuccess: done }),
    /** The built-in default as an undoable edit. */
    resetToBuiltin: () => history.set(documentOf(detail.builtin), 'step'),
    saving: save.isPending,
    publishing: publish.isPending,
    working: restore.isPending || discard.isPending,
  };
}
