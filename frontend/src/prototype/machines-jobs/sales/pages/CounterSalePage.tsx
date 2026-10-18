import { useMemo, useState } from 'react';
import {
  Button, ComboBox, ContentSwitcher, IconButton, InlineNotification, RadioTile, Select, SelectItem, Stack, Switch, Tag, TextArea, TextInput, Tile, TileGroup,
} from '@carbon/react';
import { Add, CheckmarkFilled, TrashCan } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { adjustPrice, formatDuration, formatTime, nameFromFile, printEnd } from '../../derived';
import { matchesName } from '../../dialogs/jobFormHelpers';
import { lookups, useStore } from '../../store';
import type { PriceAdjustmentKind, Print } from '../../types';
import { blankLine, lineState, MaterialLines, unitOf, type MaterialLine } from '../components/CounterMaterials';
import { checkEntry, existingReferences, newPaymentEntry, PaymentEntryForm, toPaymentInputs, type PaymentEntryState } from '../components/PaymentEntry';
import { ReceiptPreview, type ReceiptChange } from '../components/Receipt';
import { RequirePermission } from '../components/RequirePermission';
import { formatEur, formatQuantity, parseMoney, parseQuantity, round2 } from '../format';
import { activeReceipts, buildOrderViews } from '../logic';
import { catalogItems, defaultPricingGroup, pricingGroups, quoteJob } from '../pricing';
import { ProposedTag } from '../status';
import { useSalesMutation } from '../useSalesMutation';
import '../sales.scss';

type Extra = { key: string; kind: 'catalog' | 'custom'; catalogItemId: string; description: string; quantity: string; unit: string; unitPrice: string };
type Done = { orderId: string; change: ReceiptChange };
const PRESETS = [{ label: '15 min', minutes: 15 }, { label: '30 min', minutes: 30 }, { label: '1 h', minutes: 60 }, { label: 'Custom', minutes: 0 }];
const ADJUSTMENTS: { kind: PriceAdjustmentKind | 'none'; label: string }[] = [{ kind: 'none', label: 'No adjustment' }, { kind: 'discount_percent', label: 'Discount (%)' }, { kind: 'discount_amount', label: 'Discount (€)' }, { kind: 'fixed', label: 'Fixed price' }];

let extraCounter = 0;
const newExtra = (kind: Extra['kind']): Extra => ({ key: `ex-${++extraCounter}`, kind, catalogItemId: '', description: '', quantity: '1', unit: 'piece', unitPrice: '' });

/** Candidate runs: finished, not assigned to a job, ended within the last day. */
const recentRuns = (prints: Print[], now: number) => prints.filter((run) => run.state === 'finished' && run.linkedJobId === null && run.endedAt && now - new Date(run.endedAt).getTime() < 24 * 3_600_000)
  .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));

