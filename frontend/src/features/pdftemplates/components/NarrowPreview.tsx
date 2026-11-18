import { InlineNotification, Select, SelectItem, Tag } from '@carbon/react';
import type { PdfTemplateExport } from '../../../api/generated/models';
import { EXPORT_KINDS, EXPORT_LABELS } from '../exports';
import type { TemplateDocument } from '../model';
import type { TimedPreview } from '../queries';
import type { ShownPreview } from '../usePreviewDocument';
import { PreviewCanvas } from './PreviewCanvas';

/** Below this width (Carbon's `lg` breakpoint, 66 rem) the three panes do not fit next to a page. */
export const NARROW_QUERY = '(max-width: 65.99rem)';
export const MIN_EDITOR_WIDTH = 1056;

const nothing = () => undefined;

/**
 * The editor on a screen too narrow for it: the document selector, a notice and the preview at "fit", read-only. No
 * panes, no toolbar and no page interaction, since selecting and dragging on a phone-sized page would not be usable.
 */
export function NarrowPreview({
  kind,
  doc,
  status,
  shown,
  onKind,
}: {
  kind: PdfTemplateExport;
  doc: TemplateDocument;
  status: { label: string; tone: 'blue' | 'green' | 'gray' };
  shown: ShownPreview<TimedPreview> | null;
  onKind: (kind: PdfTemplateExport) => void;
}) {
  return (
    <div className="pdft pdft--narrow">
      <header className="pdft-bar">
        <div className="pdft-bar__title">
          <h1 title={doc.name}>{doc.name}</h1>
          <Tag type={status.tone} size="md">
            {status.label}
          </Tag>
        </div>
        <Select
          id="pdft-export"
          className="pdft-bar__select"
          labelText="Document"
          size="md"
          value={kind}
          onChange={(event) => onKind(event.target.value as PdfTemplateExport)}
        >
          {EXPORT_KINDS.map((k) => (
            <SelectItem key={k} value={k} text={EXPORT_LABELS[k]} />
          ))}
        </Select>
      </header>
      <div className="pdft-notice">
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Wide screen needed"
          subtitle={`The template editor needs a screen at least ${MIN_EDITOR_WIDTH} px wide. You can still look at the preview.`}
        />
      </div>
      <section className="pdft-center" aria-label="Preview">
        <PreviewCanvas
          readOnly
          shown={shown}
          doc={doc}
          selectedId={null}
          hoverId={null}
          tool={null}
          zoom="fit"
          onZoom={nothing}
          onScale={nothing}
          onSelect={nothing}
          onHover={nothing}
          onGeometry={nothing}
          onDraw={nothing}
        />
      </section>
    </div>
  );
}
