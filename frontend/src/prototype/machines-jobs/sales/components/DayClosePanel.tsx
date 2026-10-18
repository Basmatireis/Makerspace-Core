import { useState } from 'react';
import { Accordion, AccordionItem, Button, ContainedList, ContainedListItem, InlineNotification, Modal, NumberInput, Select, SelectItem, Stack, Tag, TextArea, Tile } from '@carbon/react';
import { Locked } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { dateInAppTimeZone } from '../../../../app/dateTime';
import { useStore } from '../../store';
import { formatDate, formatDateTime, formatEur, formatSignedEur, round2 } from '../format';
import { cashDayFigures, openCashDays } from '../logic';
import { ProposedTag } from '../status';
import { useSalesMutation } from '../useSalesMutation';
import type { DaySession, Payment } from '../types';

const NOTES = [200, 100, 50, 20, 10, 5];
const COINS = [2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];
const denominationLabel = (value: number) => `${value >= 5 ? 'Note' : 'Coin'} ${value >= 1 ? `€ ${value}` : `${Math.round(value * 100)} cent`}`;
const dayLabel = (day: string) => formatDate(`${day}T12:00:00Z`);

function DifferenceTag({ difference }: { difference: number }) {
  if (difference === 0) return <Tag type="green" size="sm">Matches</Tag>;
  return <Tag type={difference < 0 ? 'red' : 'purple'} size="sm">{difference < 0 ? `${formatEur(-difference)} short` : `${formatEur(difference)} over`}</Tag>;
}

/**
 * [proposed] Counting the till at the end of a day. The system expects the cash receipts of the day minus cash refunds and corrections;
 * the person counts what is really there and explains any difference. A closed day is locked: cash cannot be added to or corrected on it.
 */
