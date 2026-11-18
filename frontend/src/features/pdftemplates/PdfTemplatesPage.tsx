import './pdftemplates.scss';
import { Select, SelectItem } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { PdfTemplateExport } from '../../api/generated/models';
import { ErrorState } from '../../app/PageState';
import { SettingsLoading, SettingsPageLayout } from '../settings/SettingsPageLayout';
import { TemplateEditor } from './components/TemplateEditor';
import { EXPORT_KINDS, EXPORT_LABELS } from './exports';
import { pdfTemplateQuery } from './queries';

const kindOf = (value: string | null): PdfTemplateExport => EXPORT_KINDS.find((k) => k === value) ?? 'wiref';

/**
 * Settings › PDF templates: edit the PDFs Core produces (wiRef invoice request, cashbook sheet, order receipt). The editor
 * fills the area below the app header like the signage screen editor; while the template loads or fails to, the usual
 * settings frame with the document selector is shown.
 */
export function PdfTemplatesPage() {
  const [params, setParams] = useSearchParams();
  const kind = kindOf(params.get('export'));
  const query = useQuery(pdfTemplateQuery(kind));
  const choose = (next: PdfTemplateExport) => setParams({ export: next }, { replace: true });

  if (query.data) return <TemplateEditor key={kind} detail={query.data} onKind={choose} />;
  return (
    <SettingsPageLayout
      page="pdf-templates"
      actions={
        <Select
          id="pdft-export-loading"
          labelText="Document"
          size="md"
          value={kind}
          onChange={(e) => choose(kindOf(e.target.value))}
        >
          {EXPORT_KINDS.map((k) => (
            <SelectItem key={k} value={k} text={EXPORT_LABELS[k]} />
          ))}
        </Select>
      }
    >
      {query.isError ? (
        <ErrorState
          title="The template could not be loaded."
          message={query.error.message}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <SettingsLoading label="Loading the template" />
      )}
    </SettingsPageLayout>
  );
}
