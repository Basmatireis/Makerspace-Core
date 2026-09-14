import { useEffect, useState } from 'react';
import { Add, Edit, TrashCan } from '@carbon/icons-react';
import {
  Button,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  createOpenDayAcademicBreak,
  deleteOpenDayAcademicBreak,
  getOpenDayCalendarContext,
  updateOpenDayAcademicBreak,
  updateOpenDayPeriod,
} from '../../api/generated/open-days/open-days';
import type { AcademicBreak, OpenDayPeriod } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { periodRange, statusTagType } from './format';
import { openDaySchedulePath } from './paths';
import { openDayKeys, periodsQueryOptions } from './queries';

type PeriodDraft = Pick<OpenDayPeriod, 'id' | 'name' | 'startsOn' | 'endsOn' | 'version'>;
type BreakDraft = Pick<AcademicBreak, 'id' | 'name' | 'startsOn' | 'endsOn' | 'version'>;

const emptyBreak: BreakDraft = {
  id: '',
  name: '',
  startsOn: '',
  endsOn: '',
  version: 0,
};

export function OpenDayManagementPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const periodsQuery = useQuery(periodsQueryOptions());
  const [selectedPeriodId, setSelectedPeriodId] = useState('');
  const [periodDraft, setPeriodDraft] = useState<PeriodDraft | null>(null);
  const [breakDraft, setBreakDraft] = useState<BreakDraft | null>(null);
  const [deleteBreak, setDeleteBreak] = useState<AcademicBreak | null>(null);

  useEffect(() => {
    if (!selectedPeriodId && periodsQuery.data?.items[0]) {
      setSelectedPeriodId(periodsQuery.data.items[0].id);
    }
  }, [periodsQuery.data, selectedPeriodId]);

  const contextQuery = useQuery({
    queryKey: [...openDayKeys.all, 'calendar-context', selectedPeriodId],
    queryFn: ({ signal }) => getOpenDayCalendarContext(selectedPeriodId, { signal }),
    enabled: Boolean(selectedPeriodId),
  });
  const periodMutation = useMutation({
    mutationFn: (value: PeriodDraft) =>
      updateOpenDayPeriod(value.id, {
        name: value.name,
        startsOn: value.startsOn,
        endsOn: value.endsOn,
        expectedVersion: value.version,
      }),
    onSuccess: async () => {
      setPeriodDraft(null);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
    },
  });
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
      await queryClient.invalidateQueries({
        queryKey: [...openDayKeys.all, 'calendar-context'],
      });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (value: AcademicBreak) =>
      deleteOpenDayAcademicBreak(value.id, { expectedVersion: value.version }),
    onSuccess: async () => {
      setDeleteBreak(null);
      await queryClient.invalidateQueries({
        queryKey: [...openDayKeys.all, 'calendar-context'],
      });
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

  const selectedPeriod = periodsQuery.data.items.find(
    (item) => item.id === selectedPeriodId,
  );
  const mutationFailed =
    periodMutation.isError || breakMutation.isError || deleteMutation.isError;

  return (
    <Stack gap={7} className="open-day-management-page">
      <PageHeader
        title="Manage Open Days"
        breadcrumbs={[{ label: 'Open Days', to: '/open-days' }]}
        description="Edit draft period metadata and maintain academic breaks used by schedule planning."
      />
      {mutationFailed && (
        <InlineNotification
          kind="error"
          lowContrast
          title="Change was not saved"
          subtitle="The record may have changed. Reload and try again."
        />
      )}
      <section aria-labelledby="managed-periods-heading">
        <h2 id="managed-periods-heading">Periods</h2>
        <div className="managed-period-list">
          {periodsQuery.data.items.map((item) => (
            <div className="managed-period" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <p>{periodRange(item)}</p>
              </div>
              <Tag type={statusTagType(item.status)}>{item.status}</Tag>
              <div className="managed-period__actions">
                {item.status === 'draft' && (
                  <Button
                    kind="ghost"
                    size="sm"
                    renderIcon={Edit}
                    onClick={() => setPeriodDraft(item)}
                  >
                    Edit metadata
                  </Button>
                )}
                {item.status !== 'archived' && <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => navigate(openDaySchedulePath(item.id))}>Edit period</Button>}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="academic-breaks-heading">
        <div className="management-section-heading">
          <div>
            <h2 id="academic-breaks-heading">Academic breaks</h2>
            <p>Breaks are inclusive and may span multiple days.</p>
          </div>
          <Button
            renderIcon={Add}
            disabled={!selectedPeriod}
            onClick={() =>
              setBreakDraft({
                ...emptyBreak,
                startsOn: selectedPeriod?.startsOn ?? '',
                endsOn: selectedPeriod?.startsOn ?? '',
              })
            }
          >
            New academic break
          </Button>
        </div>
        <Select
          id="academic-break-period"
          labelText="Show breaks overlapping period"
          value={selectedPeriodId}
          onChange={(event) => setSelectedPeriodId(event.target.value)}
        >
          {periodsQuery.data.items.map((item) => (
            <SelectItem key={item.id} value={item.id} text={item.name} />
          ))}
        </Select>
        {contextQuery.isPending && selectedPeriodId && (
          <InlineLoadingState label="Loading academic breaks" />
        )}
        {contextQuery.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            title="Academic breaks could not be loaded"
            subtitle="Try selecting the period again."
          />
        )}
        {contextQuery.data && (
          <TableContainer title={`Academic breaks · ${selectedPeriod?.name ?? ''}`}>
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader>Start</TableHeader>
                  <TableHeader>End</TableHeader>
                  <TableHeader>Actions</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {contextQuery.data.academicBreaks.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.name}</TableCell>
                    <TableCell>{item.startsOn}</TableCell>
                    <TableCell>{item.endsOn}</TableCell>
                    <TableCell>
                      <div className="table-actions">
                        <Button
                          hasIconOnly
                          kind="ghost"
                          size="sm"
                          renderIcon={Edit}
                          iconDescription={`Edit ${item.name}`}
                          onClick={() => setBreakDraft(item)}
                        />
                        <Button
                          hasIconOnly
                          kind="danger--ghost"
                          size="sm"
                          renderIcon={TrashCan}
                          iconDescription={`Delete ${item.name}`}
                          onClick={() => setDeleteBreak(item)}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {contextQuery.data.academicBreaks.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>No academic breaks overlap this period.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>
      <Modal
        open={Boolean(periodDraft)}
        modalHeading="Edit draft period"
        primaryButtonText="Save period"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={periodMutation.isPending}
        onRequestClose={() => setPeriodDraft(null)}
        onRequestSubmit={() => periodDraft && periodMutation.mutate(periodDraft)}
      >
        {periodDraft && (
          <Stack gap={5}>
            <TextInput id="managed-period-name" labelText="Name" value={periodDraft.name} onChange={(event) => setPeriodDraft({ ...periodDraft, name: event.target.value })} />
            <TextInput id="managed-period-start" type="date" labelText="Start date" value={periodDraft.startsOn} onChange={(event) => setPeriodDraft({ ...periodDraft, startsOn: event.target.value })} />
            <TextInput id="managed-period-end" type="date" labelText="End date" value={periodDraft.endsOn} onChange={(event) => setPeriodDraft({ ...periodDraft, endsOn: event.target.value })} />
          </Stack>
        )}
      </Modal>
      <Modal
        open={Boolean(breakDraft)}
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
            <TextInput id="academic-break-start" type="date" labelText="Start date" value={breakDraft.startsOn} onChange={(event) => setBreakDraft({ ...breakDraft, startsOn: event.target.value })} />
            <TextInput id="academic-break-end" type="date" labelText="End date" value={breakDraft.endsOn} onChange={(event) => setBreakDraft({ ...breakDraft, endsOn: event.target.value })} />
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
    </Stack>
  );
}
