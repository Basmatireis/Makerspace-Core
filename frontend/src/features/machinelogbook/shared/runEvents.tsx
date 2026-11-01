import type { MachineRunEvent } from '../../../api/generated/models';
import { safeLink } from '../printerErrors/printerErrorText';
import { formatQuantity } from './format';

const words = (value: string) => value.replace(/_/g, ' ');

export type RunEventLine = { text: string; link: string | null };

/**
 * One readable line per machine event (never the raw payload). `previousState` is the operational state reported
 * before this event, which tells a resumed print from a started one.
 */
export function eventSummary(event: MachineRunEvent, previousState?: string | null): RunEventLine {
  const plain = (text: string): RunEventLine => ({ text, link: null });
  switch (event.kind) {
    case 'identity':
      return plain('Machine identified');
    case 'connectivity':
      return plain(event.state ? `Connectivity: ${words(event.state)}` : 'Connectivity changed');
    case 'operational_state': {
      if (!event.state) return plain('State changed');
      if (event.state === 'printing') {
        if (previousState === 'paused') return plain('Resumed');
        return plain(event.fileName ? `Printing started · ${event.fileName}` : 'Printing started');
      }
      if (event.state === 'paused') return plain('Paused');
      return plain(`State: ${words(event.state)}`);
    }
    case 'progress':
      return plain(event.progressPercent != null ? `Progress ${event.progressPercent} %` : 'Progress reported');
    case 'slot_observation':
      return plain('Material slot observed');
    case 'consumption_report':
      return plain(
        event.quantity != null ? `Consumption reported: ${formatQuantity(event.quantity)} g` : 'Consumption reported',
      );
    case 'terminal_outcome':
      return plain(event.state ? `Outcome: ${words(event.state)}` : 'Outcome reported');
    case 'printer_error': {
      const code = event.code ?? 'unknown code';
      if (event.transition === 'cleared') return plain(`Printer error ${code} cleared`);
      const severity = event.severity ? ` (${event.severity})` : '';
      return {
        text: `Printer error ${code}${severity}: ${event.title ?? 'no meaning recorded'}`,
        link: safeLink(event.link),
      };
    }
    case 'filament_change':
      return plain(
        event.fromSlot && event.toSlot
          ? `Filament changed: slot ${event.fromSlot} → slot ${event.toSlot}`
          : 'Filament changed',
      );
  }
}

/** Summaries of a run's events in the order given; the state before each event is found chronologically. */
export function eventLines(events: MachineRunEvent[]): { event: MachineRunEvent; line: RunEventLine }[] {
  const previous = new Map<string, string | null>();
  let state: string | null = null;
  for (const event of [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    previous.set(event.id, state);
    if (event.kind === 'operational_state' && event.state) state = event.state;
  }
  return events.map((event) => ({ event, line: eventSummary(event, previous.get(event.id)) }));
}
