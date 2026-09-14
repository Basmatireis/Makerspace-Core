import { MultiSelect } from '@carbon/react';
import type { EligibilityRole } from '../../api/generated/models';

type Props = {
  id: string;
  titleText: string;
  roles: EligibilityRole[];
  selectedRoleIds: string[];
  onChange: (roleIds: string[]) => void;
};

export function RoleMultiSelect({ id, titleText, roles, selectedRoleIds, onChange }: Props) {
  return (
    <MultiSelect
      id={id}
      titleText={titleText}
      label="Choose roles"
      items={roles}
      itemToString={(role) => role?.name ?? ''}
      selectedItems={roles.filter((role) => selectedRoleIds.includes(role.id))}
      onChange={({ selectedItems }) => onChange((selectedItems ?? []).map((role) => role.id))}
    />
  );
}
