import { useState, type ReactNode } from 'react';
import { Button, DefinitionTooltip, IconButton, Tag } from '@carbon/react';
import {
  Add,
  ArrowRight,
  Checkmark,
  Close,
  Edit,
  Receipt,
  Subtract,
  TrashCan,
  WarningAlt,
  Wallet,
} from '@carbon/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteWorkingGroupIncome } from '../../api/generated/working-groups/working-groups';
import { Link } from 'react-router-dom';
import type { CashCount, CashJournal, CashJournalEntry, WorkingGroupIncome } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DetailPanel, DetailPanelSection } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { RefLink } from '../../app/RefLink';
import { workingGroupKeys } from '../workinggroups/queries';
import { formatDate, formatDateTime } from '../../app/dateTime';
import {
  countReasonLabel,
  differenceText,
  entryEffect,
  isEditableEntry,
  journalKindLabel,
  registerDerivation,
} from './cashJournal';
import { bookedAheadEntries, budgetIncomeQuery } from './budgetIncome';
import { cashMovementReasonLabel } from './labels';
import { formatCents, formatSignedCents, toCents } from './money';
import { periodName, type Period } from './period';
import { useFinanceMutation } from './queries';

export type RegisterAction = 'count' | 'withdrawal' | 'deposit' | 'bookahead';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Green "Matches expected" or red "−€2.50 short" / "+€1.00 over". */
export function DifferenceTag({ difference }: { difference: number }) {
  return (
    <Tag type={difference === 0 ? 'green' : 'red'} size="sm" renderIcon={difference === 0 ? Checkmark : WarningAlt}>
      {differenceText(difference)}
    </Tag>
  );
}

/** Label above the title, as Carbon modals and the panels of the Workshop lists head their content. */
function PanelHead({
  label,
  title,
  titleId,
  tags,
  onClose,
}: {
  label: string;
  title: string;
  titleId: string;
  tags?: ReactNode;
  onClose?: () => void;
}) {
  return (
    <header className="detail-panel__head">
      <div className="sales-panel-heading">
        <p className="sales-panel-label">{label}</p>
        <h2 id={titleId} className="detail-panel__title">
          {title}
        </h2>
        {tags && <div className="sales-tags">{tags}</div>}
      </div>
      {onClose && (
        <div className="detail-panel__actions">
          <IconButton label="Close panel" kind="ghost" size="md" align="left" onClick={onClose}>
            <Close />
          </IconButton>
        </div>
      )}
    </header>
  );
}

/**
 * What should be in the register at the end of the period, how that follows from the cash entries, the actions on the
 * register, the last count and what happened in the period.
 */
export function RegisterPanel({
  journal,
  period,
  onAction,
  canCount,
  canMove,
  canBudget = false,
  onWithdrawAhead,
}: {
  journal: CashJournal;
  period: Period;
  onAction: (action: RegisterAction) => void;
  canCount: boolean;
  canMove: boolean;
  /** working_group_finances.manage: the booked-ahead line, the button and the list of bookings. */
  canBudget?: boolean;
  onWithdrawAhead?: (incomeId: string) => void;
}) {
  const { register, facts } = journal;
  const last = register.lastCount;
  const outEntries = facts.refunds + facts.corrections;
  return (
    <DetailPanel className="sales-register-panel">
      <PanelHead
        label={`Cash register · ${periodName(period)}`}
        title="Expected in the register"
        titleId="register-title"
      />
      <div>
        <p className="sales-hero">{formatCents(toCents(register.expected))}</p>
        <p className="sales-secondary">
          {period.preset === 'all'
            ? 'Up to now'
            : period.preset === 'custom'
              ? 'To the end of the range'
              : `To the end of ${period.label.toLowerCase()}`}
        </p>
      </div>
      <dl className="sales-sum sales-sum--panel" aria-label="How the expected cash is calculated">
        {registerDerivation(register).map((line) => (
          <div key={line.label} className={line.total ? 'sales-sum__total' : undefined}>
            <dt>
              {line.helper ? (
                <DefinitionTooltip definition={line.helper} align="bottom-left" openOnHover>
                  {line.label}
                </DefinitionTooltip>
              ) : (
                line.label
              )}
            </dt>
            <dd>{formatCents(line.cents)}</dd>
          </div>
        ))}
        {canBudget && register.bookedAhead != null && (
          <div>
            <dt>
              <DefinitionTooltip
                definition="Counted in the working-group budget; the cash is still in the register"
                align="bottom-left"
                openOnHover
              >
                Booked ahead to the budget
              </DefinitionTooltip>
            </dt>
            <dd>{formatCents(toCents(register.bookedAhead))}</dd>
          </div>
        )}
      </dl>
      {(canCount || canMove) && (
        <div className="sales-register-actions">
          {canCount && (
            <Button kind="primary" size="md" renderIcon={Checkmark} onClick={() => onAction('count')}>
              <span className="sales-register-actions__label">Count</span>
            </Button>
          )}
          {canMove && (
            <>
              <Button kind="secondary" size="md" renderIcon={Subtract} onClick={() => onAction('withdrawal')}>
                <span className="sales-register-actions__label">Withdraw</span>
              </Button>
              <Button kind="secondary" size="md" renderIcon={Add} onClick={() => onAction('deposit')}>
                <span className="sales-register-actions__label">Deposit</span>
              </Button>
            </>
          )}
          {canBudget && (
            <Button kind="tertiary" size="md" renderIcon={Wallet} onClick={() => onAction('bookahead')}>
              <span className="sales-register-actions__label">Book ahead to the budget</span>
            </Button>
          )}
        </div>
      )}
      {canBudget && canMove && onWithdrawAhead && <BookedAheadSection onWithdraw={onWithdrawAhead} />}
      <DetailPanelSection
        title="Last count"
        action={last ? <DifferenceTag difference={toCents(last.difference)} /> : undefined}
      >
        {last ? <LastCount count={last} /> : <p className="sales-secondary">Not counted yet.</p>}
      </DetailPanelSection>
      <DetailPanelSection
        title={period.preset === 'all' ? 'All time' : period.preset === 'custom' ? 'In the range' : period.label}
      >
        <FactsGrid>
          <Fact
            label="Cash in"
            helper={`${plural(facts.receipts, 'receipt', 'receipts')} · ${plural(facts.deposits, 'deposit', 'deposits')}`}
          >
            {formatCents(toCents(facts.cashIn))}
          </Fact>
          <Fact
            label="Cash out"
            helper={`${plural(outEntries, 'refund or correction', 'refunds or corrections')} · ${plural(facts.withdrawals, 'withdrawal', 'withdrawals')}`}
          >
            {formatCents(toCents(facts.cashOut))}
          </Fact>
          <Fact label="Net">{formatSignedCents(toCents(facts.net))}</Fact>
          <Fact label="Counts">{facts.counts}</Fact>
        </FactsGrid>
      </DetailPanelSection>
    </DetailPanel>
  );
}

