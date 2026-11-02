import { Select, SelectItem } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { SignageAspectRatio } from '../../api/generated/models';
import { sameRatio } from './helpers';
import { groupsQuery } from './queries';

/** Picks the group a display belongs to; only groups of the display's aspect ratio are offered. */
export function DisplayGroupSelect({
  id,
  ratio,
  value,
  onChange,
  helperText,
  disabled = false,
}: {
  id: string;
  ratio: SignageAspectRatio;
  value: string;
  onChange: (groupId: string) => void;
  helperText?: string;
  disabled?: boolean;
}) {
  const groups = (useQuery(groupsQuery()).data?.items ?? []).filter(
    (group) => group.id === value || sameRatio(group.aspectRatio, ratio),
  );
  return (
    <Select
      id={id}
      labelText="Group"
      value={value}
      helperText={helperText}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <SelectItem value="" text="No group" />
      {groups.map((group) => (
        <SelectItem key={group.id} value={group.id} text={group.name} />
      ))}
    </Select>
  );
}
