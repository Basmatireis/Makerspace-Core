import { useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  ProgressBar,
  Search,
  Stack,
  TextInput,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import type { WorkingGroupBudgetPeriod, WorkingGroupGroupBudget } from '../../api/generated/models';
import {
  closeWorkingGroupBudgetPeriod,
  createWorkingGroupBudgetPeriod,
  setWorkingGroupBudgetShare,
  updateWorkingGroupBudgetPeriod,
} from '../../api/generated/working-groups/working-groups';
import { DateInput } from '../../app/DateInput';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { Tile } from './TaskSummary';
import { formatCents, fromCents, moneyInputText, parseMoneyInput, toCents } from '../orders/money';
import { BudgetCard, type Figures } from './BudgetParts';
import { sortPeriods } from './financeModel';
import { budgetOptions, budgetPeriodsOptions } from './financeQueries';
import { workingGroupsOptions } from './queries';
import { plural } from './taskModel';
import { useDialogOpener } from './useDialogOpener';
import { saveErrorText, taskErrorText, useWgMutation } from './useWgMutation';
import './workinggroups.scss';

const TITLE = 'Budget';
const CRUMBS = [{ label: 'Working groups', to: '/working-groups' }];

const percent = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.round((part / whole) * 100)) : 0);

/** Working groups → Budget (finance managers): what HTU gives and how the groups use their share. */
export function BudgetPage() {
  const periodsQuery = useQuery(budgetPeriodsOptions);
  const groupsQuery = useQuery(workingGroupsOptions);
  const periods = useMemo(() => sortPeriods(periodsQuery.data?.items ?? []), [periodsQuery.data]);
  const [chosen, setChosen] = useState<string | null>(null);
  const period = periods.find((candidate) => candidate.id === chosen) ?? periods.find((p) => p.current) ?? periods[0];
  const budgetQuery = useQuery({ ...budgetOptions({ periodId: period?.id }), enabled: period !== undefined });
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialog = useDialogOpener<'edit' | 'new'>();
  const rowOpener = useRef<HTMLElement | null>(null);
  const panelFits = useListPanelLayout();

  const summaries = useMemo(
    () => new Map((groupsQuery.data?.items ?? []).map((group) => [group.id, group])),
    [groupsQuery.data],
  );

  if (periodsQuery.isPending) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <InlineLoadingState label="Loading the budget" />
      </PageShell>
    );
  }
  if (periodsQuery.isError) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <ErrorState title="Budget unavailable" message="Reload the page to try again." />
      </PageShell>
    );
  }
  if (!period) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <EmptyState
          title="No budget period yet"
          description="A period holds the budget from HTU and the shares of the groups."
          action={
            <Button kind="primary" size="md" onClick={() => dialog.open('new')}>
              New budget period
            </Button>
          }
        />
        {dialog.value && <PeriodDialog mode="new" period={undefined} previous={undefined} onClose={dialog.close} />}
      </PageShell>
    );
  }

  const budget = budgetQuery.data;
  const totals = budget?.totals;
  const figures: Figures | null = totals
    ? {
        given: toCents(totals.givenSum),
        spent: toCents(totals.spentSum),
        reserved: toCents(totals.reservedSum),
        free: toCents(totals.freeSum),
        kept: toCents(totals.keptBack),
      }
    : null;
  const needle = search.trim().toLowerCase();
  const rows = (budget?.groups ?? [])
    .filter((entry) => !needle || entry.groupName.toLowerCase().includes(needle))
    .sort((a, b) => a.groupName.localeCompare(b.groupName));
  const selected = (budget?.groups ?? []).find((entry) => entry.groupId === selectedId) ?? null;
  const total = toCents(period.totalAmount);

  const panel = selected ? (
    <SharePanel key={`${period.id}-${selected.groupId}`} period={period} entry={selected} />
  ) : (
    <DetailPanel>
      <DetailPanelSection>
        <p className="wg-placeholder__title">Nothing selected</p>
        <p className="wg-muted">Pick a group.</p>
      </DetailPanelSection>
    </DetailPanel>
  );

  return (
    <PageShell title={TITLE} width="wide" breadcrumbs={CRUMBS}>
      <div className="wg-summary wg-summary--two">
        {figures ? (
          <BudgetCard
            label="Budget"
            figures={figures}
            periods={periods}
            periodId={period.id}
            onPeriod={(id) => {
              setChosen(id);
              setSelectedId(null);
            }}
          />
        ) : (
          <section className="wg-sbar" aria-label="Budget">
            {budgetQuery.isError ? <p>The budget could not be loaded.</p> : <p className="wg-muted">Loading…</p>}
          </section>
        )}
        <Tile
          title="From HTU"
          count={formatCents(total)}
          rows={[
            ['Given', formatCents(figures?.given ?? 0)],
            ['Kept back', formatCents(figures?.kept ?? 0)],
            ['Given out', `${percent(figures?.given ?? 0, total)} %`],
            ['Groups', String(budget?.groups.length ?? 0)],
          ]}
        />
      </div>

      <ListWithPanel panel={panel} panelLabel="Group budget details">
        <div className="wg-card-list">
          <div className="wg-toolbar">
            <div className="wg-toolbar__search">
              <Search
                id="wg-budget-search"
                size="md"
                labelText="Search groups"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onClear={() => setSearch('')}
              />
            </div>
            <div className="wg-toolbar__actions">
              <Button kind="tertiary" size="md" onClick={() => dialog.open('edit')}>
                Edit period
              </Button>
              <Button kind="primary" size="md" onClick={() => dialog.open('new')}>
                New budget period
              </Button>
            </div>
          </div>
          {rows.length === 0 ? (
            <p className="wg-empty">{budgetQuery.isPending ? 'Loading…' : 'No groups match.'}</p>
          ) : (
            <div className="wg-list">
              <div className="wg-lrow wg-brow wg-lrow--head" aria-hidden="true">
                <span>Free</span>
                <span>Group</span>
                <span>Given</span>
                <span>Used</span>
              </div>
              <ul className="wg-llist">
                {rows.map((entry) => {
                  const summary = summaries.get(entry.groupId);
                  const given = toCents(entry.given);
                  const used = toCents(entry.spent) + toCents(entry.reserved);
                  return (
                    <li key={entry.groupId}>
                      <button
                        type="button"
                        className={`wg-lrow wg-brow${entry.groupId === selectedId ? ' is-selected' : ''}`}
                        aria-pressed={entry.groupId === selectedId}
                        onClick={() => {
                          rowOpener.current =
                            document.activeElement instanceof HTMLElement ? document.activeElement : null;
                          setSelectedId(entry.groupId);
                        }}
                      >
                        <span className="wg-pamount">
                          <strong>{formatCents(toCents(entry.free))}</strong>
                        </span>
                        <span className="wg-lwhat">
                          <span className="wg-lwhat__title">{entry.groupName}</span>
                          <small>
                            {summary?.lead ? summary.lead.displayName : 'No management'}
                            {summary ? ` · ${plural(summary.memberCount, 'person', 'people')}` : ''}
                          </small>
                        </span>
                        <span>{formatCents(given)}</span>
                        <span className="wg-bused">
                          <ProgressBar
                            label={`Used by ${entry.groupName}`}
                            hideLabel
                            size="small"
                            value={Math.min(100, percent(used, given))}
                            max={100}
                          />
                          <small>
                            {formatCents(toCents(entry.spent))} spent · {formatCents(toCents(entry.reserved))} reserved
                          </small>
                        </span>
                      </button>
                    </li>
                  );
                })}
                <li>
                  <div className="wg-lrow wg-brow wg-brow--total">
                    <span className="wg-pamount">
                      <strong>{formatCents(figures?.free ?? 0)}</strong>
                    </span>
                    <span className="wg-lwhat">
                      <span className="wg-lwhat__title">Total</span>
                    </span>
                    <span>{formatCents(figures?.given ?? 0)}</span>
                    <span>{percent(figures ? figures.spent + figures.reserved : 0, figures?.given ?? 0)} %</span>
                  </div>
                </li>
              </ul>
            </div>
          )}
        </div>
      </ListWithPanel>

      {!panelFits && selected && (
        <Modal
          open
          passiveModal
          size="md"
          modalHeading="Group budget"
          onRequestClose={() => {
            setSelectedId(null);
            window.setTimeout(() => rowOpener.current?.focus(), 0);
          }}
        >
          {panel}
        </Modal>
      )}
      {dialog.value && <PeriodDialog mode={dialog.value} period={period} previous={period} onClose={dialog.close} />}
    </PageShell>
  );
}

