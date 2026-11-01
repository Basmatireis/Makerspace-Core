import { describe, expect, it } from 'vitest';
import type { MachineRunEvent } from '../../../api/generated/models';
import { eventLines, eventSummary } from './runEvents';

const event = (overrides: Partial<MachineRunEvent>): MachineRunEvent => ({
  id: '0192f6f8-743e-7c77-a349-cd07c3e8d001',
  kind: 'operational_state',
  occurredAt: '2026-10-30T10:00:00Z',
  ...overrides,
});

describe('machine event summaries', () => {
  it('names the file when printing starts and tells paused and resumed apart', () => {
    expect(eventSummary(event({ state: 'printing', fileName: 'gear.3mf' })).text).toBe('Printing started · gear.3mf');
    expect(eventSummary(event({ state: 'paused' })).text).toBe('Paused');
    expect(eventSummary(event({ state: 'printing' }), 'paused').text).toBe('Resumed');
    expect(eventSummary(event({ state: 'heating_up' })).text).toBe('State: heating up');
    const lines = eventLines([
      event({ id: 'c', state: 'printing', occurredAt: '2026-10-30T10:20:00Z' }),
      event({ id: 'b', state: 'paused', occurredAt: '2026-10-30T10:10:00Z' }),
      event({ id: 'a', state: 'printing', fileName: 'gear.3mf' }),
    ]);
    expect(lines.map((item) => item.line.text)).toEqual(['Resumed', 'Paused', 'Printing started · gear.3mf']);
  });

  it('explains printer errors with meaning, severity and a link, and when they clear', () => {
    const appeared = eventSummary(
      event({
        kind: 'printer_error',
        transition: 'appeared',
        code: '07FF8003',
        severity: 'serious',
        title: 'Nozzle clogged',
        link: 'https://example.org/clog',
      }),
    );
    expect(appeared).toEqual({
      text: 'Printer error 07FF8003 (serious): Nozzle clogged',
      link: 'https://example.org/clog',
    });
    expect(
      eventSummary(event({ kind: 'printer_error', transition: 'appeared', code: 'X1', link: 'javascript:x' })),
    ).toEqual({ text: 'Printer error X1: no meaning recorded', link: null });
    expect(eventSummary(event({ kind: 'printer_error', transition: 'cleared', code: '07FF8003' })).text).toBe(
      'Printer error 07FF8003 cleared',
    );
  });

  it('describes filament changes, consumption and the outcome', () => {
    expect(eventSummary(event({ kind: 'filament_change', fromSlot: 'A', toSlot: 'B' })).text).toBe(
      'Filament changed: slot A → slot B',
    );
    expect(eventSummary(event({ kind: 'consumption_report', quantity: '177.000' })).text).toBe(
      'Consumption reported: 177 g',
    );
    expect(eventSummary(event({ kind: 'terminal_outcome', state: 'completed' })).text).toBe('Outcome: completed');
  });
});
