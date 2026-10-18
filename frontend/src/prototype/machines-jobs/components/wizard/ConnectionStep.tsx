import { Button, Checkbox, InlineLoading, InlineNotification, Link as CarbonLink, PasswordInput, RadioTile, Select, SelectItem, Stack, TextInput, TileGroup } from '@carbon/react';
import { Controller } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { describeDetection, isIPv4, SERIAL_PATTERN } from '../../printerSetup';
import { useStore } from '../../store';
import type { DetectedPrinterState, PrinterModel } from '../../types';
import type { SetupForm, TestState, WizardMachine } from './wizardTypes';

const ERRORS = {
  unreachable: { title: 'Printer unreachable', subtitle: 'Check the IP address and that LAN only mode is on at the printer. The connector and the printer must be on the same network.' },
  wrong_code: { title: 'LAN access code rejected', subtitle: 'Re-enter the access code shown on the printer screen under network settings.' },
} as const;

export function ConnectionStep({ form, machine, model, test, detection, onTest, onNavigate }: {
  form: SetupForm; machine: WizardMachine; model: PrinterModel | undefined; test: TestState; detection: DetectedPrinterState | null; onTest: () => void; onNavigate: () => void;
}) {
  const store = useStore();
  const { control, register, setValue, watch, formState: { errors } } = form;
  const connect = watch('connect');
  const adapterKind = watch('adapterKind');
  const hosts = store.connectorHosts.filter((host) => host.lifecycle === 'active' || host.id === machine?.connection?.connectorId);
  const live = model?.adapterKind === 'bambu_h2d';
  const hasCode = Boolean(machine?.connection?.accessCodeSet) && adapterKind === 'bambu_h2d';
  const needsLan = connect === 'now' && adapterKind === 'bambu_h2d';

  return (
    <Stack gap={6}>
      <Controller
        control={control} name="connect"
        render={({ field }) => (
          <TileGroup<string> legend="Connection" name="setup-connect" className="mj-tile-grid" valueSelected={field.value} onChange={(value) => field.onChange(value)}>
            <RadioTile id="setup-connect-now" value="now"><span className="mj-tile-title">Connect a connector now</span><span className="mj-secondary">Collect runs and read what is loaded automatically.</span></RadioTile>
            <RadioTile id="setup-connect-later" value="later"><span className="mj-tile-title">Set up later</span><span className="mj-secondary">Jobs are logged manually until a connector is attached.</span></RadioTile>
          </TileGroup>
        )}
      />
      {connect === 'now' && (
        <>
          <div>
            <Select
              id="setup-connector" labelText="Connector" invalid={Boolean(errors.connectorId)} invalidText={errors.connectorId?.message}
              helperText="The connector host that runs next to the printer."
              {...register('connectorId', { validate: (value, all) => all.connect === 'now' && !value ? 'Choose a connector.' : true })}
            >
              <SelectItem value="" text={hosts.length ? 'Choose a connector' : 'No active connector'} />
              {hosts.map((host) => <SelectItem key={host.id} value={host.id} text={host.locationLabel ? `${host.name} — ${host.locationLabel}` : host.name} />)}
            </Select>
            {hosts.length === 0 && (
              <p className="mj-secondary">No active connector yet. <CarbonLink as={Link} to="/machines?tab=connectors" onClick={onNavigate}>Add a connector</CarbonLink></p>
            )}
          </div>
          {live ? (
            <TextInput id="setup-adapter-live" labelText="Adapter" readOnly value="Bambu Lab H2D" helperText="LAN, observes only, never sends print commands" />
          ) : (
            <Select id="setup-adapter" labelText="Adapter" helperText={`No live adapter exists for ${model?.label ?? 'this model'} yet. The simulator reports the model's template for testing.`} {...register('adapterKind')}>
              <SelectItem value="simulator" text="Simulator" />
            </Select>
          )}
          {needsLan && (
            <>
              <TextInput
                id="setup-ip" labelText="Printer IPv4 address" placeholder="192.168.1.42" autoComplete="off" invalid={Boolean(errors.ipAddress)} invalidText="Enter an IPv4 unicast address."
                {...register('ipAddress', { validate: (value, all) => !(all.connect === 'now' && all.adapterKind === 'bambu_h2d') || isIPv4(value) })}
              />
              <TextInput
                id="setup-serial" labelText="Serial number" autoComplete="off" helperText="Shown on the printer under Settings › Device." invalid={Boolean(errors.serialNumber)} invalidText="Use capital letters, digits, dash or underscore."
                {...register('serialNumber', {
                  validate: (value, all) => !(all.connect === 'now' && all.adapterKind === 'bambu_h2d') || SERIAL_PATTERN.test(value.trim()),
                  onChange: (event) => setValue('serialNumber', String(event.target.value).toUpperCase(), { shouldValidate: true }),
                })}
              />
              <PasswordInput
                id="setup-code" labelText={hasCode ? 'New LAN access code (optional)' : 'LAN access code'} autoComplete="new-password"
                helperText={hasCode ? 'Leave blank to keep the current code' : 'Stored encrypted and never shown again after saving.'}
                invalid={Boolean(errors.accessCode)} invalidText="Enter the LAN access code."
                {...register('accessCode', { validate: (value, all) => !(all.connect === 'now' && all.adapterKind === 'bambu_h2d') || hasCode || Boolean(value) })}
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
            <div className="mj-toolbar">
              <Button kind="tertiary" size="md" disabled={test.status === 'testing' || (hosts.length === 0 && !watch('connectorId'))} onClick={onTest}>Test connection</Button>
              {test.status === 'testing' && <InlineLoading description="Contacting the printer…" status="active" />}
            </div>
            {test.status === 'success' && detection && (
              <InlineNotification kind="success" lowContrast hideCloseButton title="Connected" subtitle={describeDetection(detection)} />
            )}
            {test.status === 'error' && test.error && <InlineNotification kind="error" lowContrast hideCloseButton {...ERRORS[test.error]} />}
            {test.status !== 'success' && test.status !== 'testing' && !detection && (
              <InlineNotification kind="warning" lowContrast hideCloseButton title="Connection not tested" subtitle="You can continue, but slot mapping will use the model template only." />
            )}
          </Stack>
        </>
      )}
    </Stack>
  );
}
