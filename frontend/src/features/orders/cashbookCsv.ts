import { dateInAppTimeZone, timeInAppTimeZone } from '../../app/dateTime';
import { toCsv } from './csv';
import { cashbookKindOptions, cashMovementReasonLabel, methodLabel, reasonKindLabel } from './labels';
import { lineKindId, type CashbookLine } from './logic';
import { fromCents } from './money';

const kindLabel = (line: CashbookLine) => cashbookKindOptions.find((option) => option.id === lineKindId(line))?.label ?? '';
const decimal = (cents: number) => fromCents(cents).replace('.', ',');

/** The cashbook as a spreadsheet file, cash movements included: semicolons and decimal commas so German and Austrian spreadsheets open it in columns. */
export function cashbookCsv(lines: CashbookLine[]) {
  const rows = lines.map((line) => line.type === 'movement'
    ? [line.reference, dateInAppTimeZone(line.at), timeInAppTimeZone(line.at), kindLabel(line), methodLabel('cash'), decimal(line.signed), '', '', '', '', cashMovementReasonLabel[line.movement.reason], line.movement.note, line.recordedBy, dateInAppTimeZone(line.movement.createdAt)]
    : [
      line.reference, dateInAppTimeZone(line.at), timeInAppTimeZone(line.at), kindLabel(line), methodLabel(line.method), decimal(line.signed),
      line.orderReference ?? '', line.order ? line.customerLabel : '', line.payment.externalSource, line.payment.externalReference,
      line.payment.reasonKind ? reasonKindLabel(line.payment.reasonKind) : '', line.payment.reason, line.recordedBy, dateInAppTimeZone(line.payment.recordedAt),
    ]);
  return toCsv(['Entry', 'Date', 'Time', 'Kind', 'Method', 'Amount EUR', 'Order', 'Customer', 'Terminal', 'Transaction reference', 'Reason kind', 'Reason or note', 'Recorded by', 'Recorded on'], rows);
}
