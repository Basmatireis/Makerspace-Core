import { useState } from 'react';
import { AccordionItem, RadioButton, RadioButtonGroup, Tag, Toggle } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { AspectRatioInput } from '../AspectRatioInput';
import { ratioOfParts, ratioPartsError, ratioPartsOf, type RatioParts } from '../aspectFields';
import { AssetPicker, FitField } from '../components';
import { MediaPicker } from '../MediaPicker';
import { assetsQuery } from '../queries';
import { sceneGridSize } from '../render/aspect';
import type { Draft } from '../sceneDraft';
import { stretchToRatio } from './blockOps';
import { ColorField, PickField, RangeField } from './BlockStyleFields';
import type { Change } from './arrangeActions';

export type ShownOn = { id: string; name: string; detail?: string; aspectLabel: string; sameShape: boolean };

const SHORTCUTS: [string, string][] = [
  ['Arrow keys', 'Move the selection by 1 unit (Shift: 10)'],
  ['Backspace', 'Delete the selection'],
  ['Command D', 'Duplicate'],
  ['Command ] and [', 'Bring forward and send backward (Option: to front and back)'],
  ['Command A', 'Select all blocks'],
  ['Command Z, Shift Command Z', 'Undo and redo'],
  ['Enter', 'Edit the text of the selected block'],
  ['Escape', 'Clear the selection'],
  ['Option while dragging', 'Switch snapping off'],
  ['Shift click', 'Add or remove a block from the selection'],
];

/** Properties of the screen itself, shown while no block is selected. */
export function ScreenProperties({
  draft,
  canEdit,
  shownOn,
  snapping,
  onSnappingChange,
  onChange,
}: {
  draft: Draft;
  canEdit: boolean;
  shownOn: readonly ShownOn[];
  snapping: boolean;
  onSnappingChange: (on: boolean) => void;
  onChange: Change;
}) {
  const fonts = (useQuery(assetsQuery()).data?.items ?? []).filter((asset) => asset.kind === 'font');
  const [parts, setParts] = useState<RatioParts>(() => ratioPartsOf(draft.aspectRatio));
  // Follows the screen's shape when it changes elsewhere (undo, redo).
  const [seen, setSeen] = useState(draft.aspectRatio);
  if (seen.width !== draft.aspectRatio.width || seen.height !== draft.aspectRatio.height) {
    setSeen(draft.aspectRatio);
    setParts(ratioPartsOf(draft.aspectRatio));
  }
  const patch = (partial: Partial<Draft>, key?: string) => onChange({ ...draft, ...partial }, key);

  /** Changing the shape stretches the blocks so they keep their relative place and size. */
  const commitShape = (next: RatioParts) => {
    if (ratioPartsError(next.width, next.height) !== null) return;
    const ratio = ratioOfParts(next);
    if (ratio.width === draft.aspectRatio.width && ratio.height === draft.aspectRatio.height) return;
    const blocks = stretchToRatio(draft.blocks, sceneGridSize(draft.aspectRatio), sceneGridSize(ratio));
    setSeen(ratio);
    onChange({ ...draft, aspectRatio: ratio, blocks });
  };

  return (
    <>
      <AccordionItem title="Screen" open>
        <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
          <div
            role="presentation"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) commitShape(parts);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitShape(parts);
            }}
          >
            <AspectRatioInput
              id="sp-shape"
              labelText="Shape (width : height)"
              value={parts}
              disabled={!canEdit}
              onChange={(next) => {
                setParts(next);
                // The swap button changes both parts at once and applies straight away.
                if (next.width !== parts.width && next.height !== parts.height) commitShape(next);
              }}
            />
          </div>
          <p className="sg-secondary">Blocks are stretched to the new shape. Applied when you leave the fields.</p>
          <ColorField
            id="sp-backgroundColor"
            label="Background colour"
            nullable={false}
            value={draft.backgroundColor}
            onChange={(value) => value && patch({ backgroundColor: value }, 'screen:backgroundColor')}
          />
          <MediaPicker
            id="sp-backgroundAssetId"
            labelText="Background image"
            kind="image"
            allowNone
            value={draft.backgroundAssetId ?? null}
            onChange={(assetId) =>
              patch(assetId ? { backgroundAssetId: assetId } : { backgroundAssetId: null, backgroundDim: 0 })
            }
          />
          {draft.backgroundAssetId && (
            <>
              <FitField
                id="sp-backgroundFit"
                value={draft.backgroundFit}
                onChange={(backgroundFit) => patch({ backgroundFit })}
              />
              <RangeField
                id="sp-backgroundDim"
                label="Darken image"
                min={0}
                max={80}
                value={draft.backgroundDim}
                onChange={(backgroundDim) => patch({ backgroundDim }, 'screen:backgroundDim')}
              />
            </>
          )}
        </fieldset>
      </AccordionItem>
      <AccordionItem title="Text and font" open>
        <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
          <RadioButtonGroup
            legendText="Text colour"
            name="sp-theme"
            valueSelected={draft.theme}
            onChange={(value) => patch({ theme: value as Draft['theme'] })}
          >
            <RadioButton id="sp-theme-dark" value="dark" labelText="Light text on the background" />
            <RadioButton id="sp-theme-light" value="light" labelText="Dark text on the background" />
          </RadioButtonGroup>
          <PickField
            id="sp-fontFamily"
            label="Font"
            value={draft.fontFamily}
            items={[
              { value: 'sans', text: 'Sans-serif' },
              { value: 'serif', text: 'Serif' },
              { value: 'mono', text: 'Monospace' },
              { value: 'custom', text: 'Uploaded font' },
            ]}
            onChange={(fontFamily) =>
              patch({ fontFamily, fontAssetId: fontFamily === 'custom' ? draft.fontAssetId : null })
            }
          />
          {draft.fontFamily === 'custom' && (
            <AssetPicker
              id="sp-fontAssetId"
              label="Uploaded font"
              kind="font"
              assets={fonts}
              value={draft.fontAssetId ?? null}
              disabledHint={fonts.length === 0 ? 'Upload a WOFF2 font under Media first.' : undefined}
              onChange={(fontAssetId) => patch({ fontAssetId })}
            />
          )}
        </fieldset>
      </AccordionItem>
      <AccordionItem title="Editing" open>
        <div className="sg-props__section">
          <Toggle
            id="sp-snapping"
            size="sm"
            labelText="Snapping"
            labelA="Off"
            labelB="On"
            toggled={snapping}
            onToggle={onSnappingChange}
          />
          <p className="sg-secondary">Blocks snap to edges, centres, margins and gaps. Hold Option to move freely.</p>
        </div>
      </AccordionItem>
      <AccordionItem title="Shown on" open>
        <div className="sg-props__section">
          {shownOn.length === 0 ? (
            <p className="sg-secondary">No display shows this screen yet.</p>
          ) : (
            <ul className="sg-props__shown">
              {shownOn.map((item) => (
                <li key={item.id}>
                  <span className="sg-props__shown-name">{item.name}</span>
                  <span className="sg-secondary">
                    {item.detail ? `${item.detail}, ` : ''}
                    {item.aspectLabel}
                  </span>
                  {!item.sameShape && (
                    <Tag size="sm" type="warm-gray">
                      Different shape
                    </Tag>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </AccordionItem>
      <AccordionItem title="Keyboard shortcuts">
        <dl className="sg-props__keys">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd className="sg-secondary">{what}</dd>
            </div>
          ))}
        </dl>
      </AccordionItem>
    </>
  );
}