function SharePanel({ period, entry }: { period: WorkingGroupBudgetPeriod; entry: WorkingGroupGroupBudget }) {
  const [given, setGiven] = useState(moneyInputText(toCents(entry.given)));
  const [touched, setTouched] = useState(false);
  const cents = parseMoneyInput(given);
  const save = useWgMutation(() =>
    setWorkingGroupBudgetShare(period.id, entry.groupId, { amount: fromCents(cents ?? 0) }),
  );
  const used = toCents(entry.spent) + toCents(entry.reserved);
  const unchanged = cents === toCents(entry.given);
  return (
    <DetailPanel>
      <DetailPanelHead title={entry.groupName} meta={`Budget · ${period.name}`} />
      {save.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not saved"
          subtitle={taskErrorText(save.error, 'Try again.')}
        />
      )}
      <Stack gap={4}>
        <TextInput
          id={`wg-given-${entry.groupId}`}
          labelText="Given"
          inputMode="decimal"
          readOnly={period.closed}
          value={given}
          invalid={touched && cents === null}
          invalidText="Enter an amount."
          onChange={(event) => setGiven(event.target.value)}
        />
        <div className="wg-panel-actions">
          <CarbonLink as={Link} to={`/working-groups/purchases?group=${entry.groupId}`}>
            Open purchases
          </CarbonLink>
          <Button
            kind="primary"
            size="md"
            disabled={period.closed || save.isPending || unchanged}
            onClick={() => {
              setTouched(true);
              if (cents !== null) save.mutate();
            }}
          >
            Save
          </Button>
        </div>
      </Stack>
      <FactsGrid columns={2}>
        <Fact label="Spent">{formatCents(toCents(entry.spent))}</Fact>
        <Fact label="Reserved">{formatCents(toCents(entry.reserved))}</Fact>
        <Fact label="Free">{formatCents(toCents(entry.free))}</Fact>
        <Fact label="Used">{percent(used, toCents(entry.given))} %</Fact>
      </FactsGrid>
    </DetailPanel>
  );
}

