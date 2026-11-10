import { useState, type ReactNode } from 'react';
import { AccordionItem, Button, ContentSwitcher, IconButton, Switch } from '@carbon/react';
import {
  AlignHorizontalCenter,
  AlignHorizontalLeft,
  AlignHorizontalRight,
  AlignVerticalBottom,
  AlignVerticalCenter,
  AlignVerticalTop,
  Copy,
  DistributeHorizontalCenter,
  DistributeVerticalCenter,
  ReflectHorizontal,
  ReflectVertical,
} from '@carbon/icons-react';
import type { SignageBlock } from '../../../api/generated/models';
import type { Draft } from '../sceneDraft';
import { DEFAULT_GAP, setStyle, type ArrangeAction } from './blockOps';
import { runArrange, type Change } from './arrangeActions';
import { BlockStyleFields, NumField } from './BlockStyleFields';

export function ToolButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <IconButton label={label} kind="ghost" size="sm" align="top" disabled={disabled} onClick={onClick}>
      {children}
    </IconButton>
  );
}

type Run = (action: ArrangeAction) => void;

/** The six align buttons. */
export function AlignTools({ run, disabled }: { run: Run; disabled?: boolean }) {
  return (
    <div className="sg-props__tools" role="group" aria-label="Align">
      <ToolButton label="Align left" disabled={disabled} onClick={() => run('left')}>
        <AlignHorizontalLeft />
      </ToolButton>
      <ToolButton label="Align centre horizontally" disabled={disabled} onClick={() => run('hcenter')}>
        <AlignHorizontalCenter />
      </ToolButton>
      <ToolButton label="Align right" disabled={disabled} onClick={() => run('right')}>
        <AlignHorizontalRight />
      </ToolButton>
      <ToolButton label="Align top" disabled={disabled} onClick={() => run('top')}>
        <AlignVerticalTop />
      </ToolButton>
      <ToolButton label="Align middle" disabled={disabled} onClick={() => run('middle')}>
        <AlignVerticalCenter />
      </ToolButton>
      <ToolButton label="Align bottom" disabled={disabled} onClick={() => run('bottom')}>
        <AlignVerticalBottom />
      </ToolButton>
    </div>
  );
}

/** Centre on the screen, mirror across its centre and mirrored copies. */
export function SymmetryTools({ run, disabled }: { run: Run; disabled?: boolean }) {
  return (
    <div className="sg-props__tools" role="group" aria-label="Symmetry">
      <ToolButton label="Centre horizontally on the screen" disabled={disabled} onClick={() => run('centerH')}>
        <DistributeHorizontalCenter />
      </ToolButton>
      <ToolButton label="Centre vertically on the screen" disabled={disabled} onClick={() => run('centerV')}>
        <DistributeVerticalCenter />
      </ToolButton>
      <ToolButton label="Mirror horizontally" disabled={disabled} onClick={() => run('mirrorH')}>
        <ReflectHorizontal />
      </ToolButton>
      <ToolButton label="Mirror vertically" disabled={disabled} onClick={() => run('mirrorV')}>
        <ReflectVertical />
      </ToolButton>
      <ToolButton label="Mirrored copy, left to right" disabled={disabled} onClick={() => run('mirrorCopyH')}>
        <Copy />
      </ToolButton>
      <ToolButton label="Mirrored copy, top to bottom" disabled={disabled} onClick={() => run('mirrorCopyV')}>
        <Copy className="sg-props__rotate" />
      </ToolButton>
    </div>
  );
}

/** Properties of several selected blocks: arrange tools and the style they share. */
export function MultiProperties({
  draft,
  blocks,
  canEdit,
  onChange,
  onSelect,
}: {
  draft: Draft;
  blocks: readonly SignageBlock[];
  canEdit: boolean;
  onChange: Change;
  onSelect: (ids: string[]) => void;
}) {
  const [rel, setRel] = useState<'selection' | 'screen'>('selection');
  const [gap, setGap] = useState(DEFAULT_GAP);
  const ids = blocks.map((b) => b.id);
  const run: Run = (action) => runArrange(draft, ids, action, { rel, gap }, onChange, onSelect);
  return (
    <>
      <AccordionItem title="Arrange" open>
        <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
          <ContentSwitcher
            size="sm"
            selectedIndex={rel === 'selection' ? 0 : 1}
            onChange={({ name }) => setRel(name === 'screen' ? 'screen' : 'selection')}
          >
            <Switch name="selection" text="Each other" />
            <Switch name="screen" text="Screen margins" />
          </ContentSwitcher>
          <AlignTools run={run} />
          <div className="sg-props__tools" role="group" aria-label="Distribute">
            <ToolButton label="Distribute horizontally" onClick={() => run('distH')}>
              <DistributeHorizontalCenter />
            </ToolButton>
            <ToolButton label="Distribute vertically" onClick={() => run('distV')}>
              <DistributeVerticalCenter />
            </ToolButton>
          </div>
          <NumField id="ma-gap" label="Gap" value={gap} min={0} max={400} onChange={setGap} />
          <div className="sg-props__buttons">
            <Button kind="ghost" size="sm" onClick={() => run('gapH')}>
              Line up in a row
            </Button>
            <Button kind="ghost" size="sm" onClick={() => run('gapV')}>
              Stack in a column
            </Button>
          </div>
          <div className="sg-props__buttons">
            <Button kind="ghost" size="sm" onClick={() => run('sameW')}>
              Same width
            </Button>
            <Button kind="ghost" size="sm" onClick={() => run('sameH')}>
              Same height
            </Button>
            <Button kind="ghost" size="sm" onClick={() => run('sameSize')}>
              Same size
            </Button>
          </div>
          <SymmetryTools run={run} />
        </fieldset>
      </AccordionItem>
      <BlockStyleFields
        blocks={blocks}
        canEdit={canEdit}
        onStyle={(partial, key) =>
          onChange({ ...draft, blocks: setStyle(draft.blocks, ids, partial) }, key && `multi:${key}`)
        }
      />
    </>
  );
}
