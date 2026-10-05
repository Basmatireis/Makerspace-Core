import { useState } from 'react';
import { Add } from '@carbon/icons-react';
import {
  Button,
  DataTable,
  DatePicker,
  DatePickerInput,
  InlineNotification,
  Modal,
  MultiSelect,
  OverflowMenu,
  OverflowMenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createOpenDayAcademicBreak,
  deleteOpenDayAcademicBreak,
  updateOpenDayAcademicBreak,
} from '../../api/generated/open-days/open-days';
import type { AcademicBreak } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import {
  APP_DATE_PLACEHOLDER,
  dateOnlyToPickerDate,
  formatDate,
  parseDisplayDate,
  pickerDateToDateOnly,
} from '../../app/dateTime';
import { academicBreaksQueryOptions, openDayKeys, periodsQueryOptions } from './queries';

type BreakDraft = Pick<AcademicBreak, 'id' | 'name' | 'startsOn' | 'endsOn' | 'version'>;

const emptyBreak: BreakDraft = {
  id: '',
  name: '',
  startsOn: '',
  endsOn: '',
  version: 0,
};

const academicBreakHeaders = [
  { key: 'name', header: 'Name' },
  { key: 'startsOn', header: 'Start' },
  { key: 'endsOn', header: 'End' },
  { key: 'actions', header: 'Actions' },
];

