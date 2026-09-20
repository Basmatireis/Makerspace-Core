import { Button, Checkbox, InlineNotification, Select, SelectItem, Stack, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { listManagedDeviceTypes } from '../../api/generated/managed-devices/managed-devices';
import { listRoles } from '../../api/generated/roles/roles';
import { getVisitorEnrollmentConfiguration, updateVisitorEnrollmentConfiguration } from '../../api/generated/visitor-enrollment/visitor-enrollment';
import type { VisitorAuthenticationMethod } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';

export function VisitorEnrollmentSettingsPage() {
  const client = useQueryClient();
  const configuration = useQuery({ queryKey: ['visitor-enrollment', 'configuration'], queryFn: ({ signal }) => getVisitorEnrollmentConfiguration({ signal }) });
  const roles = useQuery({ queryKey: ['roles', 'visitor-configuration'], queryFn: ({ signal }) => listRoles({ limit: 100 }, { signal }) });
  const deviceTypes = useQuery({ queryKey: ['managed-device-types'], queryFn: ({ signal }) => listManagedDeviceTypes({ signal }) });
  const [enabled, setEnabled] = useState(false);
  const [roleId, setRoleId] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [methods, setMethods] = useState<VisitorAuthenticationMethod[]>([]);
  useEffect(() => {
    if (!configuration.data) return;
    setEnabled(configuration.data.enabled);
    setRoleId(configuration.data.initialRoleId ?? '');
    setSelectedTypes(configuration.data.deviceTypeIds);
    setMethods(configuration.data.allowedMethods);
  }, [configuration.data]);
  const mutation = useMutation({
    mutationFn: () => updateVisitorEnrollmentConfiguration({
      enabled,
      initialRoleId: roleId || null,
      deviceTypeIds: selectedTypes,
      allowedMethods: methods,
      expectedVersion: configuration.data!.version,
    }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ['visitor-enrollment'] }),
  });
  const toggle = <T extends string>(values: T[], value: T, checked: boolean) => checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);

  return <Stack gap={7}>
    <PageHeader title="Visitor enrollment" breadcrumbs={[{ label: 'Settings', to: '/settings' }]} description="Allow only approved ManagedDevice types to create visitors with one backend-selected initial Role." />
    {(configuration.isPending || roles.isPending || deviceTypes.isPending) && <InlineLoadingState label="Loading visitor enrollment configuration" />}
    {(configuration.isError || roles.isError || deviceTypes.isError) && <ErrorState title="Unable to load visitor enrollment settings" message="Check the connection and your permissions, then try again." onRetry={() => { void configuration.refetch(); void roles.refetch(); void deviceTypes.refetch(); }} />}
    {configuration.data && roles.data && deviceTypes.data && <Tile><Stack gap={5}>
      {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Configuration not saved" subtitle="The Role must be assignable by you and the configuration version must be current." />}
      {mutation.isSuccess && <InlineNotification kind="success" lowContrast hideCloseButton title="Configuration saved" subtitle="Only newly started terminal enrollments use these settings." />}
      <Checkbox id="visitor-enabled" labelText="Enable visitor-terminal enrollment" checked={enabled} onChange={(_, data) => setEnabled(data.checked)} />
      <Select id="visitor-role" labelText="Initial visitor Role" helperText="The terminal never chooses or submits a Role." value={roleId} onChange={(event) => setRoleId(event.target.value)}>
        <SelectItem value="" text="Choose a Role" />
        {roles.data.items.map((role) => <SelectItem key={role.id} value={role.id} text={role.name} />)}
      </Select>
      <fieldset><legend>Approved Device Types</legend><Stack gap={3}>{deviceTypes.data.items.map((type) => <Checkbox key={type.id} id={`visitor-device-${type.id}`} labelText={type.name} checked={selectedTypes.includes(type.id)} onChange={(_, data) => setSelectedTypes(toggle(selectedTypes, type.id, data.checked))} />)}</Stack></fieldset>
      <fieldset><legend>Allowed authentication methods</legend><Stack gap={3}><Checkbox id="visitor-method-password" labelText="Email invitation for local password" checked={methods.includes('password')} onChange={(_, data) => setMethods(toggle(methods, 'password', data.checked))} /><Checkbox id="visitor-method-pin" labelText="Username and PIN" checked={methods.includes('pin')} onChange={(_, data) => setMethods(toggle(methods, 'pin', data.checked))} /></Stack></fieldset>
      <InlineNotification kind="info" lowContrast hideCloseButton title="Admission remains separate" subtitle="Visitor submission explicitly creates the physical Lab Rules confirmation request. Blocking Roles remain inadmissible until a supervisor confirms the physical document." />
      <div><Button disabled={mutation.isPending || (enabled && (!roleId || selectedTypes.length === 0 || methods.length === 0))} onClick={() => mutation.mutate()}>{mutation.isPending ? 'Saving…' : 'Save configuration'}</Button></div>
    </Stack></Tile>}
  </Stack>;
}
