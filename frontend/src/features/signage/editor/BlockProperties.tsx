import { useState } from 'react';
import { AccordionItem, Button, Select, SelectItem, TextInput, Toggle } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { SignageBlock } from '../../../api/generated/models';
import { useMachineOptions } from '../preview';
import { assetsQuery, templatesQuery } from '../queries';
import { sceneGridSize } from '../render/aspect';
import type { Draft } from '../sceneDraft';
import { LIMITS, WIDGET_LABELS, WIDGET_TYPES, type WidgetType } from '../widgets';
import { WidgetFields } from '../WidgetFields';
import {
  applyStyleToSameType,
  resetStyle,
  setGeometry,
  setStyle,
  setWidgetType,
  updateBlocks,
  type Rect,
} from './blockOps';
import { BlockStyleFields, NumField } from './BlockStyleFields';
import { AlignTools, SymmetryTools } from './MultiProperties';
import { runArrange, type Change } from './arrangeActions';

/** The block's name, kept while typing so an emptied field does not rename the block to nothing. */
function NameField({
  block,
  canEdit,
  onName,
}: {
  block: SignageBlock;
  canEdit: boolean;
  onName: (name: string) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? block.name;
  return (
    <TextInput
      id="bp-name"
      labelText="Name"
      maxLength={LIMITS.blockName}
      readOnly={!canEdit}
      value={text}
      invalid={typed !== null && typed.trim() === ''}
      invalidText="Give the block a name."
      onBlur={() => setTyped(null)}
      onChange={(event) => {
        setTyped(event.target.value);
        if (event.target.value.trim() !== '') onName(event.target.value);
      }}
    />
  );
}

/** Properties of one selected block: content, text, position and size, then the other style sections. */
export function BlockProperties({
  draft,
  block,
  canEdit,
  onChange,
  onSelect,
}: {
  draft: Draft;
  block: SignageBlock;
  canEdit: boolean;
  onChange: Change;
  onSelect: (ids: string[]) => void;
}) {
  const { machines, known } = useMachineOptions();
  const templates = useQuery(templatesQuery()).data?.items ?? [];
  const assets = useQuery(assetsQuery()).data?.items ?? [];
  const id = block.id;
  const emit = (blocks: SignageBlock[], key?: string) => onChange({ ...draft, blocks }, key);
  const geometry = (partial: Partial<Rect>, field: string) =>
    emit(setGeometry(draft.blocks, id, partial), `${id}:geometry.${field}`);
  const run = (action: Parameters<typeof runArrange>[2]) =>
    runArrange(draft, [id], action, { rel: 'screen' }, onChange, onSelect);
  const sameTypeCount = draft.blocks.filter(
    (b) => b.id !== id && !b.locked && b.widget.type === block.widget.type,
  ).length;
  const type = block.widget.type;
  const grid = sceneGridSize(draft.aspectRatio);
  const geometryField = (field: keyof Rect, label: string, min: number, max: number) => (
    <NumField
      id={`bp-${field}`}
      label={label}
      value={block[field]}
      min={min}
      max={max}
      hideSteppers
      onChange={(v) => geometry({ [field]: v }, field)}
    />
  );
  return (
    <>
      <AccordionItem title="Content" open>
        <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
          <Select
            id="bp-type"
            labelText="Shows"
            value={type}
            onChange={(event) => emit(setWidgetType(draft.blocks, id, event.target.value as WidgetType))}
          >
            {WIDGET_TYPES.map((t) => (
              <SelectItem key={t} value={t} text={WIDGET_LABELS[t]} />
            ))}
          </Select>
          <NameField
            block={block}
            canEdit={canEdit}
            onName={(name) =>
              emit(
                updateBlocks(draft.blocks, [id], (b) => ({ ...b, name })),
                `${id}:name`,
              )
            }
          />
          <WidgetFields
            widget={block.widget}
            assets={assets}
            templates={templates}
            machines={machines}
            machinesKnown={known}
            onChange={(widget) =>
              emit(
                updateBlocks(draft.blocks, [id], (b) => ({ ...b, widget })),
                `${id}:widget`,
              )
            }
          />
        </fieldset>
      </AccordionItem>
      <BlockStyleFields
        blocks={[block]}
        canEdit={canEdit}
        onStyle={(partial, key) => emit(setStyle(draft.blocks, [id], partial), key && `${id}:${key}`)}
        layout={
          <AccordionItem title="Position and size" open>
            <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
              <div className="sg-props__quad">
                {geometryField('x', 'X', -LIMITS.blockCoordinate, LIMITS.blockCoordinate)}
                {geometryField('y', 'Y', -LIMITS.blockCoordinate, LIMITS.blockCoordinate)}
                {geometryField('w', 'Width', LIMITS.blockMinExtent, LIMITS.blockMaxExtent)}
                {geometryField('h', 'Height', LIMITS.blockMinExtent, LIMITS.blockMaxExtent)}
              </div>
              <p className="sg-props__help">
                Units on a {grid.width} × {grid.height} screen.
              </p>
              <div className="sg-props__group">
                <p className="sg-props__label">Place on the screen</p>
                <AlignTools run={run} disabled={block.locked} />
                <SymmetryTools run={run} disabled={block.locked} />
                {block.locked && <p className="sg-props__help">Unlock the block to move it with these tools.</p>}
              </div>
            </fieldset>
          </AccordionItem>
        }
        textExtra={
          block.widget.type === 'text' ? (
            <Toggle
              id="bp-fit"
              size="sm"
              labelText="Shrink text to fit"
              labelA="Off"
              labelB="On"
              toggled={block.widget.fit}
              onToggle={(fit) =>
                emit(
                  updateBlocks(draft.blocks, [id], (b) =>
                    b.widget.type === 'text' ? { ...b, widget: { ...b.widget, fit } } : b,
                  ),
                )
              }
            />
          ) : undefined
        }
        blockExtra={
          <>
            <div className="sg-props__toggles">
              <Toggle
                id="bp-hidden"
                size="sm"
                labelText="Hidden on displays"
                labelA="Shown"
                labelB="Hidden"
                disabled={!canEdit}
                toggled={block.hidden}
                onToggle={(hidden) => emit(updateBlocks(draft.blocks, [id], (b) => ({ ...b, hidden })))}
              />
              <Toggle
                id="bp-locked"
                size="sm"
                labelText="Locked in the editor"
                labelA="Unlocked"
                labelB="Locked"
                disabled={!canEdit}
                toggled={block.locked}
                onToggle={(locked) => emit(updateBlocks(draft.blocks, [id], (b) => ({ ...b, locked })))}
              />
            </div>
            <div className="sg-props__buttons">
              <Button
                kind="tertiary"
                size="sm"
                disabled={!canEdit || sameTypeCount === 0}
                onClick={() => emit(applyStyleToSameType(draft.blocks, id))}
              >
                Apply style to all {WIDGET_LABELS[type]} blocks
              </Button>
              <Button kind="ghost" size="sm" disabled={!canEdit} onClick={() => emit(resetStyle(draft.blocks, id))}>
                Reset style
              </Button>
            </div>
          </>
        }
      />
    </>
  );
}
