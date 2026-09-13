import { Checkbox, Stack } from '@carbon/react';
import type { Permission, PermissionId } from '../../api/generated/models';

type PermissionChecklistProps = {
  permissions: Permission[];
  selected: readonly PermissionId[];
  allowed: readonly PermissionId[];
  disabled?: boolean;
  onChange: (next: PermissionId[]) => void;
};

function displayName(id: PermissionId): string {
  return id
    .split('.')
    .map((part) => part.replaceAll('_', ' '))
    .join(' · ');
}

export function PermissionChecklist({
  permissions,
  selected,
  allowed,
  disabled = false,
  onChange,
}: PermissionChecklistProps) {
  const selectedSet = new Set(selected);
  const allowedSet = new Set(allowed);
  const grouped = permissions.reduce<Map<string, Permission[]>>((groups, permission) => {
    const key = permission.id.split('.')[0] ?? 'other';
    const items = groups.get(key) ?? [];
    items.push(permission);
    groups.set(key, items);
    return groups;
  }, new Map());

  return (
    <Stack gap={6} className="permission-groups">
      {[...grouped.entries()].map(([group, items]) => (
        <fieldset key={group} className="permission-group">
          <legend>{group}</legend>
          <Stack gap={4}>
            {items.map((permission) => {
              const checked = selectedSet.has(permission.id);
              const canChange = allowedSet.has(permission.id);
              return (
                <Checkbox
                  key={permission.id}
                  id={`permission-${permission.id}`}
                  labelText={displayName(permission.id)}
                  checked={checked}
                  disabled={disabled || !canChange}
                  helperText={permission.description}
                  onChange={(_, { checked: nextChecked }) => {
                    onChange(
                      nextChecked
                        ? [...selected, permission.id]
                        : selected.filter((id) => id !== permission.id),
                    );
                  }}
                />
              );
            })}
          </Stack>
        </fieldset>
      ))}
    </Stack>
  );
}
