import { Button, IconButton, Menu, MenuItemRadioGroup, Select, SelectItem, Tag } from '@carbon/react';
import { useRef, useState } from 'react';
import { ChevronDown, Keyboard, Redo, Undo, Version } from '../icons';
import type { PdfTemplateExport } from '../../../api/generated/models';
import { EXPORT_KINDS, EXPORT_LABELS } from '../exports';
import { KEYS } from '../../signage/editor/useEditorKeys';

export interface EditorBarProps {
  kind: PdfTemplateExport;
  /** The data the preview is made with, next to the document it belongs to. */
  sources: readonly { id: string; label: string }[];
  source: string;
  onSource: (id: string) => void;
  name: string;
  onKind: (kind: PdfTemplateExport) => void;
  status: { label: string; tone: 'blue' | 'green' | 'gray' };
  errors: number;
  warnings: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onVersions: () => void;
  onShortcuts: () => void;
  onSave: () => void;
  onPublish: () => void;
  saveDisabled: boolean;
  publishDisabled: boolean;
  saving: boolean;
}

/**
 * The template name doubles as the document switcher: a borderless button in the heading opens a Carbon menu with the
 * three documents, so the bar needs no separate select.
 */
function DocumentMenu({ name, kind, onKind }: Pick<EditorBarProps, 'name' | 'kind' | 'onKind'>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: [number, number]; y: [number, number] } | null>(null);
  const close = () => {
    setAnchor(null);
    trigger.current?.focus();
  };
  return (
    <h1 className="pdft-bar__heading">
      <button
        ref={trigger}
        type="button"
        className="pdft-bar__doc"
        title={name}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`${name}, ${EXPORT_LABELS[kind]}: choose the document`}
        onClick={() => {
          if (anchor) return close();
          const box = trigger.current!.getBoundingClientRect();
          setAnchor({ x: [box.left, box.right], y: [box.top, box.bottom] });
        }}
      >
        <span className="pdft-bar__doc-name">{name}</span>
        <ChevronDown size={20} aria-hidden="true" />
      </button>
      <Menu label="Document" size="md" open={anchor !== null} x={anchor?.x} y={anchor?.y} onClose={close}>
        <MenuItemRadioGroup
          label="Document"
          items={[...EXPORT_KINDS]}
          selectedItem={kind}
          // Carbon types the radio items as unknown; they are the export kinds passed in `items`.
          itemToString={(item) => EXPORT_LABELS[item as PdfTemplateExport]}
          onChange={(item) => {
            close();
            if (item !== kind) onKind(item as PdfTemplateExport);
          }}
        />
      </Menu>
    </h1>
  );
}

/** Document switcher, state, undo/redo and the three actions above the three panes. */
export function EditorBar(props: EditorBarProps) {
  const { errors, warnings } = props;
  return (
    <header className="pdft-bar">
      <div className="pdft-bar__title">
        <DocumentMenu name={props.name} kind={props.kind} onKind={props.onKind} />
        <div className="pdft-bar__tags">
          <Tag type={props.status.tone} size="md">
            {props.status.label}
          </Tag>
          {errors > 0 && (
            <Tag type="red" size="md">
              {errors} problem{errors === 1 ? '' : 's'}
            </Tag>
          )}
          {errors === 0 && warnings > 0 && (
            <Tag type="warm-gray" size="md">
              {warnings} warning{warnings === 1 ? '' : 's'}
            </Tag>
          )}
        </div>
      </div>
      <Select
        id="pdft-data"
        className="pdft-bar__select"
        labelText="Data"
        size="md"
        value={props.source}
        onChange={(event) => props.onSource(event.target.value)}
      >
        {props.sources.map((s) => (
          <SelectItem key={s.id} value={s.id} text={s.label} />
        ))}
      </Select>
      <div className="pdft-bar__actions">
        <div className="pdft-bar__group" role="group" aria-label="Undo and redo">
          <IconButton
            label={`Undo (${KEYS.mod}Z)`}
            kind="ghost"
            size="md"
            align="bottom"
            disabled={!props.canUndo}
            onClick={props.onUndo}
          >
            <Undo />
          </IconButton>
          <IconButton
            label={`Redo (${KEYS.shift}${KEYS.mod}Z)`}
            kind="ghost"
            size="md"
            align="bottom"
            disabled={!props.canRedo}
            onClick={props.onRedo}
          >
            <Redo />
          </IconButton>
        </div>
        <IconButton label="Keyboard shortcuts (?)" kind="ghost" size="md" align="bottom" onClick={props.onShortcuts}>
          <Keyboard />
        </IconButton>
        <Button kind="ghost" size="md" renderIcon={Version} onClick={props.onVersions}>
          Versions
        </Button>
        <Button kind="secondary" size="md" disabled={props.saveDisabled || props.saving} onClick={props.onSave}>
          Save draft
        </Button>
        <Button kind="primary" size="md" disabled={props.publishDisabled} onClick={props.onPublish}>
          Publish
        </Button>
      </div>
    </header>
  );
}
