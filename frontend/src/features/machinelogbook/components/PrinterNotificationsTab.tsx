import { useState } from 'react';
import { Button, Checkbox, InlineNotification, Select, SelectItem } from '@carbon/react';
import { Save } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { updatePrinterNotificationSettings } from '../../../api/generated/printing/printing';
import type {
  PrinterErrorSeverity,
  PrinterNotificationEvent,
  PrinterNotificationRule,
  PrinterNotificationRuleInput,
  PrinterNotificationSettings,
} from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { StackCard } from '../../../app/components/CardList';
import { FuzzySelectField, type SelectOption } from '../../../app/components/FuzzyComboBox';
import { fullRoleCatalogOptions } from '../../roles/queries';
import { machineLogbookKeys, printerNotificationSettingsQuery } from '../queries';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';

const events: { event: PrinterNotificationEvent; label: string; helper: string }[] = [
  { event: 'printer_error', label: 'Printer error', helper: 'HMS and print errors the connector reports.' },
  { event: 'run_finished', label: 'Run finished', helper: 'A recorded print ended, with its outcome.' },
  {
    event: 'filament_change',
    label: 'Filament change',
    helper: 'The material in a printer slot changed while a print runs.',
  },
];

const severityChoices: { id: PrinterErrorSeverity | ''; label: string }[] = [
  { id: '', label: 'Every level' },
  { id: 'info', label: 'Info and above' },
  { id: 'common', label: 'Common and above' },
  { id: 'serious', label: 'Serious and above' },
  { id: 'fatal', label: 'Fatal only' },
];

type Draft = Record<PrinterNotificationEvent, PrinterNotificationRuleInput>;

const blankRule = (event: PrinterNotificationEvent): PrinterNotificationRuleInput => ({
  event,
  notifyOperator: true,
  notifyRecipient: false,
  roleId: null,
  email: false,
  ...(event === 'printer_error' ? { minSeverity: null } : {}),
});

const toInput = (rule: PrinterNotificationRule): PrinterNotificationRuleInput => ({
  event: rule.event,
  notifyOperator: rule.notifyOperator,
  notifyRecipient: rule.notifyRecipient,
  roleId: rule.roleId,
  email: rule.email,
  ...(rule.event === 'printer_error' ? { minSeverity: rule.minSeverity } : {}),
});

function draftOf(settings: PrinterNotificationSettings): Draft {
  const byEvent = new Map(settings.events.map((rule) => [rule.event, toInput(rule)]));
  return Object.fromEntries(events.map(({ event }) => [event, byEvent.get(event) ?? blankRule(event)])) as Draft;
}

const sameRule = (a: PrinterNotificationRuleInput, b: PrinterNotificationRuleInput) =>
  a.notifyOperator === b.notifyOperator &&
  a.notifyRecipient === b.notifyRecipient &&
  a.roleId === b.roleId &&
  a.email === b.email &&
  (a.minSeverity ?? null) === (b.minSeverity ?? null);

function NotificationsForm({ settings }: { settings: PrinterNotificationSettings }) {
  const client = useQueryClient();
  const notify = useNotify();
  const can = useCan();
  const canManage = can('machines.manage');
  const canReadRoles = can('roles.read');
  const roles = useQuery({ ...fullRoleCatalogOptions, enabled: canReadRoles });
  const saved = draftOf(settings);
  const [draft, setDraft] = useState<Draft>(saved);
  const roleOptions: SelectOption[] = (roles.data ?? []).map((role) => ({ id: role.id, label: role.name }));
  // A saved role stays visible by name when the role catalog is unreadable or still loading.
  for (const rule of settings.events)
    if (rule.roleId && !roleOptions.some((option) => option.id === rule.roleId))
      roleOptions.push({ id: rule.roleId, label: rule.roleName ?? 'Current role' });
  const changed = events.filter(({ event }) => !sameRule(draft[event], saved[event]));
  const patch = (event: PrinterNotificationEvent, change: Partial<PrinterNotificationRuleInput>) =>
    setDraft((current) => ({ ...current, [event]: { ...current[event], ...change } }));
  const save = useMutation({
    mutationFn: () =>
      updatePrinterNotificationSettings({
        events: changed.map(({ event }) => draft[event]),
        expectedVersion: settings.version,
      }),
    onSuccess: async () => {
      notify({ kind: 'success', title: 'Printer notifications saved' });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.printerNotificationSettings() });
    },
  });

  return (
    <StackCard
      title="Printer notifications"
      className="printer-notifications"
      action={
        canManage ? (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Save}
            disabled={changed.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        ) : undefined
      }
    >
      <p className="mj-secondary">
        In-app messages for the people chosen here, right away; e-mail is an extra copy. People without a staff account
        only get the e-mail.
      </p>
      <div className="pn-list">
        {events.map(({ event, label, helper }) => {
          const rule = draft[event];
          const id = `pn-${event}`;
          return (
            <fieldset key={event} className="pn-event" aria-describedby={`${id}-helper`}>
              <legend className="pn-event__title">{label}</legend>
              <p id={`${id}-helper`} className="pn-event__helper">
                {helper}
              </p>
              <div className="pn-event__checks">
                <Checkbox
                  id={`${id}-operator`}
                  labelText="Operator of the print"
                  checked={rule.notifyOperator}
                  disabled={!canManage}
                  onChange={(_event, { checked }) => patch(event, { notifyOperator: checked })}
                />
                <Checkbox
                  id={`${id}-recipient`}
                  labelText="Job's recipient"
                  checked={rule.notifyRecipient}
                  disabled={!canManage}
                  onChange={(_event, { checked }) => patch(event, { notifyRecipient: checked })}
                />
                <Checkbox
                  id={`${id}-email`}
                  labelText="Also by e-mail"
                  checked={rule.email}
                  disabled={!canManage}
                  onChange={(_event, { checked }) => patch(event, { email: checked })}
                />
              </div>
              <FuzzySelectField
                id={`${id}-role`}
                titleText="And everyone with the role"
                placeholder="Nobody else"
                size="sm"
                options={roleOptions}
                value={rule.roleId}
                disabled={!canManage || !canReadRoles}
                helperText={canReadRoles ? undefined : 'Choosing a role needs access to roles.'}
                onChange={(roleId) => patch(event, { roleId })}
              />
              {event === 'printer_error' && (
                <Select
                  id={`${id}-severity`}
                  labelText="From severity"
                  size="sm"
                  helperText="Print errors and codes without a level are always announced."
                  value={rule.minSeverity ?? ''}
                  disabled={!canManage}
                  onChange={(change) =>
                    patch(event, { minSeverity: (change.target.value || null) as PrinterErrorSeverity | null })
                  }
                >
                  {severityChoices.map((choice) => (
                    <SelectItem key={choice.id} value={choice.id} text={choice.label} />
                  ))}
                </Select>
              )}
            </fieldset>
          );
        })}
      </div>
      {save.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Notifications not saved"
          subtitle={
            save.error instanceof ApiError && save.error.status === 409
              ? 'Someone else changed the settings. Reload the page and try again.'
              : 'The settings could not be saved. Try again.'
          }
        />
      )}
      {!canManage && <p className="mj-secondary">Changing who is notified needs the permission to manage machines.</p>}
    </StackCard>
  );
}

/** Who is told about printer errors, finished runs and filament changes, and whether by e-mail as well. */
export function PrinterNotificationsCard() {
  const query = useQuery(printerNotificationSettingsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The notification settings could not be loaded.">
      {query.data && <NotificationsForm key={query.data.version} settings={query.data} />}
    </QueryBoundary>
  );
}
