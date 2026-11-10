import { Accordion, IconButton, InlineNotification } from '@carbon/react';
import { Close } from '@carbon/icons-react';
import type { Draft } from '../sceneDraft';
import { BlockProperties } from './BlockProperties';
import { MultiProperties } from './MultiProperties';
import { ScreenProperties } from './ScreenProperties';
import './properties.scss';

export type PropertiesPanelProps = {
  draft: Draft;
  selectedIds: readonly string[];
  canEdit: boolean; // false → read-only view (show values, no inputs that change things)
  onChange: (next: Draft, coalesceKey?: string) => void; // every edit; same coalesceKey within ~500 ms = one undo step
  onSelect: (ids: string[]) => void; // e.g. close button clears selection
  overflowIds: ReadonlySet<string>; // blocks whose content does not fit → warning notice in the panel
  shownOn: readonly { id: string; name: string; detail?: string; aspectLabel: string; sameShape: boolean }[];
  snapping: boolean;
  onSnappingChange: (on: boolean) => void;
};

/** The editor's right-hand pane: the selected block, several blocks, or the screen itself. */
export function PropertiesPanel(props: PropertiesPanelProps) {
  const { draft, selectedIds, canEdit, onChange, onSelect, overflowIds } = props;
  const blocks = draft.blocks.filter((b) => selectedIds.includes(b.id));
  const title =
    blocks.length === 0 ? 'Screen' : blocks.length === 1 ? blocks[0].name : `${blocks.length} blocks selected`;
  const overflowing = blocks.filter((b) => overflowIds.has(b.id));
  return (
    <aside className="sg-props" aria-label="Properties">
      <header className="sg-props__header">
        <h2 className="sg-props__title">{title}</h2>
        {blocks.length > 0 && (
          <IconButton label="Close properties" kind="ghost" size="sm" align="left" onClick={() => onSelect([])}>
            <Close />
          </IconButton>
        )}
      </header>
      {!canEdit && <p className="sg-secondary sg-props__note">You can look at these settings but not change them.</p>}
      {overflowing.length > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Content does not fit"
          subtitle={
            overflowing.length === 1
              ? 'Make the block larger, reduce the text size or shorten the content.'
              : `${overflowing.map((b) => b.name).join(', ')} are too small for their content.`
          }
        />
      )}
      {/* Keyed by the selection so every field starts from the selected blocks and not from the previous ones. */}
      <Accordion size="md" key={blocks.map((b) => b.id).join('|')}>
        {blocks.length === 0 ? (
          <ScreenProperties
            draft={draft}
            canEdit={canEdit}
            shownOn={props.shownOn}
            snapping={props.snapping}
            onSnappingChange={props.onSnappingChange}
            onChange={onChange}
          />
        ) : blocks.length === 1 ? (
          <BlockProperties draft={draft} block={blocks[0]} canEdit={canEdit} onChange={onChange} onSelect={onSelect} />
        ) : (
          <MultiProperties draft={draft} blocks={blocks} canEdit={canEdit} onChange={onChange} onSelect={onSelect} />
        )}
      </Accordion>
    </aside>
  );
}
