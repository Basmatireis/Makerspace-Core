import { useEffect, useRef } from 'react';
import { Button, Checkbox, InlineLoading, InlineNotification, Link as CarbonLink, PasswordInput, RadioTile, Select, SelectItem, Stack, TextInput, TileGroup } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useWatch } from 'react-hook-form';
import { Link } from 'react-router-dom';
import type { PrinterConnector } from '../../../../api/generated/models';
import { connectorsQuery, type PrinterConnection } from '../../connectorQueries';
import { adapterLabel, describeDetection, isBambuAdapter, SERIAL_PATTERN, type PrinterModelInfo } from '../../printerSetup';
import { connectorDiagnostic, isIPv4Unicast } from '../../shared/connectorHelpers';
import { machineLogbookPaths } from '../../shared/paths';
import { QueryBoundary } from '../../shared/QueryBoundary';
import { useCan } from '../../shared/useCan';
import { connectionTestTiming, type TestState } from './useConnectionTest';
import type { SetupForm } from './wizardTypes';

export function ConnectionStep({ form, creating, model, connection, test, saveError, canSkipTest, onSkipTest, canRetest = false, onRetest, onNavigate }: {
  form: SetupForm; creating: boolean; model: PrinterModelInfo | undefined; connection: PrinterConnection | undefined; test: TestState; saveError: boolean;
  canSkipTest: boolean; onSkipTest: () => void; canRetest?: boolean; onRetest?: () => void; onNavigate: () => void;
}) {
  const can = useCan();
  const canManage = can('printer_connectors.manage');
  const { control, register, setValue, formState: { errors } } = form;
  const connect = useWatch({ control, name: 'connect' });
  const adapterKind = useWatch({ control, name: 'adapterKind' });
  const query = useQuery({ ...connectorsQuery(), enabled: canManage });
  const hosts = (query.data?.items ?? []).filter((host) => host.lifecycle === 'active' || host.id === connection?.connector.id);
  const live = isBambuAdapter(model?.adapterKind);
  // The LAN access code is write-only; an existing H2D assignment already has one, so only a new code is asked for.
  const hasCode = Boolean(connection) && connection?.assignment.adapterKind === adapterKind && isBambuAdapter(adapterKind);
  const needsLan = connect === 'now' && isBambuAdapter(adapterKind);
  const busy = test.phase === 'saving' || test.phase === 'config' || test.phase === 'status';

  // Without any active connector there is nothing to connect to now.
  const defaulted = useRef(false);
  useEffect(() => {
    if (!creating || !query.isSuccess || defaulted.current) return;
    defaulted.current = true;
    if (hosts.length === 0) setValue('connect', 'later');
    else if (!form.getValues('connectorId')) setValue('connectorId', hosts[0].id);
  }, [creating, query.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!canManage) {
    return (
      <InlineNotification
        kind="info" lowContrast hideCloseButton title="Connecting a printer needs the connector permission"
        subtitle={connection ? `This printer is connected through ${connection.connector.name}.` : 'Ask someone who may manage printer connectors to connect this printer, or continue without a connection.'}
      />
    );
  }

  return (
    <Stack gap={6}>
      {creating && (
        <Controller
          control={control} name="connect"
          render={({ field }) => (
            <TileGroup<string> legend="Connection" name="setup-connect" className="mj-tile-grid" valueSelected={field.value} onChange={(value) => field.onChange(value)}>
              <RadioTile id="setup-connect-now" value="now"><span className="mj-tile-title">Connect a connector now</span><span className="mj-secondary">Collect prints and read what is loaded automatically.</span></RadioTile>
              <RadioTile id="setup-connect-later" value="later"><span className="mj-tile-title">Set up later</span><span className="mj-secondary">Jobs are logged manually until a connector is attached.</span></RadioTile>
            </TileGroup>
          )}
        />
      )}
      {connect === 'now' && (
        <QueryBoundary query={query} errorMessage="The connectors could not be loaded.">
          <div>
            <Select
              id="setup-connector" labelText="Connector" invalid={Boolean(errors.connectorId)} invalidText={errors.connectorId?.message}
              helperText="The connector host that runs next to the printer."
              {...register('connectorId', { validate: (value, all) => all.connect === 'now' && !value ? 'Choose a connector.' : true })}
            >
              <SelectItem value="" text={hosts.length ? 'Choose a connector' : 'No active connector'} />
              {hosts.map((host: PrinterConnector) => <SelectItem key={host.id} value={host.id} text={host.locationLabel ? `${host.name} — ${host.locationLabel}` : host.name} />)}
            </Select>
            {hosts.length === 0 && (
              <p className="mj-secondary">No active connector yet. <CarbonLink as={Link} to={`${machineLogbookPaths.machines()}?tab=connectors`} onClick={onNavigate}>Add a connector</CarbonLink></p>
            )}
          </div>
          {live ? (
            <TextInput id="setup-adapter-live" labelText="Adapter" readOnly value={adapterLabel(adapterKind)} helperText="LAN, observes only, never sends print commands" />
          ) : model ? (
            <Select id="setup-adapter" labelText="Adapter" helperText={`No live adapter exists for ${model.label} yet. The simulator reports plausible sample data for testing.`} {...register('adapterKind')}>
              <SelectItem value="simulator" text="Simulator" />
            </Select>
          ) : (
            <Select id="setup-adapter" labelText="Adapter" {...register('adapterKind')}>
              <SelectItem value="simulator" text="Simulator" />
              <SelectItem value="bambu_h2d" text="Bambu Lab H2D" />
              <SelectItem value="bambu_x1c" text="Bambu Lab X1C" />
            </Select>
          )}
          {needsLan && (
            <>
              <TextInput
                id="setup-ip" labelText="Printer IPv4 address" placeholder="192.168.1.42" autoComplete="off" invalid={Boolean(errors.ipAddress)} invalidText="Enter an IPv4 unicast address."
                {...register('ipAddress', { validate: (value, all) => !(all.connect === 'now' && isBambuAdapter(all.adapterKind)) || isIPv4Unicast(value.trim()) })}
              />
              <TextInput
                id="setup-serial" labelText="Serial number" autoComplete="off" helperText="Shown on the printer under Settings › Device. Taken from the machine's external identifier when one is set." invalid={Boolean(errors.serialNumber)} invalidText="Use capital letters, digits, dash or underscore."
                {...register('serialNumber', {
                  validate: (value, all) => !(all.connect === 'now' && isBambuAdapter(all.adapterKind)) || SERIAL_PATTERN.test(value.trim()),
                  onChange: (event) => setValue('serialNumber', String(event.target.value).toUpperCase(), { shouldValidate: true, shouldDirty: true }),
                })}
              />
              <PasswordInput
                id="setup-code" labelText={hasCode ? 'New LAN access code (optional)' : 'LAN access code'} autoComplete="new-password"
                helperText={hasCode ? 'Leave blank to keep the current code' : 'Stored encrypted and never shown again after saving.'}
                invalid={Boolean(errors.accessCode)} invalidText="Enter the LAN access code."
                {...register('accessCode', { validate: (value, all) => !(all.connect === 'now' && isBambuAdapter(all.adapterKind)) || hasCode || Boolean(value) })}
              />
              <Controller
                control={control} name="autoMountRfid"
                render={({ field }) => (
                  <Checkbox
                    id="setup-rfid" labelText="Automatically mount spools identified by Bambu RFID" helperText="Only existing spools with a matching NFC tag are mounted. Manual mounts are never replaced."
                    checked={field.value} onChange={(_event, { checked }) => field.onChange(checked)}
                  />
                )}
              />
            </>
          )}
          <Stack gap={4}>
            {busy && (
              <InlineLoading
                status="active"
                description={test.phase === 'saving' ? 'Saving the connection…' : test.phase === 'config' ? `Waiting for ${test.connectorName} to pick up the configuration…` : 'Contacting the printer…'}
              />
            )}
            {busy && test.errorCode && (
              <InlineNotification kind="warning" lowContrast hideCloseButton title="The connector reports a problem" subtitle={`${connectorDiagnostic(test.errorCode)} (${test.errorCode})`} />
            )}
            {test.phase === 'success' && test.live && <InlineNotification kind="success" lowContrast hideCloseButton title="Connected" subtitle={describeDetection(test.live.status)} />}
            {test.phase === 'timeout' && (
              <InlineNotification
                kind="warning" lowContrast hideCloseButton title="No status received yet"
                subtitle={`${test.errorCode ? `${connectorDiagnostic(test.errorCode)} (${test.errorCode}) ` : ''}${test.connectorName} did not report within ${Math.round(connectionTestTiming.timeoutMs / 1000)} seconds. Check that the connector is running and can reach the printer. The connection is saved and keeps retrying.`}
              />
            )}
            {(test.phase === 'failed' || saveError) && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Connection not saved" subtitle="Check the values. The machine needs an enabled printer profile and no other active connector assignment. If someone else changed the connection, close the dialog and reopen it." />
            )}
            {test.phase === 'idle' && !saveError && <InlineNotification kind="warning" lowContrast hideCloseButton title="Connection not tested" subtitle="Save and test the connection to see what is loaded in each slot. You can also continue without testing." />}
            {(canSkipTest || (canRetest && onRetest)) && (
              <div className="mj-inline">
                {canRetest && onRetest && <Button kind="tertiary" size="sm" onClick={onRetest}>Test again</Button>}
                {canSkipTest && <Button kind="ghost" size="sm" onClick={onSkipTest}>Continue without waiting</Button>}
              </div>
            )}
          </Stack>
        </QueryBoundary>
      )}
    </Stack>
  );
}
