import { useMemo, useState } from 'react';
import {
  Button,
  InlineNotification,
  MultiSelect,
  Select,
  SelectItem,
  Stack,
  Toggle,
} from '@carbon/react';
import { Add, Close, TrashCan } from '@carbon/icons-react';
import type {
  AuthenticationAssurance,
  ManagedDeviceType,
  Permission,
  PermissionGrant,
  Role,
} from '../../api/generated/models';
import { PermissionGrantScope } from '../../api/generated/models';
import {
  permissionGrantCoveredBy,
  permissionGrantDeviceTypeIds,
  permissionGrantsValid,
} from '../auth/permissions';
import { presentPermission } from './permissionPresentation';

type Props = {
  role: Role;
  permission: Permission;
  allowed: readonly PermissionGrant[];
  deviceTypes: ManagedDeviceType[];
  isSaving: boolean;
  error?: Error | null;
  stale: boolean;
  onSave: (rules: PermissionGrant[]) => void;
  onReload: () => void;
  onClose: () => void;
};

const assuranceOptions: { value: AuthenticationAssurance; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'strong', label: 'Strong' },
  { value: 'strong_mfa', label: 'Strong + MFA' },
];

export function PermissionEditor({
  role,
  permission,
  allowed,
  deviceTypes,
  isSaving,
  error,
  stale,
  onSave,
  onReload,
  onClose,
}: Props) {
  const initialRules = useMemo(() => role.permissionGrants
    .filter((grant) => grant.permissionId === permission.id)
    .map(copyGrant), [permission.id, role.permissionGrants]);
  const [rules, setRules] = useState<PermissionGrant[]>(initialRules);
  const enabled = rules.length > 0;
  const presentation = presentPermission(permission);
  const permissionEnvelopes = allowed.filter((grant) => grant.permissionId === permission.id);
  const dirty = JSON.stringify(rules) !== JSON.stringify(initialRules);

  return (
    <aside className="permission-editor" aria-labelledby="permission-editor-title">
      <div className="permission-editor__header">
        <div>
          <p className="permission-editor__eyebrow">{role.name}</p>
          <h2 id="permission-editor-title">{presentation.label}</h2>
          <p className="section-description">{permission.description}</p>
        </div>
        <Button kind="ghost" size="sm" hasIconOnly renderIcon={Close} iconDescription="Close permission editor" onClick={onClose} />
      </div>
      <div className="permission-editor__body">
        <Stack gap={6}>
          {error && <>
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={stale ? 'Role changed' : 'Permission not saved'}
              subtitle={stale ? 'Reload the latest role before applying this change again.' : error.message}
            />
            {stale && <Button kind="tertiary" size="sm" onClick={onReload}>Reload latest</Button>}
          </>}
          <Toggle
            id={`permission-enabled-${role.id}-${permission.id}`}
            labelText="Permission enabled"
            labelA="Disabled"
            labelB="Enabled"
            toggled={enabled}
            disabled={isSaving || permissionEnvelopes.length === 0}
            onToggle={(next) => setRules(next ? [initialGrant(permission.id, permissionEnvelopes[0])] : [])}
          />
          {enabled && (
            <div>
              <h3 className="permission-editor__section-title">Access rules</h3>
              <p className="section-description">Requirements inside a rule apply together. Separate rules are evaluated as OR alternatives.</p>
            </div>
          )}
          {rules.map((rule, index) => (
            <RuleEditor
              key={`${permission.id}-${index}`}
              index={index}
              rule={rule}
              envelopes={permissionEnvelopes}
              deviceTypes={deviceTypes}
              disabled={isSaving}
              onChange={(next) => setRules((current) => current.map((item, itemIndex) => itemIndex === index ? next : item))}
              onRemove={() => setRules((current) => current.filter((_, itemIndex) => itemIndex !== index))}
            />
          ))}
          {enabled && (
            <Button
              kind="tertiary"
              size="sm"
              renderIcon={Add}
              disabled={isSaving || permissionEnvelopes.length === 0}
              onClick={() => setRules((current) => [...current, initialGrant(permission.id, permissionEnvelopes[0])])}
            >
              Add access rule
            </Button>
          )}
        </Stack>
      </div>
      <div className="permission-editor__footer">
        <Button kind="secondary" disabled={isSaving} onClick={onClose}>Cancel</Button>
        <Button disabled={isSaving || !dirty || !permissionGrantsValid(rules)} onClick={() => onSave(rules)}>
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </aside>
  );
}

