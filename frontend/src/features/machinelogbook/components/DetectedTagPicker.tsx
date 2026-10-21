import { ComboBox } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { DetectedSpoolTag } from '../../../api/generated/models';
import { detectedSpoolTagsQuery } from '../queries';
import { useCan } from '../shared/useCan';

type Option = { id: string; label: string; tag: DetectedSpoolTag; disabled: boolean };

const slotLabel = (tag: DetectedSpoolTag) =>
  tag.slotName
    ? [tag.inputUnitName, tag.slotName].filter(Boolean).join(' ')
    : `${tag.unitLabel} tray ${tag.trayExternalId}`;

function optionOf(tag: DetectedSpoolTag, spoolId: string | undefined): Option {
  const material = [tag.subBrand ?? tag.materialType, tag.colorHex ? `#${tag.colorHex}` : null]
    .filter(Boolean)
    .join(' ');
  const owner = !tag.spool ? '' : tag.spool.id === spoolId ? ' (on this spool)' : ` (on ${tag.spool.displayId})`;
  const parts = [tag.machineName, slotLabel(tag), material, tag.tagUid];
  return {
    id: `${tag.machineId}:${tag.unitExternalId}:${tag.trayExternalId}`,
    label: `${parts.filter(Boolean).join(' · ')}${owner}`,
    tag,
    disabled: tag.spool !== null,
  };
}

/**
 * Optional aid next to an NFC value field: lists the spool tags the printers currently report. Hidden without
 * `machines.read` and `inventory.read` (no request is made) and silent when the request fails.
 */
export function DetectedTagPicker({
  id,
  open = true,
  spoolId,
  onPick,
}: {
  id: string;
  open?: boolean;
  /** The spool being edited, so its own tag is marked as such. */
  spoolId?: string;
  onPick: (tagUid: string) => void;
}) {
  const can = useCan();
  const allowed = can('machines.read') && can('inventory.read');
  const query = useQuery({ ...detectedSpoolTagsQuery(), enabled: open && allowed });
  if (!allowed || !query.isSuccess) return null;
  const options = query.data.items.map((tag) => optionOf(tag, spoolId));
  if (options.length === 0)
    return <p className="mj-secondary">No spool tags are detected in a printer right now. Type or scan the value.</p>;
  return (
    <ComboBox
      autoAlign
      id={id}
      titleText="Detected in a printer"
      helperText="Pick a tag a printer currently reads to fill in the value."
      placeholder="Select a detected tag"
      items={options}
      itemToString={(option: Option | null) => option?.label ?? ''}
      selectedItem={null}
      onChange={({ selectedItem }: { selectedItem?: Option | null }) => {
        if (selectedItem && !selectedItem.disabled) onPick(selectedItem.tag.tagUid);
      }}
    />
  );
}
