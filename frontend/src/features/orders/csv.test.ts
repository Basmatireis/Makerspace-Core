import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';
import { cashbookCsv } from './cashbookCsv';
import type { CashbookLine } from './logic';

describe('cashbook CSV', () => {
  it('starts with a byte order mark and has no sep line', () => {
    const csv = toCsv(['A', 'B'], [['x', 'y']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('A;B\r\nx;y\r\n');
    expect(csv).not.toContain('sep=');
  });
  it('separates with semicolons and writes decimal commas', () => {
    expect(csvCell(12.5)).toBe('12,5');
    expect(toCsv(['n'], [[12.5, 'a']]).slice(1)).toBe('n\r\n12,5;a\r\n');
  });
  it('quotes cells with a semicolon, quote or line break', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(null)).toBe('');
  });
  it('guards against spreadsheet formulas but keeps plain numbers', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('+1+2')).toBe("'+1+2");
    expect(csvCell('-5,00')).toBe('-5,00');
    expect(csvCell('-12.5')).toBe('-12.5');
  });
  it('exports payments and cash movements with decimal commas', () => {
    const lines = [
      {
        type: 'movement',
        id: 'm',
        at: '2026-10-19T08:00:00Z',
        reference: 'C-2026-000001',
        signed: -5000,
        method: 'cash',
        recordedBy: 'Sara',
        movement: { kind: 'withdrawal', reason: 'bank_deposit', note: '=bad', createdAt: '2026-10-19T08:00:00Z' },
      },
      {
        type: 'payment',
        id: 'p',
        at: '2026-10-19T09:00:00Z',
        reference: 'P-2026-000001',
        signed: 1250,
        method: 'card',
        recordedBy: 'Sara',
        orderReference: 'O-2026-000001',
        order: { id: 'o' },
        customerLabel: 'Ada; Lovelace',
        payment: {
          externalSource: 'Terminal 1',
          externalReference: 'T-1',
          reasonKind: null,
          reason: '',
          recordedAt: '2026-10-19T09:00:00Z',
          entryKind: 'receipt',
        },
      },
    ] as unknown as CashbookLine[];
    const rows = cashbookCsv(lines).slice(1).split('\r\n');
    expect(rows[1]).toContain('C-2026-000001;2026-10-19;10:00;');
    expect(rows[1]).toContain(';Cash withdrawal;Cash;-50,00;');
    expect(rows[1]).toContain("'=bad");
    expect(rows[2]).toContain(';Receipt;Card;12,50;O-2026-000001;"Ada; Lovelace";Terminal 1;T-1;');
  });
});