/** The bookings ahead that are still in the register: withdraw (all or part) or undo. */
function BookedAheadSection({ onWithdraw }: { onWithdraw: (incomeId: string) => void }) {
  const income = useQuery(budgetIncomeQuery());
  const client = useQueryClient();
  const [undoing, setUndoing] = useState<WorkingGroupIncome | null>(null);
  const entries = bookedAheadEntries(income.data?.items);
  const undo = useFinanceMutation(
    (entry: WorkingGroupIncome) => deleteWorkingGroupIncome(entry.id),
    async () => {
      // The budget page shows the income too.
      await client.invalidateQueries({ queryKey: workingGroupKeys.all });
      setUndoing(null);
    },
  );
  if (entries.length === 0) return null;
  return (
    <DetailPanelSection title="Booked ahead to the budget">
      <ul className="sales-booked-ahead">
        {entries.map((entry) => (
          <li key={entry.id} className="sales-inline">
            <span>
              {entry.note}
              <span className="mj-secondary">
                {' · '}
                {formatDate(entry.occurredOn)}
                {' · '}
                {formatCents(toCents(entry.amount))}
              </span>
            </span>
            <Button kind="ghost" size="sm" aria-label={`Withdraw ${entry.note}`} onClick={() => onWithdraw(entry.id)}>
              Withdraw
            </Button>
            <IconButton label={`Undo booking ${entry.note}`} kind="ghost" size="sm" onClick={() => setUndoing(entry)}>
              <TrashCan />
            </IconButton>
          </li>
        ))}
      </ul>
      {undoing && (
        <DestructiveActionDialog
          open
          title="Undo this booking?"
          fate="none"
          confirmLabel="Undo booking"
          pending={undo.isPending}
          error={undo.error?.message}
          onConfirm={() => undo.mutate(undoing)}
          onClose={() => setUndoing(null)}
        >
          <p>
            {undoing.note} ({formatCents(toCents(undoing.amount))}) no longer counts in the budget. The cash stays in
            the register.
          </p>
        </DestructiveActionDialog>
      )}
    </DetailPanelSection>
  );
}

function LastCount({ count }: { count: CashCount }) {
  const difference = toCents(count.difference);
  return (
    <FactsGrid>
      <Fact label="Counted" helper={count.reference}>
        {formatCents(toCents(count.countedAmount))}
      </Fact>
      <Fact label="Expected then" helper={count.reason ? countReasonLabel[count.reason] : 'No difference'}>
        {formatCents(toCents(count.expectedAmount))}
      </Fact>
      <Fact label="When">{formatDateTime(count.countedAt)}</Fact>
      <Fact
        label="By"
        helper={difference !== 0 && count.correction ? `Booked ${count.correction.reference}` : undefined}
      >
        {count.recordedBy?.displayName ?? '—'}
      </Fact>
    </FactsGrid>
  );
}

