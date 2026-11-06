import { Button, Checkbox, InlineNotification, Stack, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { listManagedDeviceTypes } from '../../api/generated/managed-devices/managed-devices';
import {
  getVisitorEnrollmentConfiguration,
  updateVisitorEnrollmentConfiguration,
} from '../../api/generated/visitor-enrollment/visitor-enrollment';
import type { VisitorAuthenticationMethod } from '../../api/generated/models';
import { SettingsLoading, SettingsSection } from '../settings/SettingsPageLayout';
import { ErrorState } from '../../app/PageState';

/** Settings › Devices & sessions › Visitor sign-up: how visitors enrol themselves at approved kiosks. */
export function VisitorSignUpPanel() {
  const client = useQueryClient();
  const configuration = useQuery({
    queryKey: ['visitor-enrollment', 'configuration'],
    queryFn: ({ signal }) => getVisitorEnrollmentConfiguration({ signal }),
  });
  const deviceTypes = useQuery({
    queryKey: ['managed-device-types'],
    queryFn: ({ signal }) => listManagedDeviceTypes({ signal }),
  });
  const [enabled, setEnabled] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [methods, setMethods] = useState<VisitorAuthenticationMethod[]>([]);
  useEffect(() => {
    if (!configuration.data) return;
    setEnabled(configuration.data.enabled);
    setSelectedTypes(configuration.data.deviceTypeIds);
    setMethods(configuration.data.allowedMethods);
  }, [configuration.data]);
  const mutation = useMutation({
    mutationFn: () =>
      updateVisitorEnrollmentConfiguration({
        enabled,
        deviceTypeIds: selectedTypes,
        allowedMethods: methods,
        expectedVersion: configuration.data!.version,
      }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ['visitor-enrollment'] }),
  });
  const toggle = <T extends string>(values: T[], value: T, checked: boolean) =>
    checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);

  return (
    <SettingsSection
      title="Visitor sign-up"
      description="Approved kiosks, the initial role and the authentication methods visitors can choose."
    >
      {(configuration.isPending || deviceTypes.isPending) && (
        <SettingsLoading label="Loading visitor enrollment configuration" />
      )}
      {(configuration.isError || deviceTypes.isError) && (
        <ErrorState
          title="Unable to load visitor enrollment settings"
          message="Check the connection and your permissions, then try again."
          onRetry={() => {
            void configuration.refetch();
            void deviceTypes.refetch();
          }}
        />
      )}
      {configuration.data && deviceTypes.data && (
        <Tile>
          <Stack gap={5}>
            {mutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Configuration not saved"
                subtitle="You must be allowed to assign the Visitor role and the configuration version must be current."
              />
            )}
            {mutation.isSuccess && (
              <InlineNotification
                kind="success"
                lowContrast
                hideCloseButton
                title="Configuration saved"
                subtitle="Only newly started kiosk enrollments use these settings."
              />
            )}
            <Checkbox
              id="visitor-enabled"
              labelText="Enable visitor-kiosk enrollment"
              checked={enabled}
              onChange={(_, data) => setEnabled(data.checked)}
            />
            <p>Enrolled visitors get the Visitor membership role.</p>
            <fieldset>
              <legend>Approved Device Types</legend>
              <Stack gap={3}>
                {deviceTypes.data.items.map((type) => (
                  <Checkbox
                    key={type.id}
                    id={`visitor-device-${type.id}`}
                    labelText={type.name}
                    checked={selectedTypes.includes(type.id)}
                    onChange={(_, data) => setSelectedTypes(toggle(selectedTypes, type.id, data.checked))}
                  />
                ))}
              </Stack>
            </fieldset>
            <fieldset>
              <legend>Allowed authentication methods</legend>
              <Stack gap={3}>
                <Checkbox
                  id="visitor-method-password"
                  labelText="Email invitation for local password"
                  checked={methods.includes('password')}
                  onChange={(_, data) => setMethods(toggle(methods, 'password', data.checked))}
                />
                <Checkbox
                  id="visitor-method-pin"
                  labelText="Username and PIN"
                  checked={methods.includes('pin')}
                  onChange={(_, data) => setMethods(toggle(methods, 'pin', data.checked))}
                />
              </Stack>
            </fieldset>
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="Admission remains separate"
              subtitle="Visitor submission explicitly creates the physical Lab Rules confirmation request. Blocking Roles remain inadmissible until a supervisor confirms the physical document."
            />
            <div>
              <Button
                disabled={mutation.isPending || (enabled && (selectedTypes.length === 0 || methods.length === 0))}
                onClick={() => mutation.mutate()}
              >
                {mutation.isPending ? 'Saving…' : 'Save configuration'}
              </Button>
            </div>
          </Stack>
        </Tile>
      )}
    </SettingsSection>
  );
}