interface PeriodValues {
  name: string;
  startsOn: string;
  endsOn: string;
  total: string;
  copy: boolean;
}

function PeriodDialog({
  mode,
  period,
  previous,
  onClose,
}: {
  mode: 'edit' | 'new';
  period: WorkingGroupBudgetPeriod | undefined;
  previous: WorkingGroupBudgetPeriod | undefined;
  onClose: () => void;
}) {
  const editing = mode === 'edit' && period !== undefined;
  const [confirmClose, setConfirmClose] = useState(false);
  const { control, handleSubmit, register } = useForm<PeriodValues>({
    defaultValues: {
      name: editing ? period.name : '',
      startsOn: editing ? period.startsOn : '',
      endsOn: editing ? period.endsOn : '',
      total: editing ? moneyInputText(toCents(period.totalAmount)) : '',
      copy: false,
    },
  });
  const save = useWgMutation((values: PeriodValues) => {
    const totalAmount = fromCents(parseMoneyInput(values.total) ?? 0);
    return editing
      ? updateWorkingGroupBudgetPeriod(period.id, {
          expectedVersion: period.version,
          name: values.name.trim(),
          startsOn: values.startsOn,
          endsOn: values.endsOn,
          totalAmount,
        })
      : createWorkingGroupBudgetPeriod({
          name: values.name.trim(),
          startsOn: values.startsOn,
          endsOn: values.endsOn,
          totalAmount,
          copySharesFromPeriodId: values.copy && previous ? previous.id : undefined,
        });
  });
  const close = useWgMutation(() =>
    closeWorkingGroupBudgetPeriod(period?.id ?? '', { expectedVersion: period?.version ?? 0 }),
  );
  const submit = handleSubmit((values) => save.mutate(values, { onSuccess: onClose }));
  const failure = save.isError ? (saveErrorText(save.error) ?? 'Not saved.') : undefined;
  return (
    <Modal
      open
      size="sm"
      modalHeading={editing ? 'Edit period' : 'New budget period'}
      primaryButtonText={save.isPending ? 'Saving…' : editing ? 'Save' : 'Create'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending || (editing && period.closed)}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={onClose}
      onRequestSubmit={() => void submit()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap={5}>
          {failure && (
            <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={failure} />
          )}
          <TextInput
            id="wg-period-name"
            labelText="Name"
            {...register('name', { validate: (value) => value.trim() !== '' || 'Enter a name.' })}
          />
          <Controller
            control={control}
            name="startsOn"
            rules={{ required: true }}
            render={({ field, fieldState }) => (
              <DateInput
                id="wg-period-from"
                labelText="From"
                value={field.value}
                invalid={Boolean(fieldState.error)}
                invalidText="Choose a date."
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={control}
            name="endsOn"
            rules={{ required: true }}
            render={({ field, fieldState }) => (
              <DateInput
                id="wg-period-until"
                labelText="Until"
                value={field.value}
                invalid={Boolean(fieldState.error)}
                invalidText="Choose a date."
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={control}
            name="total"
            rules={{ validate: (value) => parseMoneyInput(value) !== null || 'Enter an amount.' }}
            render={({ field, fieldState }) => (
              <TextInput
                id="wg-period-total"
                labelText="Budget from HTU"
                inputMode="decimal"
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          {!editing && previous && (
            <Controller
              control={control}
              name="copy"
              render={({ field }) => (
                <Checkbox
                  id="wg-period-copy"
                  labelText={`Start with the shares of ${previous.name}`}
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
          )}
          {editing && !period.closed && (
            <div>
              {confirmClose ? (
                <>
                  <p>Closed periods cannot be changed.</p>
                  <Button
                    kind="danger"
                    size="md"
                    disabled={close.isPending}
                    onClick={() => close.mutate(undefined, { onSuccess: onClose })}
                  >
                    Close this period for good
                  </Button>
                </>
              ) : (
                <Button kind="danger--ghost" size="md" onClick={() => setConfirmClose(true)}>
                  Close this period
                </Button>
              )}
              {close.isError && (
                <p className="wg-buyrow__error">{taskErrorText(close.error, 'It could not be closed.')}</p>
              )}
            </div>
          )}
        </Stack>
      </form>
    </Modal>
  );
}
