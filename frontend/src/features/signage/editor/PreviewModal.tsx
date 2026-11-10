import { useState } from 'react';
import { Modal, Select, SelectItem, Toggle } from '@carbon/react';
import type { SignageAspectRatio } from '../../../api/generated/models';
import { usePreviewData, useNow } from '../preview';
import { aspectLabel, sameRatio } from '../render/aspect';
import { SceneRenderer, ScreenFrame } from '../render/SceneRenderer';
import type { Draft } from '../sceneDraft';
import { sceneMachineIds } from '../widgets';

export type PreviewShape = { id: string; name: string; aspectRatio: SignageAspectRatio };

const ratio = (r: SignageAspectRatio) => r.width / r.height;

/**
 * The screen as large as the dialog allows, with the player's renderer and live clock. On a display of another shape
 * the screen is letterboxed inside the display's outline; "Announcement running" fills announcement blocks with samples.
 */
export function PreviewModal({
  draft,
  shapes,
  onClose,
}: {
  draft: Draft;
  shapes: readonly PreviewShape[];
  onClose: () => void;
}) {
  const [shapeId, setShapeId] = useState('screen');
  const [announcement, setAnnouncement] = useState(false);
  const now = useNow(1000);
  const data = usePreviewData(announcement ? 'announcement' : 'first', {
    now,
    referencedMachineIds: sceneMachineIds(draft.blocks),
  });
  const shape = shapes.find((item) => item.id === shapeId)?.aspectRatio ?? draft.aspectRatio;
  // Letterboxed: the screen keeps its shape and is centred in the display's outline.
  const widthPercent = Math.min(100, (ratio(draft.aspectRatio) / ratio(shape)) * 100);
  return (
    <Modal
      open
      passiveModal
      size="lg"
      modalLabel={draft.name}
      modalHeading="Preview"
      onRequestClose={onClose}
      className="sg-preview"
    >
      <div className="sg-preview__controls">
        <Select
          id="sg-preview-shape"
          labelText="Preview on"
          size="sm"
          value={shapeId}
          onChange={(event) => setShapeId(event.target.value)}
        >
          <SelectItem value="screen" text={`This screen (${aspectLabel(draft.aspectRatio)})`} />
          {shapes.map((item) => (
            <SelectItem
              key={item.id}
              value={item.id}
              text={`On ${item.name} (${aspectLabel(item.aspectRatio)})${sameRatio(item.aspectRatio, draft.aspectRatio) ? '' : ', different shape'}`}
            />
          ))}
        </Select>
        <Toggle
          id="sg-preview-announcement"
          size="sm"
          labelText="Announcement running"
          labelA="Off"
          labelB="On"
          toggled={announcement}
          onToggle={setAnnouncement}
        />
      </div>
      <div className="sg-preview__stage">
        <div
          className="sg-preview__display"
          style={{ aspectRatio: `${shape.width} / ${shape.height}`, maxWidth: `calc(65vh * ${ratio(shape)})` }}
        >
          <ScreenFrame aspectRatio={draft.aspectRatio} width={`${widthPercent}%`}>
            <SceneRenderer scene={draft} data={data} />
          </ScreenFrame>
        </div>
      </div>
      <p className="sg-preview__note">
        Same renderer and fonts as the player. Machine states are simulated; open days and events are the real upcoming
        ones.
      </p>
    </Modal>
  );
}
