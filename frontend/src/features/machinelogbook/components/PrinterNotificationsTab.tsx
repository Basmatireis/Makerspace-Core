import { useState } from 'react';
import { Button, ComboBox, Dropdown, InlineNotification, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { updatePrinterNotificationSettings } from '../../../api/generated/printing/printing';
import type { PrinterErrorSeverity, PrinterNotificationSettings, Role } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { fullRoleCatalogOptions } from '../../roles/queries';
import { machineLogbookKeys, printerNotificationSettingsQuery } from '../queries';
import { severityHelp, severityLabel, severityOrder } from '../printerErrors/printerErrorText';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import '../recording/recording.scss';

type RoleChoice = { id: string; name: string };
type SeverityChoice = { id: PrinterErrorSeverity; label: string };

const severityChoices: SeverityChoice[] = severityOrder.map((id) => ({ id, label: severityLabel[id] }));

function SettingsForm({ settings }: { settings: PrinterNotificationSettings }) {
  const client = useQueryClient();
  const notify = useNotify();
  const can = useCan();
  const canManage = can('machines.manage');
  const canReadRoles = can('roles.read');
  const roles = useQuery({ ...fullRoleCatalogOptions, enabled: canReadRoles });
  const [roleId, setRoleId] = useState<string | null>(settings.errorRoleId);
  const [severity, setSeverity] = useState<PrinterErrorSeverity>(settings.errorMinSeverity);
  const choices: RoleChoice[] = (roles.data ?? []).map((role: Role) => ({ id: role.id, name: role.name }));
  // The saved role stays visible by name when the catalog is unreadable or has not loaded.
  if (settings.errorRoleId && !choices.some((role) => role.id === settings.errorRoleId)) {
    choices.push({ id: settings.errorRoleId, name: settings.errorRoleName ?? 'Current role' });
  }
  const selected = choices.find((role) => role.id === roleId) ?? null;
  const unchanged = roleId === settings.errorRoleId && severity === settings.errorMinSeverity;
  const save = useMutation({
    mutationFn: () =>
      updatePrinterNotificationSettings({
        errorRoleId: roleId,
        errorMinSeverity: severity,
        expectedVersion: settings.version,
      }),
    onSuccess: async () => {
      notify({ kind: 'success', title: 'Printer notification settings saved' });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.printerNotificationSettings() });
    },
  });
  return (
    <Tile className="recording-settings">
      <h3 className="mj-section-title">Printer errors</h3>
      <div className="mj-stack">
        <p className="mj-secondary">
          The person running the print is always told about printer errors. Choose who else is notified and from which
          level on.
        </p>
        <ComboBox
          id="printer-notify-role"
          titleText="Also notify this role"
          placeholder="Only the operator of the running print"
          helperText={
            canReadRoles
              ? 'Leave empty to tell only the operator.'
              : 'Changing the role needs access to roles. The saved role is shown by name.'
          }
          items={choices}
          itemToString={(item: RoleChoice | null) => item?.name ?? ''}
          selectedItem={selected}
          disabled={!canManage || !canReadRoles}
          onChange={({ selectedItem }: { selectedItem?: RoleChoice | null }) => setRoleId(selectedItem?.id ?? null)}
        />
        <Dropdown
          id="printer-notify-severity"
          titleText="Notify from"
          label="Severity"
          helperText={severityHelp[severity]}
          items={severityChoices}
          itemToString={(item: SeverityChoice | null) => (item ? `${item.label}: ${severityHelp[item.id]}` : '')}
          selectedItem={severityChoices.find((choice) => choice.id === severity)}
          disabled={!canManage}
          onChange={({ selectedItem }: { selectedItem: SeverityChoice }) => setSeverity(selectedItem.id)}
        />
        <p className="mj-secondary">Print errors and codes without a level always notify.</p>
        {save.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Settings not saved"
            subtitle={
              save.error instanceof ApiError && save.error.status === 409
                ? 'Someone else changed the settings. Reload the page and try again.'
                : 'The settings could not be saved. Try again.'
            }
          />
        )}
        {canManage ? (
          <div className="recording-actions">
            <Button disabled={unchanged || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          <p className="mj-secondary">Changing these settings needs the permission to manage machines.</p>
        )}
      </div>
    </Tile>
  );
}

/** Who is told about printer errors besides the operator of the running print. */
export function PrinterNotificationsTab() {
  const query = useQuery(printerNotificationSettingsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The notification settings could not be loaded.">
      {query.data && <SettingsForm key={query.data.version} settings={query.data} />}
    </QueryBoundary>
  );
}