function RuleEditor({
  index,
  rule,
  envelopes,
  deviceTypes,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  rule: PermissionGrant;
  envelopes: readonly PermissionGrant[];
  deviceTypes: ManagedDeviceType[];
  disabled: boolean;
  onChange: (next: PermissionGrant) => void;
  onRemove: () => void;
}) {
  const selectableTypes = deviceTypes.filter((type) => permissionGrantCoveredBy(envelopes, {
    permissionId: rule.permissionId,
    scope: PermissionGrantScope.selectedDeviceTypes,
    deviceTypeIds: [type.id],
    minimumAssurance: 'strong_mfa',
  }));
  return (
    <section className="permission-editor__rule" aria-label={`Access rule ${index + 1}`}>
      <div className="permission-editor__rule-heading">
        <h3>Rule {index + 1}</h3>
        <Button kind="ghost" size="sm" hasIconOnly renderIcon={TrashCan} iconDescription={`Remove rule ${index + 1}`} disabled={disabled} onClick={onRemove} />
      </div>
      <Stack gap={5}>
        <Select
          id={`assurance-${rule.permissionId}-${index}`}
          labelText="Minimum authentication assurance"
          value={rule.minimumAssurance}
          disabled={disabled}
          onChange={(event) => onChange({ ...rule, minimumAssurance: event.target.value as AuthenticationAssurance })}
        >
          {assuranceOptions.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              text={option.label}
              disabled={!permissionGrantCoveredBy(envelopes, { ...rule, minimumAssurance: option.value })}
            />
          ))}
        </Select>
        <Select
          id={`device-scope-${rule.permissionId}-${index}`}
          labelText="Device context"
          value={rule.scope}
          disabled={disabled}
          onChange={(event) => {
            const scope = event.target.value as PermissionGrant['scope'];
            onChange({
              ...rule,
              scope,
              deviceTypeIds: scope === PermissionGrantScope.selectedDeviceTypes && selectableTypes[0]
                ? [selectableTypes[0].id]
                : [],
            });
          }}
        >
          <SelectItem value={PermissionGrantScope.everywhere} text="Everywhere" disabled={!scopeCovered(envelopes, rule, PermissionGrantScope.everywhere)} />
          <SelectItem value={PermissionGrantScope.anyManagedDevice} text="Any managed device" disabled={!scopeCovered(envelopes, rule, PermissionGrantScope.anyManagedDevice)} />
          <SelectItem value={PermissionGrantScope.selectedDeviceTypes} text="Selected device types" disabled={selectableTypes.length === 0} />
        </Select>
        {rule.scope === PermissionGrantScope.selectedDeviceTypes && (
          <MultiSelect
            id={`device-types-${rule.permissionId}-${index}`}
            titleText="Device types"
            label="Choose one or more device types"
            items={selectableTypes}
            itemToString={(type) => type?.name ?? ''}
            selectedItems={selectableTypes.filter((type) => permissionGrantDeviceTypeIds(rule).includes(type.id))}
            disabled={disabled}
            invalid={permissionGrantDeviceTypeIds(rule).length === 0}
            invalidText="Choose at least one device type."
            onChange={({ selectedItems }) => onChange({ ...rule, deviceTypeIds: (selectedItems ?? []).map((type) => type.id) })}
          />
        )}
      </Stack>
    </section>
  );
}

function copyGrant(grant: PermissionGrant): PermissionGrant {
  return {
    permissionId: grant.permissionId,
    scope: grant.scope,
    deviceTypeIds: [...permissionGrantDeviceTypeIds(grant)],
    minimumAssurance: grant.minimumAssurance,
  };
}

function initialGrant(permissionId: Permission['id'], envelope?: PermissionGrant): PermissionGrant {
  return {
    permissionId,
    scope: envelope?.scope ?? PermissionGrantScope.everywhere,
    deviceTypeIds: envelope?.scope === PermissionGrantScope.selectedDeviceTypes
      ? permissionGrantDeviceTypeIds(envelope).slice(0, 1)
      : [],
    minimumAssurance: envelope?.minimumAssurance ?? 'low',
  };
}

function scopeCovered(envelopes: readonly PermissionGrant[], rule: PermissionGrant, scope: PermissionGrant['scope']) {
  return permissionGrantCoveredBy(envelopes, { ...rule, scope, deviceTypeIds: [] });
}
