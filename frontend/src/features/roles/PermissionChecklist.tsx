import { Checkbox, MultiSelect, Select, SelectItem, Stack } from '@carbon/react';
import type { ManagedDeviceType, Permission, PermissionGrant, PermissionId } from '../../api/generated/models';
import { PermissionGrantScope } from '../../api/generated/models';
import { grantCoveredBy } from '../auth/permissions';

type Props = {
  permissions: Permission[];
  grants: readonly PermissionGrant[];
  allowed: readonly PermissionGrant[];
  deviceTypes: ManagedDeviceType[];
  disabled?: boolean;
  onChange: (next: PermissionGrant[]) => void;
};

const displayName = (id: PermissionId) => id
  .split('.')
  .map((part) => part.replaceAll('_', ' '))
  .join(' · ');

export function PermissionChecklist({
  permissions, grants, allowed, deviceTypes, disabled = false, onChange,
}: Props) {
  const grantsByID = new Map(grants.map((grant) => [grant.permissionId, grant]));
  const allowedByID = new Map(allowed.map((grant) => [grant.permissionId, grant]));
  const replace = (permissionId: PermissionId, next?: PermissionGrant) => onChange(
    next
      ? [...grants.filter((grant) => grant.permissionId !== permissionId), next]
      : grants.filter((grant) => grant.permissionId !== permissionId),
  );

  return (
    <Stack gap={6} className="permission-groups">
      {permissions.map((permission) => {
        const grant = grantsByID.get(permission.id);
        const envelope = allowedByID.get(permission.id);
        const selectableTypes = envelope?.scope === PermissionGrantScope.selectedDeviceTypes
          ? deviceTypes.filter((type) => envelope.deviceTypeIds.includes(type.id))
          : deviceTypes;
        return (
          <div key={permission.id} className="permission-grant-row">
            <Checkbox
              id={`permission-${permission.id}`}
              labelText={displayName(permission.id)}
              helperText={permission.description}
              checked={Boolean(grant)}
              disabled={disabled || !envelope}
              onChange={(_, data) => replace(
                permission.id,
                data.checked && envelope ? initialGrant(permission.id, envelope) : undefined,
              )}
            />
            {grant && envelope && (
              <Select
                id={`scope-${permission.id}`}
                labelText="Scope"
                hideLabel
                value={grant.scope}
                disabled={disabled}
                onChange={(event) => {
                  const scope = event.target.value as PermissionGrant['scope'];
                  const firstType = selectableTypes[0]?.id;
                  replace(permission.id, {
                    ...grant,
                    scope,
                    deviceTypeIds: scope === PermissionGrantScope.selectedDeviceTypes && firstType ? [firstType] : [],
                  });
                }}
              >
                <SelectItem
                  value={PermissionGrantScope.everywhere}
                  text="Everywhere"
                  disabled={!scopeCovered(envelope, PermissionGrantScope.everywhere)}
                />
                <SelectItem
                  value={PermissionGrantScope.anyManagedDevice}
                  text="Any managed device"
                  disabled={!scopeCovered(envelope, PermissionGrantScope.anyManagedDevice)}
                />
                <SelectItem
                  value={PermissionGrantScope.selectedDeviceTypes}
                  text="Selected device types"
                  disabled={selectableTypes.length === 0}
                />
              </Select>
            )}
            {grant?.scope === PermissionGrantScope.selectedDeviceTypes && (
              <MultiSelect
                id={`device-types-${permission.id}`}
                titleText="Device types"
                label="Choose one or more device types"
                items={selectableTypes}
                itemToString={(type) => type?.name ?? ''}
                selectedItems={selectableTypes.filter((type) => grant.deviceTypeIds.includes(type.id))}
                disabled={disabled}
                invalid={grant.deviceTypeIds.length === 0}
                invalidText="Choose at least one device type."
                onChange={({ selectedItems }) => replace(permission.id, {
                  ...grant,
                  deviceTypeIds: (selectedItems ?? []).map((type) => type.id),
                })}
              />
            )}
          </div>
        );
      })}
    </Stack>
  );
}

function initialGrant(permissionId: PermissionId, envelope: PermissionGrant): PermissionGrant {
  return {
    permissionId,
    scope: envelope.scope,
    deviceTypeIds: envelope.scope === PermissionGrantScope.selectedDeviceTypes
      ? envelope.deviceTypeIds.slice(0, 1)
      : [],
  };
}

function scopeCovered(envelope: PermissionGrant, scope: PermissionGrant['scope']) {
  return grantCoveredBy(envelope, { permissionId: envelope.permissionId, scope, deviceTypeIds: [] });
}
