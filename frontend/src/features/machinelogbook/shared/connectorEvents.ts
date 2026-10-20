import type { PrinterConnectorEvent } from '../../../api/generated/models';
import { connectorDiagnostic } from './connectorHelpers';

type Payload = Record<string, unknown>;

const text = (payload: Payload, key: string) => {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : null;
};
const isZeroIdentifier = (value: string | null) => !value || /^0+$/.test(value);
const slotName = (payload: Payload) =>
  text(payload, 'slotExternalId') ?? text(payload, 'externalSlotKey') ?? 'unknown slot';

/** One readable line per connector event, built from the normalized payload the connector reports. */
export function describeConnectorEvent(event: PrinterConnectorEvent): string {
  const payload = (event.payload ?? {}) as Payload;
  switch (event.kind) {
    case 'connectivity': {
      const state = text(payload, 'state');
      const code = text(payload, 'errorCode');
      if (state === 'online') return 'Printer connected';
      const prefix = state === 'offline' ? 'Printer offline' : 'Connection degraded';
      return code ? `${prefix}: ${connectorDiagnostic(code)}` : prefix;
    }
    case 'operational_state': {
      const file = text(payload, 'fileName');
      return `Printer is ${text(payload, 'state') ?? 'in an unknown state'}${file ? ` · ${file}` : ''}`;
    }
    case 'progress': {
      const percent = text(payload, 'percent');
      const layer = text(payload, 'layer');
      const total = text(payload, 'totalLayers');
      return `${text(payload, 'fileName') ?? 'Print'} at ${percent ?? '?'} %${layer && total ? ` · layer ${layer} of ${total}` : ''}`;
    }
    case 'slot_observation': {
      if (payload.empty === true) return `Slot ${slotName(payload)} is empty`;
      const material = text(payload, 'productName') ?? text(payload, 'trayType') ?? 'unknown material';
      return `Slot ${slotName(payload)}: ${material}${isZeroIdentifier(text(payload, 'tagUid')) ? '' : ' (RFID)'}`;
    }
    case 'terminal_outcome':
      return `Print ended: ${text(payload, 'outcome') ?? 'unknown'}`;
    case 'printer_error': {
      const family = (text(payload, 'sourceFamily') ?? 'printer').toUpperCase();
      const code = text(payload, 'code') ?? 'unknown code';
      return text(payload, 'transition') === 'cleared' ? `${family} ${code} cleared` : `${family} ${code} reported`;
    }
    case 'filament_change':
      return `Switched from slot ${text(payload, 'fromSlotExternalId') ?? '?'} to ${text(payload, 'toSlotExternalId') ?? '?'}`;
    case 'consumption_report': {
      const items = Array.isArray(payload.items) ? payload.items.length : 0;
      const grams = text(payload, 'quantityGrams');
      return items > 0
        ? `Material use reported for ${items} slot${items === 1 ? '' : 's'}`
        : grams
          ? `${grams} g material use reported`
          : 'Material use reported';
    }
    case 'identity':
      return 'Printer identified';
    default:
      return 'Event received';
  }
}

export type EventGroup = {
  id: string;
  summary: string;
  count: number;
  newest: PrinterConnectorEvent;
  oldest: PrinterConnectorEvent;
};

/** Collapses consecutive events (newest first) that say the same thing, e.g. a printer reported offline every minute. */
export function groupConnectorEvents(events: PrinterConnectorEvent[]): EventGroup[] {
  const sorted = [...events].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const groups: EventGroup[] = [];
  for (const event of sorted) {
    const summary = describeConnectorEvent(event);
    const last = groups[groups.length - 1];
    if (
      last &&
      last.summary === summary &&
      last.newest.kind === event.kind &&
      last.newest.applicationState === event.applicationState
    ) {
      last.count += 1;
      last.oldest = event;
    } else {
      groups.push({ id: event.id, summary, count: 1, newest: event, oldest: event });
    }
  }
  return groups;
}
