import { StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, Stack } from '@carbon/react';
import { mappingLabel, nozzleLabel, NOZZLE_GROUPS, type DraftUnit } from '../../printerSetup';
import { useStore } from '../../store';
import type { DetectedPrinterState, PrinterModel } from '../../types';
import type { SetupValues } from './wizardTypes';

const statusLabel = { active: 'Active', maintenance: 'Maintenance', retired: 'Retired' } as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <StructuredListRow><StructuredListCell noWrap>{label}</StructuredListCell><StructuredListCell>{children}</StructuredListCell></StructuredListRow>;
}

export function ReviewStep({ values, printer, model, units, detection, hasCode }: {
  values: SetupValues; printer: boolean; model: PrinterModel | undefined; units: DraftUnit[]; detection: DetectedPrinterState | null; hasCode: boolean;
}) {
  const store = useStore();
  const type = store.machineTypes.find((item) => item.id === values.machineTypeId);
  const host = store.connectorHosts.find((item) => item.id === values.connectorId);
  const connected = printer && values.connect === 'now';
  const live = values.adapterKind === 'bambu_h2d';

  return (
    <Stack gap={6}>
      <div>
        <h4 className="mj-group-title">Machine</h4>
        <StructuredListWrapper isCondensed aria-label="Machine summary">
          <StructuredListBody>
            <Row label="Name">{values.name.trim()}</Row>
            <Row label="Type">{type?.name ?? '—'}</Row>
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
              {!connected ? <Row label="Connector">Set up later</Row> : (
                <>
                  <Row label="Connector">{host?.name ?? '—'}</Row>
                  <Row label="Adapter">{live ? 'Bambu Lab H2D' : 'Simulator'}</Row>
                  {live && <Row label="IP address">{values.ipAddress.trim()}</Row>}
                  {live && <Row label="Serial number">{values.serialNumber.trim()}</Row>}
                  {live && <Row label="LAN access code">{values.accessCode || hasCode ? 'Set' : 'Not set'}</Row>}
                  {live && <Row label="Auto-mount RFID spools">{values.autoMountRfid ? 'On' : 'Off'}</Row>}
                  <Row label="Test">{detection ? 'Connected' : 'Not tested'}</Row>
                </>
              )}
            </StructuredListBody>
          </StructuredListWrapper>
        </div>
      )}
      {printer && (
        <div>
          <h4 className="mj-group-title">Spool inputs</h4>
          {units.length === 0 ? <p className="mj-secondary">No input units. The printer will not track mounted spools.</p> : (
            <StructuredListWrapper isCondensed aria-label="Spool inputs summary">
              <StructuredListBody>
                {NOZZLE_GROUPS.flatMap((group) => units.filter((unit) => unit.nozzle === group).map((unit) => (
                  <Row key={unit.key} label={`${unit.name}${model && model.nozzles > 1 ? ` · ${nozzleLabel(group)}` : ''}`}>
                    <Stack gap={1}>
                      {unit.slots.map((slot) => (
                        <span key={slot.key}>{slot.name} <span className="mj-secondary">→ {mappingLabel(detection, model?.id ?? null, slot.unitExt ?? unit.ext, slot.ext) ?? 'Not mapped'}</span></span>
                      ))}
                    </Stack>
                  </Row>
                )))}
              </StructuredListBody>
            </StructuredListWrapper>
          )}
        </div>
      )}
    </Stack>
  );
}
