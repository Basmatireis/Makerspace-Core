import { IconButton, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Checkmark, ChevronUp, Layers } from '../icons';
import { useState } from 'react';
import type { ToolType } from '../model';
import { SELECT_ICON, TOOL_GROUPS, toolInfo } from '../toolbox';

export interface InsertToolbarProps {
  /** The active tool; null is the select tool. */
  tool: ToolType | null;
  onTool: (tool: ToolType | null) => void;
  onAddLayer: () => void;
}

const shortLabel = (type: ToolType) => {
  const { label, key } = toolInfo(type);
  return key ? `${label} (${key})` : label;
};

/**
 * The tools at the bottom of the page preview, like a design tool's: pick one, then draw on the page or click a spot in
 * the structure. Each group's button repeats the tool used last; its chevron lists the whole group.
 */
export function InsertToolbar({ tool, onTool, onAddLayer }: InsertToolbarProps) {
  // The button of a group shows the tool used last in it, like in design tools.
  const [lastUsed, setLastUsed] = useState<Record<string, ToolType>>({});
  const pick = (groupKey: string, type: ToolType) => {
    setLastUsed((now) => ({ ...now, [groupKey]: type }));
    onTool(type);
  };

  return (
    <>
      {tool && (
        <div className="pdft-toolhint" role="status">
          {toolInfo(tool).label}: drag on the page to draw it, or click a spot in the structure · Esc cancels
        </div>
      )}
      <div className="pdft-insertbar" role="toolbar" aria-label="Tools">
        <IconButton
          label="Select and move (V)"
          kind="ghost"
          size="lg"
          align="top"
          isSelected={!tool}
          aria-pressed={!tool}
          onClick={() => onTool(null)}
        >
          <SELECT_ICON />
        </IconButton>
        <span className="pdft-insertbar__sep" aria-hidden="true" />
        {TOOL_GROUPS.map((group) => {
          // A tool picked from the menu (or a shortcut) of this group is shown on its button.
          const shown = tool && group.items.includes(tool) ? tool : (lastUsed[group.key] ?? group.items[0]);
          const Icon = toolInfo(shown).icon;
          return (
            <div key={group.key} className="pdft-insertbar__group">
              <IconButton
                label={shortLabel(shown)}
                kind="ghost"
                size="lg"
                align="top"
                isSelected={tool === shown}
                aria-pressed={tool === shown}
                onClick={() => (tool === shown ? onTool(null) : pick(group.key, shown))}
              >
                <Icon />
              </IconButton>
              <OverflowMenu
                size="lg"
                direction="top"
                flipped
                renderIcon={ChevronUp}
                aria-label={`Choose: ${group.label}`}
                iconDescription={`Choose: ${group.label}`}
                menuOptionsClass="pdft-flyout"
                className="pdft-insertbar__more"
              >
                {group.items.map((type) => {
                  const info = toolInfo(type);
                  const ItemIcon = info.icon;
                  return (
                    <OverflowMenuItem
                      key={type}
                      itemText={
                        <span className="pdft-flyout__item">
                          <ItemIcon size={16} className="pdft-flyout__icon" />
                          <span className="pdft-flyout__text">
                            <span className="pdft-flyout__label">{info.label}</span>
                            <span className="pdft-flyout__desc">{info.description}</span>
                          </span>
                          <span className="pdft-flyout__key">
                            {tool === type ? <Checkmark size={16} aria-label="Active" /> : info.key}
                          </span>
                        </span>
                      }
                      title={`${info.label}: ${info.description}`}
                      onClick={() => pick(group.key, type)}
                    />
                  );
                })}
              </OverflowMenu>
            </div>
          );
        })}
        <span className="pdft-insertbar__sep" aria-hidden="true" />
        <IconButton
          label="Add page layer"
          kind="ghost"
          size="lg"
          align="top"
          onClick={() => {
            onTool(null);
            onAddLayer();
          }}
        >
          <Layers />
        </IconButton>
      </div>
    </>
  );
}
