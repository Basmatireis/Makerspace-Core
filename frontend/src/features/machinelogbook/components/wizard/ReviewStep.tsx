import type { ReactNode } from 'react';
import { Stack, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import {
  adapterLabel,
  isBambuAdapter,
  mappingLabel,
  nozzleLabel,
  NOZZLE_GROUPS,
  type Detection,
  type DraftUnit,
  type PrinterModelInfo,
} from '../../printerSetup';
import type { SetupValues } from './wizardTypes';

const statusLabel = { active: 'Active', maintenance: 'Maintenance', retired: 'Retired' } as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <StructuredListRow>
      <StructuredListCell noWrap>{label}</StructuredListCell>
      <StructuredListCell>{children}</StructuredListCell>
    </StructuredListRow>
  );
}

/** The saved result: everything shown here is already stored, "Done" only closes the dialog. */
export function ReviewStep({
  values,
  typeName,
  printer,
  model,
  units,
  detection,
  connectorName,
  connected,
  hasCode,
}: {
  values: SetupValues;
  typeName: string;
  printer: boolean;
  model: PrinterModelInfo | undefined;
  units: DraftUnit[];
  detection: Detection;
  /** Name of the connector the printer is assigned to, null when set up later. */
  connectorName: string | null;
  connected: boolean;
  hasCode: boolean;
}) {
  const live = isBambuAdapter(values.adapterKind);
  return (
    <Stack gap={6}>
      <div>
        <h4 className="mj-group-title">Machine</h4>
        <StructuredListWrapper isCondensed aria-label="Machine summary">
          <StructuredListBody>
            <Row label="Name">{values.name.trim()}</Row>
            <Row label="Type">{typeName}</Row>
            <Row label="Status">{statusLabel[values.status]}</Row>
            {printer && <Row label="Model">{model?.label ?? '—'}</Row>}
          </StructuredListBody>
        </StructuredListWrapper>
      </div>
      {printer && (
        <div>
          <h4 className="mj-group-title">Connection</h4>
          <StructuredListWrapper isCondensed aria-label="Connection summary">
            <StructuredListBody>
              {!connectorName ? (
                <Row label="Connector">Set up later</Row>
              ) : (
                <>
                  <Row label="Connector">{connectorName}</Row>
                  <Row label="Adapter">{adapterLabel(values.adapterKind)}</Row>
                  {live && <Row label="IP address">{values.ipAddress.trim()}</Row>}
                  {live && <Row label="Serial number">{values.serialNumber.trim()}</Row>}
                  {live && <Row label="LAN access code">{values.accessCode || hasCode ? 'Set' : 'Not set'}</Row>}
                  {live && <Row label="Auto-mount RFID spools">{values.autoMountRfid ? 'On' : 'Off'}</Row>}
                  {live && <Row label="Stream camera">{values.cameraStreaming ? 'On' : 'Off'}</Row>}
                  <Row label="Test">{connected ? 'Connected' : 'Not confirmed yet'}</Row>
                </>
              )}
            </StructuredListBody>
          </StructuredListWrapper>
        </div>
      )}
      {printer && (
        <div>
          <h4 className="mj-group-title">Spool inputs</h4>
          {units.length === 0 ? (
            <p className="mj-secondary">No input units. The printer will not track mounted spools.</p>
          ) : (
            <StructuredListWrapper isCondensed aria-label="Spool inputs summary">
              <StructuredListBody>
                {NOZZLE_GROUPS.flatMap((group) =>
                  units
                    .filter((unit) => unit.nozzle === group)
                    .map((unit) => (
                      <Row
                        key={unit.key}
                        label={`${unit.name}${model && model.nozzles > 1 ? ` · ${nozzleLabel(group)}` : ''}`}
                      >
                        <Stack gap={1}>
                          {unit.slots.map((slot) => (
                            <span key={slot.key}>
                              {slot.name}{' '}
                              <span className="mj-secondary">
                                →{' '}
                                {mappingLabel(detection, model?.id ?? null, slot.unitExt ?? unit.ext, slot.ext) ??
                                  'Not mapped'}
                              </span>
                            </span>
                          ))}
                        </Stack>
                      </Row>
                    )),
                )}
              </StructuredListBody>
            </StructuredListWrapper>
          )}
        </div>
      )}
    </Stack>
  );
}
