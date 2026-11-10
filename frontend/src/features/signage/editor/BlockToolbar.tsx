import { IconButton, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import {
  AlignHorizontalCenter,
  AlignHorizontalLeft,
  AlignHorizontalRight,
  AlignVerticalBottom,
  AlignVerticalCenter,
  AlignVerticalTop,
  BringForward,
  Copy,
  DistributeHorizontalCenter,
  DistributeVerticalCenter,
  Locked,
  SendBackward,
  SplitScreen,
  TrashCan,
  type CarbonIconType,
} from '@carbon/icons-react';
import type { SignageBlock } from '../../../api/generated/models';
import type { ArrangeAction } from './blockOps';
import { WIDGET_ICONS } from './widgetIcons';
import { KEYS } from './useEditorKeys';
import { WIDGET_LABELS } from '../widgets';

export type BlockAction = 'splitV' | 'splitH' | 'dup' | 'front' | 'back' | 'top' | 'bottom' | 'del' | 'unlock';

function ToolButton({
  label,
  icon: Icon,
  onClick,
  disabled,
  danger,
}: {
  label: string;
  icon: CarbonIconType;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <IconButton
      label={label}
      kind="ghost"
      size="sm"
      align="top"
      disabled={disabled}
      className={danger ? 'sg-toolbar__danger' : undefined}
      onClick={onClick}
    >
      <Icon />
    </IconButton>
  );
}

/** Actions of the one selected block, floating above it on the canvas. A locked block only offers to unlock. */
export function BlockToolbar({
  block,
  isFront,
  isBack,
  onAction,
}: {
  block: SignageBlock;
  isFront: boolean;
  isBack: boolean;
  onAction: (action: BlockAction) => void;
}) {
  const TypeIcon = WIDGET_ICONS[block.widget.type];
  return (
    <div className="sg-toolbar" role="toolbar" aria-label={`Actions for ${block.name}`}>
      <span className="sg-toolbar__type">
        <TypeIcon aria-hidden="true" />
        {block.widget.type === 'empty' ? 'Empty' : WIDGET_LABELS[block.widget.type]}
      </span>
      {block.locked ? (
        <ToolButton label="Unlock to move or resize" icon={Locked} onClick={() => onAction('unlock')} />
      ) : (
        <>
          <ToolButton label="Split into left and right" icon={SplitScreen} onClick={() => onAction('splitV')} />
          <span className="sg-toolbar__rotate">
            <ToolButton label="Split into top and bottom" icon={SplitScreen} onClick={() => onAction('splitH')} />
          </span>
          <span className="sg-toolbar__sep" aria-hidden="true" />
          <ToolButton label={`Duplicate (${KEYS.mod}D)`} icon={Copy} onClick={() => onAction('dup')} />
          <ToolButton
            label={`Bring forward (${KEYS.mod}])`}
            icon={BringForward}
            disabled={isFront}
            onClick={() => onAction('front')}
          />
          <ToolButton
            label={`Send backward (${KEYS.mod}[)`}
            icon={SendBackward}
            disabled={isBack}
            onClick={() => onAction('back')}
          />
          <OverflowMenu size="sm" aria-label="Arrange" iconDescription="Arrange: to front or back" align="bottom">
            <OverflowMenuItem
              itemText={`Bring to front (${KEYS.alt}${KEYS.mod}])`}
              disabled={isFront}
              onClick={() => onAction('top')}
            />
            <OverflowMenuItem
              itemText={`Bring forward (${KEYS.mod}])`}
              disabled={isFront}
              onClick={() => onAction('front')}
            />
            <OverflowMenuItem
              itemText={`Send backward (${KEYS.mod}[)`}
              disabled={isBack}
              onClick={() => onAction('back')}
            />
            <OverflowMenuItem
              itemText={`Send to back (${KEYS.alt}${KEYS.mod}[)`}
              disabled={isBack}
              onClick={() => onAction('bottom')}
            />
          </OverflowMenu>
          <span className="sg-toolbar__sep" aria-hidden="true" />
          <ToolButton label={`Delete (${KEYS.del})`} icon={TrashCan} danger onClick={() => onAction('del')} />
        </>
      )}
    </div>
  );
}

const ALIGN_TOOLS: { action: ArrangeAction; label: string; icon: CarbonIconType }[] = [
  { action: 'left', label: 'Align left edges', icon: AlignHorizontalLeft },
  { action: 'hcenter', label: 'Align horizontal centres', icon: AlignHorizontalCenter },
  { action: 'right', label: 'Align right edges', icon: AlignHorizontalRight },
  { action: 'top', label: 'Align top edges', icon: AlignVerticalTop },
  { action: 'middle', label: 'Align vertical centres', icon: AlignVerticalCenter },
  { action: 'bottom', label: 'Align bottom edges', icon: AlignVerticalBottom },
];

/** Actions of a multi-selection: align, distribute, duplicate and delete. */
export function GroupToolbar({ count, onArrange }: { count: number; onArrange: (action: ArrangeAction) => void }) {
  return (
    <div className="sg-toolbar" role="toolbar" aria-label={`Actions for ${count} blocks`}>
      <span className="sg-toolbar__type">{count} blocks</span>
      {ALIGN_TOOLS.map((tool) => (
        <ToolButton key={tool.action} label={tool.label} icon={tool.icon} onClick={() => onArrange(tool.action)} />
      ))}
      <span className="sg-toolbar__sep" aria-hidden="true" />
      <ToolButton
        label="Distribute horizontally (equal gaps)"
        icon={DistributeHorizontalCenter}
        onClick={() => onArrange('distH')}
      />
      <ToolButton
        label="Distribute vertically (equal gaps)"
        icon={DistributeVerticalCenter}
        onClick={() => onArrange('distV')}
      />
      <span className="sg-toolbar__sep" aria-hidden="true" />
      <ToolButton label={`Duplicate all (${KEYS.mod}D)`} icon={Copy} onClick={() => onArrange('dup')} />
      <ToolButton label={`Delete all (${KEYS.del})`} icon={TrashCan} danger onClick={() => onArrange('del')} />
    </div>
  );
}