/**
 * One journal entry in the panel: a payment, a withdrawal or deposit, a count correction or a count. With
 * cash_movements.manage a withdrawal, deposit or count offers Edit and Delete.
 */
export function EntryPanel({
  entry,
  canOrders,
  canManage = false,
  canBudget = false,
  onEdit,
  onDelete,
  onClose,
}: {
  entry: CashJournalEntry;
  canOrders: boolean;
  canManage?: boolean;
  /** working_group_finances.manage: the budget mark of a withdrawal. */
  canBudget?: boolean;
  onEdit?: (entry: CashJournalEntry) => void;
  onDelete?: (entry: CashJournalEntry) => void;
  onClose: () => void;
}) {
  const effect = entryEffect(entry);
  const count = entry.count;
  const order = entry.order;
  const orderLink = canOrders && order?.id ? `/orders/${order.id}` : null;
  const difference = count ? toCents(count.difference) : 0;
  return (
    <DetailPanel>
      <PanelHead
        label={`${journalKindLabel[entry.kind]} · ${formatDateTime(entry.occurredAt)}`}
        title={entry.reference}
        titleId="entry-title"
        tags={
          <>
            <Tag type="gray" size="sm">
              {journalKindLabel[entry.kind]}
            </Tag>
            {count && <DifferenceTag difference={difference} />}
          </>
        }
        onClose={onClose}
      />
      {entry.source === 'payment' && orderLink && (
        <div className="sales-inline">
          <Button as={Link} to={orderLink} kind="primary" size="md" renderIcon={ArrowRight}>
            Go to order
          </Button>
          {entry.kind === 'receipt' && (
            <Button
              as={Link}
              to={`${orderLink}/receipt?payment=${entry.id}`}
              kind="secondary"
              size="md"
              renderIcon={Receipt}
            >
              Show receipt
            </Button>
          )}
        </div>
      )}
      {canManage && isEditableEntry(entry) && !(canBudget && entry.intoBudget) && (
        <div className="sales-inline">
          <Button kind="secondary" size="md" renderIcon={Edit} onClick={() => onEdit?.(entry)}>
            Edit
          </Button>
          <Button kind="danger--tertiary" size="md" renderIcon={TrashCan} onClick={() => onDelete?.(entry)}>
            Delete
          </Button>
        </div>
      )}
      <FactsGrid>
        {count ? (
          <>
            <Fact label="Counted">{formatCents(toCents(count.countedAmount))}</Fact>
            <Fact label="Expected then">{formatCents(toCents(count.expectedAmount))}</Fact>
            <Fact label="Difference" helper={difference ? 'Booked as a correction' : 'No difference'}>
              {formatSignedCents(difference)}
            </Fact>
          </>
        ) : (
          <>
            <Fact
              label={effect < 0 ? 'Cash out' : 'Cash in'}
              helper={effect < 0 ? 'Left the register' : 'Into the register'}
            >
              {formatCents(Math.abs(effect))}
            </Fact>
            <Fact label="Balance after">{formatCents(toCents(entry.balanceAfter))}</Fact>
          </>
        )}
        <Fact label="Recorded by" helper={formatDateTime(entry.occurredAt)}>
          {entry.recordedBy?.displayName ?? '—'}
        </Fact>
        <Fact label="Method" helper="Register">
          Cash
        </Fact>
        {order && (
          <Fact label="Order" helper={order.customerName ?? undefined}>
            <RefLink reference={order.reference} id={order.id} kind="order" />
          </Fact>
        )}
        {entry.source === 'payment' && entry.paymentReason && <Fact label="Reason">{entry.paymentReason}</Fact>}
        {entry.reversedPaymentReference && <Fact label="Reverses">{entry.reversedPaymentReference}</Fact>}
        {canBudget && entry.intoBudget && (
          <Fact label="Budget" helper="Cannot be edited or deleted">
            Into the budget
          </Fact>
        )}
        {entry.movementReason && (
          <Fact label="Reason" helper={entry.note || undefined}>
            {cashMovementReasonLabel[entry.movementReason]}
          </Fact>
        )}
        {count?.reason && (
          <Fact label="Reason" helper={entry.note || undefined}>
            {countReasonLabel[count.reason]}
          </Fact>
        )}
        {entry.version != null && entry.version > 1 && entry.updatedAt && (
          <Fact label="Last edited">{formatDateTime(entry.updatedAt)}</Fact>
        )}
        {entry.source === 'payment' && (
          <Fact label="Payment">
            <RefLink reference={entry.reference} id={entry.id} kind="payment" />
          </Fact>
        )}
      </FactsGrid>
    </DetailPanel>
  );
}
