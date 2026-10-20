import { describe, expect, it } from 'vitest';
import type { PrinterConnectorEvent } from '../../../api/generated/models';
import { describeConnectorEvent, groupConnectorEvents } from './connectorEvents';

const event = (id: string, receivedAt: string, kind: PrinterConnectorEvent['kind'], payload: Record<string, unknown>) =>
  ({
    id,
    receivedAt,
    kind,
    payload,
    applicationState: 'applied',
    applicationReason: null,
  }) as unknown as PrinterConnectorEvent;

describe('connector event descriptions', () => {
  it('describes real connectivity and slot payloads', () => {
    expect(describeConnectorEvent(event('1', '2026-10-14T10:00:00Z', 'connectivity', { state: 'online' }))).toBe(
      'Printer connected',
    );
    expect(
      describeConnectorEvent(
        event('2', '2026-10-14T10:00:00Z', 'connectivity', { state: 'offline', errorCode: 'mqtt_unavailable' }),
      ),
    ).toMatch(/^Printer offline: /);
    expect(
      describeConnectorEvent(
        event('3', '2026-10-14T10:00:00Z', 'slot_observation', {
          slotExternalId: '128:0',
          productName: 'PLA Basic',
          tagUid: 'E2C92C2900000100',
        }),
      ),
    ).toBe('Slot 128:0: PLA Basic (RFID)');
    expect(
      describeConnectorEvent(
        event('4', '2026-10-14T10:00:00Z', 'slot_observation', {
          slotExternalId: '0:1',
          trayType: 'PLA',
          tagUid: '0000000000000000',
        }),
      ),
    ).toBe('Slot 0:1: PLA');
  });

  it('collapses consecutive repeats newest first', () => {
    const groups = groupConnectorEvents([
      event('a', '2026-10-14T10:00:00Z', 'connectivity', { state: 'offline', errorCode: 'mqtt_unavailable' }),
      event('b', '2026-10-14T10:02:00Z', 'connectivity', { state: 'offline', errorCode: 'mqtt_unavailable' }),
      event('c', '2026-10-14T10:03:00Z', 'connectivity', { state: 'online' }),
      event('d', '2026-10-14T10:04:00Z', 'connectivity', { state: 'offline', errorCode: 'mqtt_unavailable' }),
    ]);
    expect(groups.map((group) => [group.newest.id, group.count])).toEqual([
      ['d', 1],
      ['c', 1],
      ['b', 2],
    ]);
    expect(groups[2].oldest.id).toBe('a');
  });
});
