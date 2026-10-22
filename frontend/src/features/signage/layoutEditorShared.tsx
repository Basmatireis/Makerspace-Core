import { TextInput } from '@carbon/react';
import type { SignageCustomLayoutZone } from '../../api/generated/models';
import type { LayoutDraft } from './customLayoutModel';

export type LayoutEditorProps = {
  layout: LayoutDraft;
  /** Shape of the preview only; the layout itself is independent of the screen orientation. */
  orientation: 'landscape' | 'portrait';
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (patch: Partial<LayoutDraft>) => void;
};

/** Label of a zone, shown only in the editors; the renderer never draws it on a display. */
export function ZoneLabelField({
  id,
  zone,
  onChange,
}: {
  id: string;
  zone: SignageCustomLayoutZone;
  onChange: (label: string) => void;
}) {
  return (
    <TextInput
      id={id}
      labelText="Zone label"
      maxLength={60}
      invalid={zone.label.trim() === ''}
      invalidText="Give the zone a label"
      value={zone.label}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
