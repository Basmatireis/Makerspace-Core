import {
  Button,
  ComboBox,
  DataTable,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type {
  Person,
  SubjectRequest,
  SubjectRequestAssessment,
  SubjectRequestChannel,
  SubjectRequestKind,
  SubjectRequestOutcome,
  SubjectRequestStatus,
  SubjectRequestTransitionInputStatus,
} from '../../api/generated/models';
import {
  createSubjectRequest,
  executeSubjectRequest,
  downloadSubjectRequestExport,
  transitionSubjectRequest,
} from '../../api/generated/privacy/privacy';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import {
  formatDateTime,
  instantToZonedDateTimeValue,
  isZonedDateTimeValue,
  zonedDateTimeValueToISO,
} from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { saveBlob } from '../configtransfer/helpers';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import { peopleListOptions } from '../users/queries';
import { errorCode, privacyErrorMessage, privacyQueryKey, subjectRequestsQueryOptions } from './privacy';

const headers = [
  { key: 'reference', header: 'Reference' },
  { key: 'kind', header: 'Kind' },
  { key: 'status', header: 'Status' },
  { key: 'person', header: 'Person' },
  { key: 'received', header: 'Received' },
  { key: 'due', header: 'Due' },
];

const kindLabels: Record<SubjectRequestKind, string> = { access: 'Access', erasure: 'Erasure' };

const statusLabels: Record<SubjectRequestStatus, string> = {
  received: 'Received',
  identity_verified: 'Identity verified',
  assessed: 'Assessed',
  approved: 'Approved',
  executing: 'Executing',
  completed: 'Completed',
  partially_completed: 'Partially completed',
  rejected: 'Rejected',
};

const statusTagTypes: Record<
  SubjectRequestStatus,
  'gray' | 'blue' | 'teal' | 'cyan' | 'purple' | 'green' | 'magenta' | 'red'
> = {
  received: 'gray',
  identity_verified: 'blue',
  assessed: 'teal',
  approved: 'cyan',
  executing: 'purple',
  completed: 'green',
  partially_completed: 'magenta',
  rejected: 'red',
};

const outcomeLabels: Record<SubjectRequestOutcome, string> = {
  erased: 'Erased',
  unlinked: 'Unlinked',
  retained_legal: 'Retained (legal)',
  manual_review: 'Manual review',
};

const channelLabels: Record<SubjectRequestChannel, string> = {
  email: 'Email',
  in_person: 'In person',
  letter: 'Letter',
  other: 'Other',
};

const closedStatuses: readonly SubjectRequestStatus[] = ['completed', 'partially_completed', 'rejected'];
const rejectableStatuses: readonly SubjectRequestStatus[] = ['received', 'identity_verified', 'assessed', 'approved'];

function isOverdue(request: SubjectRequest): boolean {
  return !closedStatuses.includes(request.status) && new Date(request.dueAt).getTime() < Date.now();
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : '—';
}

function personName(person: Person): string {
  return `${person.firstName} ${person.lastName}`;
}

type RequestFormValues = {
  kind: SubjectRequestKind;
  person: Person | null;
  channel: SubjectRequestChannel;
  receivedAt: string;
  reference: string;
  notes: string;
};

function RecordRequestModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const candidates = useQuery({ ...peopleListOptions({ search, pageSize: 25 }), placeholderData: keepPreviousData });
  const form = useForm<RequestFormValues>({
    defaultValues: {
      kind: 'access',
      person: null,
      channel: 'email',
      receivedAt: instantToZonedDateTimeValue(new Date()),
      reference: '',
      notes: '',
    },
  });
  const { control, register, setValue, watch, formState } = form;
  const kind = watch('kind');
  const mutation = useMutation({
    mutationFn: (values: RequestFormValues) =>
      createSubjectRequest({
        kind: values.kind,
        personId: values.person!.id,
        channel: values.channel,
        receivedAt: zonedDateTimeValueToISO(values.receivedAt),
        ...(values.reference.trim() ? { reference: values.reference.trim() } : {}),
        ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: privacyQueryKey });
      onClose();
    },
  });
  const submit = form.handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values);
    } catch {
      /* rendered in the dialog */
    }
  });

  return (
    <Modal
      open
      size="md"
      modalHeading="Record request"
      primaryButtonText={mutation.isPending ? 'Recording…' : 'Record request'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      onRequestSubmit={() => void submit()}
    >
      <Stack gap={5}>
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Request not recorded"
            subtitle={privacyErrorMessage(mutation.error)}
          />
        )}
        <RadioButtonGroup
          legendText="Kind of request"
          name="request-kind"
          orientation="vertical"
          valueSelected={kind}
          onChange={(value) => setValue('kind', value as SubjectRequestKind)}
        >
          <RadioButton id="request-kind-access" value="access" labelText="Access (copy of the data)" />
          <RadioButton id="request-kind-erasure" value="erasure" labelText="Erasure" />
        </RadioButtonGroup>
        <Controller
          control={control}
          name="person"
          rules={{ validate: (value) => value !== null || 'Choose the person.' }}
          render={({ field }) => (
            <ComboBox
              id="request-person"
              titleText="Person"
              placeholder="Search people"
              items={candidates.data?.items ?? []}
              itemToString={(item) => (item ? personName(item) : '')}
              shouldFilterItem={() => true}
              selectedItem={field.value}
              invalid={Boolean(formState.errors.person)}
              invalidText={formState.errors.person?.message}
              onInputChange={setSearch}
              onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)}
            />
          )}
        />
        <Select id="request-channel" labelText="Channel" {...register('channel')}>
          {(Object.keys(channelLabels) as SubjectRequestChannel[]).map((channel) => (
            <SelectItem key={channel} value={channel} text={channelLabels[channel]} />
          ))}
        </Select>
        <TextInput
          id="request-received-at"
          type="datetime-local"
          labelText="Received"
          invalid={Boolean(formState.errors.receivedAt)}
          invalidText={formState.errors.receivedAt?.message}
          {...register('receivedAt', {
            validate: (value) => isZonedDateTimeValue(value) || 'Enter the date and time of receipt.',
          })}
        />
        <TextInput
          id="request-reference"
          labelText="Reference"
          helperText="Your own reference, never the name of the person."
          maxLength={100}
          {...register('reference')}
        />
        <TextArea id="request-notes" labelText="Notes" maxLength={2000} rows={3} {...register('notes')} />
      </Stack>
    </Modal>
  );
}