export function OpenDayManagementPage() {
  const queryClient = useQueryClient();
  const periodsQuery = useQuery(periodsQueryOptions());
  const breaksQuery = useQuery(academicBreaksQueryOptions());
  const [selectedPeriodIds, setSelectedPeriodIds] = useState<string[]>([]);
  const [breakDraft, setBreakDraft] = useState<BreakDraft | null>(null);
  const [deleteBreak, setDeleteBreak] = useState<AcademicBreak | null>(null);
  const breakMutation = useMutation({
    mutationFn: (value: BreakDraft) =>
      value.id
        ? updateOpenDayAcademicBreak(value.id, {
            name: value.name,
            startsOn: value.startsOn,
            endsOn: value.endsOn,
            expectedVersion: value.version,
          })
        : createOpenDayAcademicBreak({
            name: value.name,
            startsOn: value.startsOn,
            endsOn: value.endsOn,
          }),
    onSuccess: async () => {
      setBreakDraft(null);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (value: AcademicBreak) =>
      deleteOpenDayAcademicBreak(value.id, { expectedVersion: value.version }),
    onSuccess: async () => {
      setDeleteBreak(null);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
    },
  });

  if (periodsQuery.isPending) {
    return <InlineLoadingState label="Loading Open Day management" />;
  }
  if (periodsQuery.isError || !periodsQuery.data) {
    return (
      <ErrorState
        title="Unable to load Open Day management"
        message="Check the connection and try again."
        onRetry={() => void periodsQuery.refetch()}
      />
    );
  }

  const selectedPeriods = periodsQuery.data.items.filter((item) =>
    selectedPeriodIds.includes(item.id),
  );
  const mutationFailed =
    breakMutation.isError || deleteMutation.isError;
  const allAcademicBreaks = breaksQuery.data?.items ?? [];
  const academicBreaks = selectedPeriods.length === 0
    ? allAcademicBreaks
    : allAcademicBreaks.filter((item) => selectedPeriods.some(
        (period) => item.startsOn <= period.endsOn && item.endsOn >= period.startsOn,
      ));
  const academicBreaksById = new Map(academicBreaks.map((item) => [item.id, item]));
  const rows = academicBreaks.map((item) => ({
    id: item.id,
    name: item.name,
    startsOn: formatDate(item.startsOn),
    endsOn: formatDate(item.endsOn),
    actions: '',
  }));

  return (
    <PageShell
      title="Academic breaks"
      breadcrumbs={[{ label: 'Open Days', to: '/open-days' }]}
      description="Maintain lecture-free date ranges used as context during schedule planning."
      className="open-day-management-page"
    >
      {mutationFailed && (
        <InlineNotification
          kind="error"
          lowContrast
          title="Change was not saved"
          subtitle="The record may have changed. Reload and try again."
        />
      )}
      <section className="academic-breaks-section" aria-labelledby="academic-breaks-heading">
        <h2 id="academic-breaks-heading" className="open-days-section-title">Academic breaks</h2>
        <TableContainer className="academic-breaks-table">
          <TableToolbar aria-label="Academic breaks table toolbar">
            <TableToolbarContent>
              <MultiSelect
                id="academic-break-period"
                className="academic-breaks-table__period-filter"
                titleText="Show breaks overlapping periods"
                hideLabel
                size="md"
                label="All periods"
                items={periodsQuery.data.items}
                itemToString={(item) => item?.name ?? ''}
                selectedItems={selectedPeriods}
                onChange={({ selectedItems }) =>
                  setSelectedPeriodIds((selectedItems ?? []).map((item) => item.id))
                }
              />
              <Button
                renderIcon={Add}
                onClick={() =>
                  setBreakDraft({
                    ...emptyBreak,
                    startsOn: selectedPeriods[0]?.startsOn ?? '',
                    endsOn: selectedPeriods[0]?.startsOn ?? '',
                  })
                }
              >
                Create
              </Button>
            </TableToolbarContent>
          </TableToolbar>
          {breaksQuery.isPending && (
            <InlineLoadingState label="Loading academic breaks" />
          )}
          {breaksQuery.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              title="Academic breaks could not be loaded"
              subtitle="Try again."
            />
          )}
          {breaksQuery.data && (
            <DataTable
              key={rows.map((row) => row.id).join('|')}
              rows={rows}
              headers={academicBreakHeaders}
              isSortable
            >
              {({ rows: tableRows, headers, getHeaderProps, getRowProps, getTableProps }) => (
                <>
                  <Table {...getTableProps()} size="lg" aria-label="Academic breaks">
                    <TableHead>
                      <TableRow>
                        {headers.map((header) => (
                          <TableHeader
                            {...getHeaderProps({
                              header,
                              isSortable: header.key !== 'actions',
                            })}
                            key={header.key}
                            className={
                              header.key === 'actions'
                                ? 'academic-breaks-table__actions-column'
                                : undefined
                            }
                          >
                            {header.header}
                          </TableHeader>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {tableRows.map((row) => {
                        const item = academicBreaksById.get(row.id);
                        if (!item) return null;
                        return (
                          <TableRow {...getRowProps({ row })} key={row.id}>
                            {row.cells.map((cell) => (
                              <TableCell
                                key={cell.id}
                                className={
                                  cell.info.header === 'actions'
                                    ? 'academic-breaks-table__actions-column'
                                    : undefined
                                }
                              >
                                {cell.info.header === 'actions' ? (
                                  <OverflowMenu
                                    iconDescription={`Actions for ${item.name}`}
                                    size="sm"
                                    flipped
                                  >
                                    <OverflowMenuItem
                                      itemText="Edit"
                                      onClick={() => setBreakDraft(item)}
                                    />
                                    <OverflowMenuItem
                                      isDelete
                                      itemText="Delete"
                                      onClick={() => setDeleteBreak(item)}
                                    />
                                  </OverflowMenu>
                                ) : String(cell.value)}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {academicBreaks.length === 0 && (
                    <div className="empty-state">
                      <h3>No academic breaks</h3>
                      <p>
                        {selectedPeriods.length === 0
                          ? 'No academic breaks have been created yet.'
                          : 'No academic breaks overlap the selected periods.'}
                      </p>
                    </div>
                  )}
                </>
              )}
            </DataTable>
          )}
        </TableContainer>
      </section>
      <Modal
        open={Boolean(breakDraft)}
        size="xs"
        modalHeading={breakDraft?.id ? 'Edit academic break' : 'Create academic break'}
        primaryButtonText={breakDraft?.id ? 'Save break' : 'Create break'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={breakMutation.isPending || !breakDraft?.name.trim() || !breakDraft.startsOn || !breakDraft.endsOn}
        onRequestClose={() => setBreakDraft(null)}
        onRequestSubmit={() => breakDraft && breakMutation.mutate(breakDraft)}
      >
        {breakDraft && (
          <Stack gap={5}>
            <TextInput id="academic-break-name" labelText="Name" value={breakDraft.name} onChange={(event) => setBreakDraft({ ...breakDraft, name: event.target.value })} />
            <DatePicker
              allowInput
              datePickerType="range"
              dateFormat="d.m.Y"
              locale="en"
              value={breakDraft.startsOn
                ? [
                    dateOnlyToPickerDate(breakDraft.startsOn)!,
                    ...(breakDraft.endsOn
                      ? [dateOnlyToPickerDate(breakDraft.endsOn)!]
                      : []),
                  ]
                : []}
              onChange={(dates) => setBreakDraft({
                ...breakDraft,
                startsOn: dates[0] ? pickerDateToDateOnly(dates[0]) : '',
                endsOn: dates[1] ? pickerDateToDateOnly(dates[1]) : '',
              })}
            >
              <DatePickerInput
                id="academic-break-start"
                labelText="Start date"
                placeholder={APP_DATE_PLACEHOLDER}
                pattern="\d{2}\.\d{2}\.\d{4}"
                onChange={(event) => {
                  const value = event.target.value;
                  const startsOn = parseDisplayDate(value);
                  if (startsOn || !value) {
                    setBreakDraft({ ...breakDraft, startsOn: startsOn ?? '' });
                  }
                }}
              />
              <DatePickerInput
                id="academic-break-end"
                labelText="End date"
                placeholder={APP_DATE_PLACEHOLDER}
                pattern="\d{2}\.\d{2}\.\d{4}"
                onChange={(event) => {
                  const value = event.target.value;
                  const endsOn = parseDisplayDate(value);
                  if (endsOn || !value) {
                    setBreakDraft({ ...breakDraft, endsOn: endsOn ?? '' });
                  }
                }}
              />
            </DatePicker>
          </Stack>
        )}
      </Modal>
      <Modal
        open={Boolean(deleteBreak)}
        danger
        modalHeading="Delete academic break?"
        primaryButtonText="Delete break"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={deleteMutation.isPending}
        onRequestClose={() => setDeleteBreak(null)}
        onRequestSubmit={() => deleteBreak && deleteMutation.mutate(deleteBreak)}
      >
        <p>{deleteBreak?.name} will no longer appear as calendar context. Existing Open Days are unchanged.</p>
      </Modal>
    </PageShell>
  );
}
