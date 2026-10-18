import { useState } from 'react';
import { AspectRatio, Button, ContentSwitcher, InlineLoading, InlineNotification, Modal, Switch, Tag, Tile } from '@carbon/react';
import { Maximize } from '@carbon/icons-react';
import type { Print, PrintArtifact } from '../types';
import '../styles/prints.scss';

const parserTag: Record<PrintArtifact['parserStatus'], { label: string; type: 'green' | 'blue' | 'red' }> = {
  parsed: { label: 'Parsed', type: 'green' }, pending: { label: 'Waiting', type: 'blue' }, failed: { label: 'Parse failed', type: 'red' },
};

/** Tiny preview next to a run or job title. Renders nothing when the run has no preview. */
export function RunThumb({ run }: { run: Print | null | undefined }) {
  const preview = run?.previews[0];
  return preview ? <img className="mj-thumb" src={preview.src} alt={`Preview of ${run.fileName}`} width={32} height={32} /> : null;
}

/** The 3MF preview tile of the run detail page: main image, view switcher, file and parser state, large view on click. */
export function RunPreview({ run }: { run: Print }) {
  const [index, setIndex] = useState(0);
  const [large, setLarge] = useState(false);
  const { artifact, previews } = run;
  const active = previews[Math.min(index, previews.length - 1)];

  const body = !artifact ? (
    <AspectRatio ratio="4x3"><div className="mj-preview__empty"><p className="mj-secondary">No 3MF file was reported for this run.</p></div></AspectRatio>
  ) : artifact.parserStatus === 'pending' ? (
    <AspectRatio ratio="4x3"><div className="mj-preview__empty"><InlineLoading status="active" description="Waiting for the printer's 3MF file…" /></div></AspectRatio>
  ) : artifact.parserStatus === 'failed' || !active ? (
    <InlineNotification kind="error" lowContrast hideCloseButton title="Preview unavailable" subtitle="The 3MF file could not be read. The run itself is not affected." />
  ) : (
    <>
      <div className="mj-preview__frame">
        <AspectRatio ratio="4x3">
          <img className="mj-preview__image" src={active.src} alt={`${active.label} of ${run.fileName}`} onClick={() => setLarge(true)} />
        </AspectRatio>
        <Button className="mj-preview__enlarge" kind="secondary" size="sm" hasIconOnly renderIcon={Maximize} iconDescription="View larger" tooltipPosition="left" onClick={() => setLarge(true)} />
      </div>
      {previews.length > 1 && (
        <ContentSwitcher size="sm" selectedIndex={Math.min(index, previews.length - 1)} onChange={({ index: next }) => setIndex(next ?? 0)}>
          {previews.map((preview) => <Switch key={preview.id} name={preview.id} text={preview.label} />)}
        </ContentSwitcher>
      )}
    </>
  );

  return (
    <Tile className="mj-preview">
      <div className="mj-preview__header">
        <h2 className="mj-section-title">Preview</h2>
        {artifact && <Tag type={parserTag[artifact.parserStatus].type} size="sm">{parserTag[artifact.parserStatus].label}</Tag>}
      </div>
      {artifact && (
        <p className="mj-secondary">
          {artifact.fileName}{artifact.sha256Short && ` · sha256 ${artifact.sha256Short}`}{artifact.parserStatus === 'parsed' && ` · ${artifact.plates} ${artifact.plates === 1 ? 'plate' : 'plates'}`}
        </p>
      )}
      {body}
      {large && active && (
        <Modal passiveModal open size="lg" modalHeading={`${active.label} · ${run.fileName}`} onRequestClose={() => setLarge(false)}>
          <img className="mj-preview__large" src={active.src} alt={`${active.label} of ${run.fileName}, large view`} />
        </Modal>
      )}
    </Tile>
  );
}