function NoteModal({
  title,
  label,
  confirmLabel,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  confirmLabel: string;
  pending: boolean;
  error: string | undefined;
  onSubmit: (note: string) => void;
  onClose: () => void;
}) {
  const form = useForm<{ note: string }>({ defaultValues: { note: '' } });
  const submit = form.handleSubmit((values) => onSubmit(values.note.trim()));
  return (
    <Modal
      open
      size="sm"
      modalHeading={title}
      primaryButtonText={pending ? `${confirmLabel}…` : confirmLabel}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      onRequestSubmit={() => void submit()}
    >
      <Stack gap={5}>
        {error && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Action failed" subtitle={error} />
        )}
        <TextArea
          id="request-note"
          labelText={label}
          maxLength={1000}
          rows={3}
          invalid={Boolean(form.formState.errors.note)}
          invalidText={form.formState.errors.note?.message}
          {...form.register('note', { validate: (value) => value.trim() !== '' || 'This field is required.' })}
        />
      </Stack>
    </Modal>
  );
}

function AssessmentView({ title, assessment }: { title: string; assessment: SubjectRequestAssessment }) {
  return (
    <Stack gap={3}>
      <h4 className="cds--type-productive-heading-02">{title}</h4>
      <Table size="sm" aria-label={title}>
        <TableHead>
          <TableRow>
            <TableHeader>Category</TableHeader>
            <TableHeader>Records</TableHeader>
            <TableHeader>Outcome</TableHeader>
            <TableHeader>Note</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {assessment.categories.map((category) => (
            <TableRow key={category.categoryId}>
              <TableCell>{category.name}</TableCell>
              <TableCell>{category.records}</TableCell>
              <TableCell>
                {category.outcome ? (
                  <Tag
                    type={category.outcome === 'erased' || category.outcome === 'unlinked' ? 'green' : 'warm-gray'}
                    size="sm"
                  >
                    {outcomeLabels[category.outcome]}
                  </Tag>
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell>{category.note}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {assessment.blockers.length > 0 && (
        <div>
          <p className="cds--type-label-01">Blockers</p>
          {assessment.blockers.map((blocker) => (
            <Tag key={blocker} type="red" size="sm">
              {blocker}
            </Tag>
          ))}
        </div>
      )}
      <p className="cds--type-helper-text-01">Open holds: {assessment.openHolds}</p>
      {assessment.uncoveredCategories.length > 0 && (
        <div>
          <p className="cds--type-label-01">Uncovered categories (no handler)</p>
          {assessment.uncoveredCategories.map((id) => (
            <Tag key={id} type="warm-gray" size="sm">
              {id}
            </Tag>
          ))}
        </div>
      )}
    </Stack>
  );
}

type Dialog = 'verify' | 'reject' | 'execute';

function RequestDetail({ request, canExecute }: { request: SubjectRequest; canExecute: boolean }) {
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>();

  const settle = async () => {
    await client.invalidateQueries({ queryKey: privacyQueryKey });
  };
  const transition = useMutation({
    mutationFn: (input: { status: SubjectRequestTransitionInputStatus; note?: string }) =>
      transitionSubjectRequest(request.id, {
        status: input.status,
        ...(input.note ? { note: input.note } : {}),
        expectedVersion: request.version,
      }),
    onSuccess: async () => {
      setDialog(undefined);
      await settle();
    },
    onError: () => void settle(),
  });
  const download = useMutation({
    // Through the API client, so an expired fresh sign-in opens the re-authentication dialog instead of a JSON page.
    mutationFn: () => downloadSubjectRequestExport(request.id),
    onSuccess: (blob) => saveBlob(blob, `subject-request-${request.id}.zip`),
  });
  const execute = useMutation({
    mutationFn: () => executeSubjectRequest(request.id, { expectedVersion: request.version }),
    onSuccess: async () => {
      setDialog(undefined);
      await settle();
    },
    onError: () => void settle(),
  });

  const status = request.status;
  const error = transition.isError
    ? transition.error
    : execute.isError
      ? execute.error
      : download.isError
        ? download.error
        : undefined;
  const busy = transition.isPending || execute.isPending;
  const open = (next: Dialog) => {
    transition.reset();
    execute.reset();
    setDialog(next);
  };
  const run = (next: SubjectRequestTransitionInputStatus) => {
    execute.reset();
    transition.mutate({ status: next });
  };
  const closeDialog = () => setDialog(undefined);
  const dialogError = error ? privacyErrorMessage(error) : undefined;

  return (
    <Stack gap={5}>
      {error && (
        <InlineNotification
          kind={errorCode(error) === 'stale_write' ? 'warning' : 'error'}
          lowContrast
          hideCloseButton
          title={errorCode(error) ?? 'Action failed'}
          subtitle={privacyErrorMessage(error)}
        />
      )}
      <div>
        {status === 'received' && (
          <Button size="sm" kind="tertiary" disabled={busy} onClick={() => open('verify')}>
            Verify identity
          </Button>
        )}
        {(status === 'identity_verified' || status === 'assessed') && (
          <Button size="sm" kind="tertiary" disabled={busy} onClick={() => run('assessed')}>
            Assess
          </Button>
        )}
        {status === 'assessed' && (
          <Button size="sm" kind="tertiary" disabled={busy} onClick={() => run('approved')}>
            Approve
          </Button>
        )}
        {rejectableStatuses.includes(status) && (
          <Button size="sm" kind="danger--tertiary" disabled={busy} onClick={() => open('reject')}>
            Reject
          </Button>
        )}
        {status === 'approved' && canExecute && (
          <Button size="sm" kind="danger" disabled={busy} onClick={() => open('execute')}>
            Execute
          </Button>
        )}
        {canExecute &&
          request.kind === 'access' &&
          (status === 'completed' || status === 'partially_completed') &&
          request.exportAvailable && (
            <Button size="sm" kind="tertiary" disabled={download.isPending} onClick={() => download.mutate()}>
              {download.isPending ? 'Downloading…' : 'Download export'}
            </Button>
          )}
      </div>
      {request.rejectionReason && <p>Rejection reason: {request.rejectionReason}</p>}
      {request.notes && <p className="cds--type-helper-text-01">Notes: {request.notes}</p>}
      <StructuredListWrapper isCondensed aria-label="Request steps">
        <StructuredListHead>
          <StructuredListRow head>
            <StructuredListCell head>Step</StructuredListCell>
            <StructuredListCell head>Time</StructuredListCell>
            <StructuredListCell head>Note</StructuredListCell>
          </StructuredListRow>
        </StructuredListHead>
        <StructuredListBody>
          {request.steps.map((step, index) => (
            <StructuredListRow key={`${step.status}-${index}`}>
              <StructuredListCell>
                <Tag type={statusTagTypes[step.status]} size="sm">
                  {statusLabels[step.status]}
                </Tag>
              </StructuredListCell>
              <StructuredListCell>{formatDateTime(step.occurredAt)}</StructuredListCell>
              <StructuredListCell>{step.note}</StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {request.assessment && <AssessmentView title="Assessment" assessment={request.assessment} />}
      {request.result && <AssessmentView title="Result" assessment={request.result} />}
      {dialog === 'verify' && (
        <NoteModal
          title="Verify identity"
          label="How was the identity verified?"
          confirmLabel="Verify identity"
          pending={transition.isPending}
          error={dialogError}
          onSubmit={(note) => transition.mutate({ status: 'identity_verified', note })}
          onClose={closeDialog}
        />
      )}
      {dialog === 'reject' && (
        <NoteModal
          title="Reject request"
          label="Reason"
          confirmLabel="Reject"
          pending={transition.isPending}
          error={dialogError}
          onSubmit={(note) => transition.mutate({ status: 'rejected', note })}
          onClose={closeDialog}
        />
      )}
      {dialog === 'execute' && request.kind === 'erasure' && (
        <DestructiveActionDialog
          open
          title="Execute erasure"
          confirmLabel="Erase data"
          pending={execute.isPending}
          error={dialogError}
          onClose={closeDialog}
          onConfirm={() => execute.mutate()}
        >
          <p>
            This erases or unlinks the data of the person in every category as assessed. It cannot be undone. Records
            kept for a legal obligation are retained.
          </p>
        </DestructiveActionDialog>
      )}
      {dialog === 'execute' && request.kind === 'access' && (
        <Modal
          open
          size="sm"
          modalHeading="Execute access request"
          primaryButtonText={execute.isPending ? 'Executing…' : 'Execute'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={execute.isPending}
          preventCloseOnClickOutside
          onRequestClose={closeDialog}
          onSecondarySubmit={closeDialog}
          onRequestSubmit={() => execute.mutate()}
        >
          <Stack gap={5}>
            {dialogError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Action failed"
                subtitle={dialogError}
              />
            )}
            <p>Build the export with the data of the person as a ZIP file for download.</p>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}

export function RequestsTab() {
  const currentUser = useCurrentUser();
  const canExecute = hasPermission(currentUser, 'privacy.requests.execute');
  const requests = useQuery(subjectRequestsQueryOptions());
  const [recording, setRecording] = useState(false);

  if (requests.isPending) return <SettingsLoading label="Loading data requests" />;
  if (requests.isError) return <ErrorState message={requests.error.message} onRetry={() => void requests.refetch()} />;

  const byId = new Map(requests.data.requests.map((request) => [request.id as string, request]));
  const rows = requests.data.requests.map((request) => ({ id: request.id as string }));

  return (
    <Stack gap={5}>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <Button onClick={() => setRecording(true)}>Record request</Button>
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} aria-label="Data requests">
              <TableHead>
                <TableRow>
                  <TableExpandHeader aria-label="Expand to see details" />
                  {tableHeaders.map((header) => {
                    const { key, ...props } = getHeaderProps({ header });
                    return (
                      <TableHeader key={key} {...props}>
                        {header.header}
                      </TableHeader>
                    );
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const request = byId.get(row.id);
                  if (!request) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  return [
                    <TableExpandRow
                      key={key}
                      {...rowProps}
                      aria-label={`Show details of ${request.reference || shortId(request.id)}`}
                      expandHeader="Expand to see details"
                    >
                      <TableCell>{request.reference || '—'}</TableCell>
                      <TableCell>{kindLabels[request.kind]}</TableCell>
                      <TableCell>
                        <Tag type={statusTagTypes[request.status]} size="sm">
                          {statusLabels[request.status]}
                        </Tag>
                      </TableCell>
                      <TableCell>
                        <code>{shortId(request.personId)}</code>
                      </TableCell>
                      <TableCell>{formatDateTime(request.receivedAt)}</TableCell>
                      <TableCell>
                        {formatDateTime(request.dueAt)}
                        {isOverdue(request) && (
                          <Tag type="red" size="sm">
                            Overdue
                          </Tag>
                        )}
                      </TableCell>
                    </TableExpandRow>,
                    row.isExpanded ? (
                      <TableExpandedRow key={`${key}-detail`} colSpan={tableHeaders.length + 1}>
                        <RequestDetail request={request} canExecute={canExecute} />
                      </TableExpandedRow>
                    ) : null,
                  ];
                })}
              </TableBody>
            </Table>
            {rows.length === 0 && <p className="cds--type-helper-text-01">No data requests recorded.</p>}
          </TableContainer>
        )}
      </DataTable>
      {recording && <RecordRequestModal onClose={() => setRecording(false)} />}
    </Stack>
  );
}
