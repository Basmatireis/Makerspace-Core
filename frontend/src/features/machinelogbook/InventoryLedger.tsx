import { Link as CarbonLink, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tile } from '@carbon/react';
import { Link } from 'react-router-dom';
import type { InventoryTransaction } from '../../api/generated/models';
import { formatDateTime, formatDecimal, formatMoney } from './formatting';
import { useInventoryLayout } from './useInventoryLayout';

export function InventoryLedger({ items, unit, canReadJobs }: { items: InventoryTransaction[]; unit: string; canReadJobs: boolean }) {
  const { isPhone } = useInventoryLayout();
  const job = (item: InventoryTransaction) => item.machineJobId && canReadJobs
    ? <CarbonLink as={Link} to={`/machine-logbook/jobs/${item.machineJobId}`}>{item.machineJobDisplayId ?? 'View job'}</CarbonLink>
    : item.machineJobDisplayId ?? '—';
  if (!items.length) return <p>No transactions recorded.</p>;
  if (isPhone) return <div className="inventory-ledger-cards">{items.map((item) => <Tile key={item.id}>
    <h3>{item.kind.replaceAll('_', ' ')}</h3><p>{formatDateTime(item.occurredAt)}</p>
    <dl><div><dt>Quantity</dt><dd>{formatDecimal(item.quantityDelta, 3)} {unit}</dd></div><div><dt>Inventory value</dt><dd>{formatMoney(item.inventoryValueDelta)}</dd></div><div><dt>Unit cost</dt><dd>{formatMoney(item.unitAcquisitionCost)}</dd></div><div><dt>Job</dt><dd>{job(item)}</dd></div></dl>
    {item.supplier && <p>Supplier: {item.supplier}</p>}{item.adjustmentReason && <p>Reason: {item.adjustmentReason.replaceAll('_', ' ')}</p>}{item.note && <p>{item.note}</p>}
  </Tile>)}</div>;
  return <div className="inventory-ledger-table"><Table aria-label="Inventory transactions"><TableHead><TableRow>{['Recorded at', 'Transaction', 'Quantity', 'Unit cost', 'Value change', 'Job', 'Details'].map((name) => <TableHeader key={name}>{name}</TableHeader>)}</TableRow></TableHead><TableBody>{items.map((item) => <TableRow key={item.id}><TableCell>{formatDateTime(item.occurredAt)}</TableCell><TableCell>{item.kind.replaceAll('_', ' ')}</TableCell><TableCell>{formatDecimal(item.quantityDelta, 3)} {unit}</TableCell><TableCell>{formatMoney(item.unitAcquisitionCost)}</TableCell><TableCell>{formatMoney(item.inventoryValueDelta)}</TableCell><TableCell>{job(item)}</TableCell><TableCell>{[item.supplier, item.adjustmentReason?.replaceAll('_', ' '), item.note].filter(Boolean).join(' · ') || '—'}</TableCell></TableRow>)}</TableBody></Table></div>;
}