function CounterSale() {
  const store = useStore();
  const me = lookups.operators[0];
  const [source, setSource] = useState<'run' | 'manual'>('run');
  const [runId, setRunId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [preset, setPreset] = useState(1);
  const [custom, setCustom] = useState('');
  const [operator, setOperator] = useState(me);
  const [lines, setLines] = useState<MaterialLine[]>([blankLine()]);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [group, setGroup] = useState(defaultPricingGroup);
  const [adjustKind, setAdjustKind] = useState<PriceAdjustmentKind | 'none'>('none');
  const [adjustValue, setAdjustValue] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [free, setFree] = useState(false);
  const [freeReason, setFreeReason] = useState('');
  const [entry, setEntry] = useState<PaymentEntryState>(() => newPaymentEntry(0));
  const [done, setDone] = useState<Done | null>(null);
  const runs = useMemo(() => recentRuns(store.prints, Date.now()), [store.prints]);
  const run = source === 'run' ? runs.find((item) => item.id === runId) : undefined;
  const canOverride = store.can('machine_jobs.override_price');

  const machines = store.machines.filter((machine) => machine.status === 'active');
  const machine = store.machines.find((item) => item.id === (run?.machineId ?? machineId));
  const minutes = run ? Math.max(1, Math.round(((new Date(printEnd(run) ?? run.startedAt).getTime() - new Date(run.startedAt).getTime()) / 60_000))) : PRESETS[preset].minutes || parseQuantity(custom) || 0;

  // Live price ------------------------------------------------------------------------------------------------------------
  const usageInputs = lines.filter((line) => lineState(line) === 'valid').map((line) => ({
    ownership: line.ownership, materialId: line.ownership === 'makerspace' ? line.materialId : null, spoolId: line.ownership === 'makerspace' ? line.spoolId || null : null,
    materialName: line.ownership === 'external' ? line.externalName.trim() : store.materials.find((item) => item.id === line.materialId)?.name ?? '', quantity: parseQuantity(line.quantity)!, quantityBasis: 'actual' as const,
    unit: unitOf(line, store.materials),
  }));
  const quote = quoteJob({ group, durationSeconds: minutes * 60, usages: usageInputs.map((usage) => ({ materialName: usage.materialName, unit: usage.unit, quantity: usage.quantity, ownership: usage.ownership })) });
  const adjustNumber = parseMoney(adjustValue.replace('%', ''));
  const adjustment = free ? { kind: 'fixed' as const, value: 0, reason: freeReason.trim() }
    : canOverride && adjustKind !== 'none' && adjustNumber !== null ? { kind: adjustKind, value: adjustNumber, reason: adjustReason.trim() } : null;
  const jobAmount = adjustPrice(quote.total, adjustment) ?? 0;
  const extraRows = extras.map((extra) => {
    const item = catalogItems.find((candidate) => candidate.id === extra.catalogItemId);
    const quantity = parseQuantity(extra.quantity);
    const unitPrice = extra.kind === 'catalog' ? item?.unitPrice ?? null : parseMoney(extra.unitPrice);
    const description = extra.kind === 'catalog' ? item?.name ?? '' : extra.description.trim();
    const valid = description !== '' && quantity !== null && quantity > 0 && unitPrice !== null;
    return { extra, valid, description, quantity: quantity ?? 0, unit: extra.kind === 'catalog' ? item?.unit ?? 'piece' : extra.unit.trim() || 'piece', unitPrice: unitPrice ?? 0, amount: valid ? round2(quantity! * unitPrice!) : 0 };
  });
  const extrasAmount = free ? 0 : round2(extraRows.reduce((sum, row) => sum + row.amount, 0));
  const total = round2(jobAmount + extrasAmount);

  // Re-create the payment form whenever the amount due changes, so the prefilled amount stays right.
  const [entryDue, setEntryDue] = useState(0);
  if (entryDue !== total) { setEntryDue(total); setEntry(newPaymentEntry(total)); }
  const payCheck = checkEntry(entry, total, true, existingReferences(store.payments));

  // Validity ---------------------------------------------------------------------------------------------------------------
  const problems: string[] = [];
  if (source === 'run' && !run) problems.push('Choose a run, or switch to Manual.');
  if (source === 'manual' && !machineId) problems.push('Choose the machine.');
  if (source === 'manual' && !(minutes > 0)) problems.push('Enter how long the machine ran.');
  if (lines.some((line) => lineState(line) === 'invalid')) problems.push('Finish or remove the incomplete material.');
  if (extraRows.some((row) => !row.valid)) problems.push('Finish or remove the incomplete extra item.');
  if (free && !freeReason.trim()) problems.push('Give a reason for the free sale.');
  if (!free && canOverride && adjustKind !== 'none' && (adjustNumber === null || !adjustReason.trim())) problems.push('An adjustment needs a value and a reason.');
  if (!free && total > 0 && !payCheck.ok) problems.push('Complete the payment.');
  const ready = problems.length === 0;

  const { mutate, pending, error } = useSalesMutation(() => {
    const payments = free || total === 0 ? [] : toPaymentInputs(entry);
    const result = store.createCounterSale({
      machineId: machine!.id, minutes, operator, usages: usageInputs.map((usage) => ({ ownership: usage.ownership, materialId: usage.materialId, spoolId: usage.spoolId, materialName: usage.materialName, quantity: usage.quantity, quantityBasis: usage.quantityBasis })), runId: run?.id ?? null, pricingGroup: group, adjustment,
      extras: extraRows.map((row) => ({ description: row.description, quantity: row.quantity, unit: row.unit, unitPrice: free ? 0 : row.unitPrice, catalogItemId: row.extra.kind === 'catalog' ? row.extra.catalogItemId : null })),
      payments,
    });
    const cash = entry.rows.length === 1 && entry.rows[0].method === 'cash' ? parseMoney(entry.rows[0].tendered) : null;
    return { orderId: result.orderId, change: cash !== null && cash >= total ? { tendered: cash, change: round2(cash - total) } : null } as Done;
  });
  const complete = async () => {
    const result = await mutate();
    if (result.ok) setDone(result.value);
  };

  const reset = () => {
    setDone(null); setSource('run'); setRunId(''); setMachineId(''); setPreset(1); setCustom(''); setOperator(me); setLines([blankLine()]); setExtras([]); setGroup(defaultPricingGroup);
    setAdjustKind('none'); setAdjustValue(''); setAdjustReason(''); setFree(false); setFreeReason(''); setEntryDue(0); setEntry(newPaymentEntry(0));
  };

  const pickRun = (id: string) => {
    const chosen = runs.find((item) => item.id === id);
    setRunId(id);
    if (!chosen) return;
    setMachineId(chosen.machineId);
    const reported = chosen.reportedUsage;
    setLines(reported ? [{
      ...blankLine(), ownership: reported.materialId ? 'makerspace' : 'external', materialId: reported.materialId ?? '', externalName: reported.materialId ? '' : reported.materialName,
      spoolId: store.spools.find((spool) => spool.displayId === reported.spoolDisplayId)?.id ?? '', quantity: formatQuantity(reported.quantity),
    }] : [blankLine()]);
  };

  // Completion screen --------------------------------------------------------------------------------------------------------
  if (done) {
    const view = buildOrderViews(store).find((order) => order.id === done.orderId);
    const receiptPayments = view ? activeReceipts(store.payments, store.allocations, view.id) : [];
    return (
      <PageShell title="Sale completed" width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Counter sale', to: '/sales/counter' }]}
        actions={<Button kind="primary" renderIcon={Add} onClick={reset}>New sale</Button>}>
        <div className="sales-done">
          <Stack gap={5}>
            <div className="sales-done__banner"><CheckmarkFilled size={32} className="sales-done__icon" /><div><h2>{view ? formatEur(view.net) : ''} {view && view.net === 0 ? 'given away' : 'received'}</h2><p className="mj-secondary">Order {view?.reference}{receiptPayments.length ? ` · ${receiptPayments.map((payment) => payment.reference).join(', ')}` : ''}</p></div></div>
            {done.change && <Tile className="sales-change"><span className="mj-secondary">Change to give back</span><strong className="sales-change__amount">{formatEur(done.change.change)}</strong></Tile>}
            <div className="mj-inline"><Button kind="primary" renderIcon={Add} onClick={reset}>New sale</Button><Button kind="tertiary" as={Link} to={`/sales/orders/${done.orderId}`}>Open order</Button></div>
          </Stack>
          {view && <ReceiptPreview order={view} payments={receiptPayments} operator={operator.displayName} change={done.change} />}
        </div>
      </PageShell>
    );
  }

  const completeButton = <Button kind="primary" size="lg" disabled={!ready || pending} onClick={() => { void complete(); }}>{pending ? 'Completing…' : free ? 'Complete free sale' : `Complete sale · ${formatEur(total)}`}</Button>;

  return (
    <PageShell title="Counter sale" description="A quick sale for someone without an account: the job, the charge and the payment in one step." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Counter sale' }]}
      actions={<Button kind="tertiary" as={Link} to="/sales/orders">Orders</Button>}>
      <div className="sales-counter">
        <div className="mj-stack">
          <Tile>
            <h2 className="mj-section-title">What was made?</h2>
            <Stack gap={5}>
              <ContentSwitcher size="md" selectedIndex={source === 'run' ? 0 : 1} onChange={({ index }) => { setSource(index === 0 ? 'run' : 'manual'); setRunId(''); setLines([blankLine()]); }}>
                <Switch name="run" text="From a run" /><Switch name="manual" text="Manual" />
              </ContentSwitcher>
              {source === 'run' ? (
                runs.length === 0
                  ? <InlineNotification kind="info" lowContrast hideCloseButton title="No finished run is waiting" subtitle="Runs reported by a printer in the last 24 hours that are not on a job appear here. Switch to Manual to enter the work by hand." />
                  : (
                    <TileGroup legend="Finished runs without a job (last 24 hours)" name="counter-run" valueSelected={runId} onChange={(value) => pickRun(String(value))} className="sales-run-tiles">
                      {runs.map((candidate) => (
                        <RadioTile key={candidate.id} id={`run-${candidate.id}`} value={candidate.id}>
                          <span className="sales-run">
                            {candidate.previews[0] ? <img className="sales-run__thumb" src={candidate.previews[0].src} alt="" /> : <span className="sales-run__thumb sales-run__thumb--empty" aria-hidden />}
                            <span className="mj-cell-stack">
                              <strong>{nameFromFile(candidate.fileName)}</strong>
                              <span className="mj-secondary">{store.machines.find((item) => item.id === candidate.machineId)?.name} · ended {formatTime(candidate.endedAt!)}</span>
                              <span className="mj-secondary">{candidate.reportedUsage ? `${formatQuantity(candidate.reportedUsage.quantity)} ${candidate.reportedUsage.unit} ${candidate.reportedUsage.materialName}` : 'No material reported'}</span>
                            </span>
                          </span>
                        </RadioTile>
                      ))}
                    </TileGroup>
                  )
              ) : (
                <>
                  <ComboBox autoAlign id="counter-machine" titleText="Machine" placeholder="Search machines" items={machines} itemToString={(item) => item?.name ?? ''} selectedItem={machines.find((item) => item.id === machineId) ?? null}
                    onChange={({ selectedItem }) => { setMachineId(selectedItem?.id ?? ''); setLines([blankLine()]); }} shouldFilterItem={({ item, inputValue }) => !inputValue || !item || item.name.toLowerCase().includes(inputValue.toLowerCase())} />
                  <div>
                    <p className="cds--label">How long did it run?</p>
                    <ContentSwitcher size="md" selectedIndex={preset} onChange={({ index }) => setPreset(index ?? 0)}>{PRESETS.map((item) => <Switch key={item.label} name={item.label} text={item.label} />)}</ContentSwitcher>
                    {PRESETS[preset].minutes === 0 && <TextInput id="counter-minutes" className="sales-top-gap" labelText="Minutes" inputMode="decimal" value={custom} onChange={(event) => setCustom(event.target.value)} invalid={custom !== '' && !(minutes > 0)} invalidText="Enter the minutes, e.g. 45" />}
                  </div>
                </>
              )}
              {run && <p className="mj-secondary">Taken from the run: {formatDuration(minutes * 60)} on {machine?.name}. The run becomes part of the new job.</p>}
              <ComboBox autoAlign id="counter-operator" titleText="Operator" items={lookups.operators} itemToString={(item) => item ? `${item.displayName}${item.personId === me.personId ? ' (you)' : ''}` : ''} selectedItem={operator}
                onChange={({ selectedItem }) => setOperator(selectedItem ?? me)} shouldFilterItem={matchesName} />
            </Stack>
          </Tile>

          {(source === 'manual' ? !!machineId : !!run) && (
            <Tile>
              <h2 className="mj-section-title">Material</h2>
              <MaterialLines machineId={machine?.id ?? ''} lines={lines} onChange={setLines} disabled={pending} />
            </Tile>
          )}

          <Tile>
            <div className="mj-tile-header"><h2 className="mj-section-title">Extra items</h2><span className="mj-inline"><ProposedTag hint="Needs a sale catalog" /><span className="mj-secondary">Catalog items are proposed; custom items exist today</span></span></div>
            <Stack gap={5}>
              {extras.length === 0 && <p className="mj-secondary">Filament by the gram, small parts or anything else sold with the job.</p>}
              {extras.map((extra, index) => {
                const row = extraRows[index];
                const patch = (change: Partial<Extra>) => setExtras((current) => current.map((item) => item.key === extra.key ? { ...item, ...change } : item));
                return (
                  <div key={extra.key} className="sales-extra">
                    {extra.kind === 'catalog' ? (
                      <ComboBox autoAlign id={`${extra.key}-item`} titleText="Catalog item" placeholder="Search the catalog" items={catalogItems} itemToString={(item) => item ? `${item.name} · ${formatEur(item.unitPrice)} per ${item.unit}` : ''}
                        selectedItem={catalogItems.find((item) => item.id === extra.catalogItemId) ?? null} onChange={({ selectedItem }) => patch({ catalogItemId: selectedItem?.id ?? '' })} />
                    ) : (
                      <>
                        <TextInput id={`${extra.key}-desc`} labelText="Description" value={extra.description} onChange={(event) => patch({ description: event.target.value })} />
                        <TextInput id={`${extra.key}-price`} labelText="Unit price (€)" inputMode="decimal" value={extra.unitPrice} onChange={(event) => patch({ unitPrice: event.target.value })} invalid={extra.unitPrice !== '' && parseMoney(extra.unitPrice) === null} invalidText="e.g. 4,50" />
                      </>
                    )}
                    <TextInput id={`${extra.key}-qty`} labelText="Quantity" inputMode="decimal" value={extra.quantity} onChange={(event) => patch({ quantity: event.target.value })} invalid={parseQuantity(extra.quantity) === null || parseQuantity(extra.quantity) === 0} invalidText="Greater than zero" />
                    <div className="sales-extra__amount"><span className="mj-secondary">Line</span><strong>{row.valid ? formatEur(row.amount) : '—'}</strong></div>
                    <IconButton label="Remove this item" kind="ghost" size="md" onClick={() => setExtras((current) => current.filter((item) => item.key !== extra.key))}><TrashCan /></IconButton>
                  </div>
                );
              })}
              <div className="mj-inline">
                <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setExtras((current) => [...current, newExtra('catalog')])}>Catalog item</Button>
                <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setExtras((current) => [...current, newExtra('custom')])}>Custom item</Button>
              </div>
            </Stack>
          </Tile>

          <Tile>
            <h2 className="mj-section-title">Payment</h2>
            <Stack gap={5}>
              {canOverride && (
                <ContentSwitcher size="md" selectedIndex={free ? 1 : 0} onChange={({ index }) => setFree(index === 1)}>
                  <Switch name="pays" text="Customer pays" /><Switch name="free" text="Free of charge" />
                </ContentSwitcher>
              )}
              {free ? (
                <TextArea id="counter-free-reason" labelText="Why is this sale free?" rows={2} value={freeReason} onChange={(event) => setFreeReason(event.target.value)} invalid={freeReason.length > 0 && !freeReason.trim()}
                  helperText="Kept on the job as a price adjustment to €0,00. The order is recorded with no payment due." />
              ) : total === 0 ? (
                <p className="mj-secondary">The total is €0,00, so nothing has to be paid.</p>
              ) : (
                <PaymentEntryForm idPrefix="counter-pay" entry={entry} onChange={setEntry} due={total} requireFull payments={store.payments} disabled={pending} />
              )}
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="The sale was not recorded" subtitle={`${error} Nothing was saved. If a card was already charged, record that same transaction again instead of charging twice.`} />}
            </Stack>
          </Tile>
        </div>

        <aside className="sales-price" aria-label="Price">
          <Tile>
            <h2 className="mj-section-title">Price</h2>
            <Stack gap={5}>
              <ul className="sales-quote">
                {quote.lines.map((line) => <li key={line.key}><span className="mj-cell-stack"><span>{line.label}</span><span className="mj-secondary">{line.detail}</span></span><span>{formatEur(line.amount)}</span></li>)}
                {adjustment && !free && adjustment.value >= 0 && <li><span className="mj-cell-stack"><span>Adjustment</span><span className="mj-secondary">{ADJUSTMENTS.find((item) => item.kind === adjustKind)?.label}</span></span><span>{formatEur(round2(jobAmount - quote.total))}</span></li>}
                {extraRows.filter((row) => row.valid).map((row) => <li key={row.extra.key}><span className="mj-cell-stack"><span>{row.description}</span><span className="mj-secondary">{formatQuantity(row.quantity)} {row.unit} × {formatEur(row.unitPrice)}</span></span><span>{free ? <Tag type="gray" size="sm">Waived</Tag> : formatEur(row.amount)}</span></li>)}
                {free && <li><span className="mj-cell-stack"><span>Free of charge</span><span className="mj-secondary">{freeReason.trim() || 'Reason missing'}</span></span><span>{formatEur(round2(-quote.total))}</span></li>}
              </ul>
              <div className="sales-total"><span>Total</span><strong>{formatEur(total)}</strong></div>
              <Select id="counter-group" labelText="Pricing group" helperText="Walk-in customers are priced with the default group unless you choose another." value={group} disabled={pending} onChange={(event) => setGroup(event.target.value)}>
                {pricingGroups.map((item) => <SelectItem key={item.name} value={item.name} text={`${item.name}${item.isDefault ? ' (default)' : ''}`} />)}
              </Select>
              {canOverride && !free && (
                <>
                  <Select id="counter-adjust" labelText="Adjust the job price" value={adjustKind} disabled={pending} onChange={(event) => { setAdjustKind(event.target.value as PriceAdjustmentKind | 'none'); setAdjustValue(''); }}>
                    {ADJUSTMENTS.map((item) => <SelectItem key={item.kind} value={item.kind} text={item.label} />)}
                  </Select>
                  {adjustKind !== 'none' && (
                    <>
                      <TextInput id="counter-adjust-value" labelText={adjustKind === 'discount_percent' ? 'Discount (%)' : adjustKind === 'fixed' ? 'Final job price (€)' : 'Discount (€)'} inputMode="decimal" value={adjustValue} onChange={(event) => setAdjustValue(event.target.value)} invalid={adjustValue !== '' && adjustNumber === null} invalidText="Enter a number" />
                      <TextInput id="counter-adjust-reason" labelText="Reason" value={adjustReason} onChange={(event) => setAdjustReason(event.target.value)} />
                    </>
                  )}
                </>
              )}
              <div className="mj-hide-narrow">
                {completeButton}
                {!ready && <ul className="sales-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
              </div>
            </Stack>
          </Tile>
        </aside>
      </div>
      <div className="sales-pricebar mj-show-narrow" role="region" aria-label="Total">
        <div className="mj-cell-stack"><span className="mj-secondary">Total</span><strong>{formatEur(total)}</strong></div>
        {completeButton}
      </div>
    </PageShell>
  );
}

export function CounterSalePage() {
  return (
    <RequirePermission permission={['orders.write', 'orders.finalize', 'payments.record', 'machine_jobs.create']} title="Counter sale" crumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Counter sale' }]}>
      <CounterSale />
    </RequirePermission>
  );
}
