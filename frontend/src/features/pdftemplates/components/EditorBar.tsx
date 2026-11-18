import { Button, IconButton, Select, SelectItem, Tag } from '@carbon/react';
import { Keyboard, Redo, Undo, Version } from '../icons';
import type { PdfTemplateExport } from '../../../api/generated/models';
import { EXPORT_KINDS, EXPORT_LABELS } from '../exports';
import { KEYS } from '../../signage/editor/useEditorKeys';

export interface EditorBarProps {
  kind: PdfTemplateExport;
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

/** Document selector, state, undo/redo and the three actions above the three panes. */
export function EditorBar(props: EditorBarProps) {
  const { errors, warnings } = props;
  return (
    <header className="pdft-bar">
      <div className="pdft-bar__title">
        <h1 title={props.name}>{props.name}</h1>
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
      <Select
        id="pdft-export"
        className="pdft-bar__select"
        labelText="Document"
        size="md"
        value={props.kind}
        onChange={(event) => props.onKind(event.target.value as PdfTemplateExport)}
      >
        {EXPORT_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind} text={EXPORT_LABELS[kind]} />
        ))}
      </Select>
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
    </header>
  );
}