export function DayClosePanel({ payments, sessions, canClose }: { payments: Payment[]; sessions: DaySession[]; canClose: boolean }) {
  const store = useStore();
  const today = dateInAppTimeZone(new Date());
  const open = openCashDays(payments, sessions);
  const days = open.includes(today) || sessions.some((session) => session.day === today) ? open : [today, ...open];
  const [chosen, setChosen] = useState('');
  const day = days.includes(chosen) ? chosen : days[0] ?? today;
  const figures = cashDayFigures(payments, day);
  const [counted, setCounted] = useState<number | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const counting = round2([...NOTES, ...COINS].reduce((total, value) => total + value * (counts[String(value)] ?? 0), 0));
  const difference = counted === null ? null : round2(counted - figures.expected);
  const noteMissing = difference !== null && difference !== 0 && note.trim() === '';
  const closed = sessions.some((session) => session.day === day);
  const setCount = (value: number, count: number | string) => setCounts((current) => ({ ...current, [String(value)]: Math.max(0, Math.floor(Number(count) || 0)) }));

  const { mutate, pending, error } = useSalesMutation(() => store.closeDay({ day, countedCash: counted!, denominations: Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)), note }));
  const close = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: `${dayLabel(day)} closed`, subtitle: difference === 0 ? 'The cash matches.' : `Difference of ${formatSignedEur(difference ?? 0)} recorded.` });
    setConfirming(false); setCounted(null); setCounts({}); setNote(''); setChosen('');
  };

  return (
    <div className="sales-dayclose">
      <Stack gap={5}>
        <Tile>
          <div className="mj-tile-header"><h2 className="mj-section-title">Close a cash day</h2><ProposedTag hint="Needs cash day sessions on the backend" /></div>
          <Stack gap={5}>
            <p className="mj-secondary">Count the cash in the till, compare it with what the system expects and close the day. Card payments and bank transfers are not part of the till.</p>
            <Select id="dayclose-day" labelText="Day" value={day} onChange={(event) => { setChosen(event.target.value); setCounted(null); setCounts({}); setNote(''); }}>
              {days.map((item) => <SelectItem key={item} value={item} text={`${dayLabel(item)}${item === today ? ' (today)' : ''}`} />)}
            </Select>
            {closed && <InlineNotification kind="info" lowContrast hideCloseButton title={`${dayLabel(day)} is closed`} subtitle="Its cash can no longer be changed. A later refund is booked on the day it happens." />}
            <section className="sales-tiles" aria-label="Expected cash">
              <Tile className="sales-tile"><span className="sales-tile__label">Cash received</span><span className="sales-tile__value">{formatEur(figures.receipts)}</span><span className="mj-secondary">{figures.count} cash {figures.count === 1 ? 'entry' : 'entries'} on this day</span></Tile>
              <Tile className="sales-tile"><span className="sales-tile__label">Refunds and corrections</span><span className="sales-tile__value">{formatEur(figures.refunds)}</span><span className="mj-secondary">Paid out of the till</span></Tile>
              <Tile className="sales-tile"><span className="sales-tile__label">Expected in the till</span><span className="sales-tile__value">{formatEur(figures.expected)}</span><Link to={`/sales/payments?period=custom&from=${day}&to=${day}&method=cash`}>See the cash lines</Link></Tile>
            </section>

            {canClose && !closed && (
              <>
                <NumberInput
                  id="dayclose-counted" label="Counted cash (€)" min={0} step={0.01} allowEmpty value={counted ?? ''} helperText="What you actually counted in the till."
                  invalid={counted !== null && (counted < 0 || round2(counted) !== counted)} invalidText="Enter an amount of zero or more, with at most two decimals"
                  onChange={(_event, state) => { const value = typeof state.value === 'number' ? state.value : Number(state.value); setCounted(state.value === '' || Number.isNaN(value) ? null : value); }}
                />
                <Accordion>
                  <AccordionItem title={`Count banknotes and coins${counting > 0 ? ` · ${formatEur(counting)}` : ''}`}>
                    <Stack gap={5}>
                      <div className="sales-denominations">
                        {[...NOTES, ...COINS].map((value) => (
                          <NumberInput key={value} id={`denomination-${value}`} label={denominationLabel(value)} size="sm" min={0} step={1} allowEmpty value={counts[String(value)] ?? 0} onChange={(_event, state) => setCount(value, state.value)} />
                        ))}
                      </div>
                      <div className="sales-cover"><span className="mj-secondary">Counted in notes and coins</span><strong>{formatEur(counting)}</strong><Button kind="tertiary" size="sm" disabled={counting === 0} onClick={() => setCounted(counting)}>Use as counted cash</Button></div>
                    </Stack>
                  </AccordionItem>
                </Accordion>
                <div className="sales-cover" aria-live="polite"><span className="mj-secondary">Difference</span><strong>{difference === null ? '—' : formatSignedEur(difference)}</strong>{difference !== null && <DifferenceTag difference={difference} />}</div>
                <TextArea id="dayclose-note" labelText={difference ? 'Note (required for a difference)' : 'Note (optional)'} rows={2} maxCount={500} enableCounter value={note} onChange={(event) => setNote(event.target.value)}
                  invalid={noteMissing} invalidText="Explain the difference" helperText="Kept with the closed day. Do not add personal data." />
                <div><Button kind="primary" disabled={counted === null || noteMissing || (counted !== null && round2(counted) !== counted)} onClick={() => setConfirming(true)}>Close day</Button></div>
              </>
            )}
            {!canClose && !closed && <p className="mj-secondary">You can look at the figures, but closing a day needs the permission to record payments.</p>}
          </Stack>
        </Tile>

        <ContainedList label="Closed days" kind="on-page">
          {sessions.length === 0 && <ContainedListItem>No day has been closed yet.</ContainedListItem>}
          {[...sessions].sort((a, b) => b.day.localeCompare(a.day)).map((session) => (
            <ContainedListItem key={session.id} renderIcon={Locked} action={<DifferenceTag difference={session.difference} />}>
              <span className="mj-cell-stack">
                <strong>{dayLabel(session.day)}: counted {formatEur(session.countedCash)} of {formatEur(session.expectedCash)} expected</strong>
                <span className="mj-secondary">Closed by {session.closedBy} · {formatDateTime(session.closedAt)}{session.note ? ` · ${session.note}` : ''}</span>
              </span>
            </ContainedListItem>
          ))}
        </ContainedList>
      </Stack>

      {confirming && counted !== null && (
        <Modal open size="sm" modalHeading={`Close ${dayLabel(day)}`} modalLabel="Day close" primaryButtonText={pending ? 'Closing…' : 'Close day'} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
          preventCloseOnClickOutside onRequestClose={() => { if (!pending) setConfirming(false); }} onRequestSubmit={() => { void close(); }}>
          <Stack gap={4}>
            <p>You counted <strong>{formatEur(counted)}</strong>; the system expects <strong>{formatEur(figures.expected)}</strong> ({difference === 0 ? 'matches' : formatSignedEur(difference ?? 0)}).</p>
            <p>After closing, no cash payment can be added to this day and no cash payment of this day can be corrected. A refund is always booked on the day it happens.</p>
            {error && <InlineNotification kind="error" lowContrast hideCloseButton title="The day was not closed" subtitle={error} />}
          </Stack>
        </Modal>
      )}
    </div>
  );
}
