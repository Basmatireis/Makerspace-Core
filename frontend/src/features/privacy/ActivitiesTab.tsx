import {
  Button,
  DataTable,
  InlineNotification,
  Modal,
  MultiSelect,
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
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { PrivacyCategory, ProcessingActivity } from '../../api/generated/models';
import {
  createProcessingActivity,
  deleteProcessingActivity,
  updateProcessingActivity,
} from '../../api/generated/privacy/privacy';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import {
  categoryName,
  errorCode,
  privacyCategoriesQueryOptions,
  privacyErrorMessage,
  privacyQueryKey,
  processingActivitiesQueryOptions,
} from './privacy';

const headers = [
  { key: 'name', header: 'Activity' },
  { key: 'purpose', header: 'Purpose' },
  { key: 'legalBasis', header: 'Legal basis' },
  { key: 'categories', header: 'Data categories' },
  { key: 'recipients', header: 'Recipients' },
  { key: 'retentionNote', header: 'Retention' },
  { key: 'actions', header: 'Actions' },
];

type ActivityFormValues = {
  name: string;
  purpose: string;
  legalBasis: string;
  categoryIds: string[];
  recipients: string;
  retentionNote: string;
};

function ActivityModal({
  activity,
  categories,
  onClose,
}: {
  activity: ProcessingActivity | undefined;
  categories: readonly PrivacyCategory[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const form = useForm<ActivityFormValues>({
    defaultValues: {
      name: activity?.name ?? '',
      purpose: activity?.purpose ?? '',
      legalBasis: activity?.legalBasis ?? '',
      categoryIds: activity?.categoryIds ?? [],
      recipients: activity?.recipients ?? '',
      retentionNote: activity?.retentionNote ?? '',
    },
  });
  const { control, register, formState } = form;
  const mutation = useMutation({
    mutationFn: (values: ActivityFormValues) => {
      const body = {
        name: values.name.trim(),
        purpose: values.purpose.trim(),
        legalBasis: values.legalBasis.trim(),
        categoryIds: values.categoryIds,
        recipients: values.recipients.trim(),
        retentionNote: values.retentionNote.trim(),
      };
      return activity
        ? updateProcessingActivity(activity.id, { ...body, expectedVersion: activity.version })
        : createProcessingActivity(body);
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: privacyQueryKey });
      onClose();
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: privacyQueryKey });
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
      modalHeading={activity ? 'Edit processing activity' : 'Add processing activity'}
      primaryButtonText={mutation.isPending ? 'Saving…' : 'Save'}
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
            kind={errorCode(mutation.error) === 'stale_write' ? 'warning' : 'error'}
            lowContrast
            hideCloseButton
            title="Activity not saved"
            subtitle={privacyErrorMessage(mutation.error)}
          />
        )}
        <TextInput
          id="activity-name"
          labelText="Name"
          maxLength={200}
          invalid={Boolean(formState.errors.name)}
          invalidText={formState.errors.name?.message}
          {...register('name', { validate: (value) => value.trim() !== '' || 'Enter a name.' })}
        />
        <TextArea id="activity-purpose" labelText="Purpose" maxLength={2000} rows={3} {...register('purpose')} />
        <TextInput id="activity-legal-basis" labelText="Legal basis" maxLength={500} {...register('legalBasis')} />
        <Controller
          control={control}
          name="categoryIds"
          render={({ field }) => (
            <MultiSelect
              id="activity-categories"
              titleText="Data categories"
              label="Choose categories"
              items={[...categories]}
              itemToString={(item) => item?.name ?? ''}
              initialSelectedItems={categories.filter((category) => field.value.includes(category.id))}
              onChange={({ selectedItems }) => field.onChange((selectedItems ?? []).map((item) => item.id))}
            />
          )}
        />
        <TextInput id="activity-recipients" labelText="Recipients" maxLength={1000} {...register('recipients')} />
        <TextArea
          id="activity-retention"
          labelText="Retention note"
          maxLength={1000}
          rows={2}
          {...register('retentionNote')}
        />
      </Stack>
    </Modal>
  );
}

export function ActivitiesTab() {
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, 'privacy.settings.manage');
  const client = useQueryClient();
  const activities = useQuery(processingActivitiesQueryOptions());
  const categories = useQuery(privacyCategoriesQueryOptions());
  const [editing, setEditing] = useState<ProcessingActivity | 'new'>();
  const [deleting, setDeleting] = useState<ProcessingActivity>();

  const remove = useMutation({
    mutationFn: (activity: ProcessingActivity) =>
      deleteProcessingActivity(activity.id, { expectedVersion: activity.version }),
    onSuccess: async () => {
      setDeleting(undefined);
      await client.invalidateQueries({ queryKey: privacyQueryKey });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: privacyQueryKey });
    },
  });

  if (activities.isPending || categories.isPending) return <SettingsLoading label="Loading processing activities" />;
  if (activities.isError) {
    return <ErrorState message={activities.error.message} onRetry={() => void activities.refetch()} />;
  }
  if (categories.isError) {
    return <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />;
  }

  const categoryList = categories.data.categories;
  const byId = new Map(activities.data.activities.map((activity) => [activity.id as string, activity]));
  const rows = activities.data.activities.map((activity) => ({ id: activity.id as string }));

  return (
    <Stack gap={5}>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            {canManage && (
              <TableToolbar>
                <TableToolbarContent>
                  <Button onClick={() => setEditing('new')}>Add activity</Button>
                </TableToolbarContent>
              </TableToolbar>
            )}
            <Table {...getTableProps()} aria-label="Processing activities">
              <TableHead>
                <TableRow>
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
                  const activity = byId.get(row.id);
                  if (!activity) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    <TableRow key={key} {...rowProps}>
                      <TableCell>
                        <strong>{activity.name}</strong>
                      </TableCell>
                      <TableCell>{activity.purpose}</TableCell>
                      <TableCell>{activity.legalBasis}</TableCell>
                      <TableCell>
                        {activity.categoryIds.map((id) => (
                          <Tag key={id} type="cool-gray" size="sm">
                            {categoryName(categoryList, id)}
                          </Tag>
                        ))}
                      </TableCell>
                      <TableCell>{activity.recipients}</TableCell>
                      <TableCell>{activity.retentionNote}</TableCell>
                      <TableCell>
                        {canManage && (
                          <>
                            <Button
                              kind="ghost"
                              size="sm"
                              aria-label={`Edit ${activity.name}`}
                              onClick={() => setEditing(activity)}
                            >
                              Edit
                            </Button>
                            <Button
                              kind="danger--ghost"
                              size="sm"
                              aria-label={`Delete ${activity.name}`}
                              onClick={() => {
                                remove.reset();
                                setDeleting(activity);
                              }}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {rows.length === 0 && <p className="cds--type-helper-text-01">No processing activities recorded.</p>}
          </TableContainer>
        )}
      </DataTable>
      {editing !== undefined && (
        <ActivityModal
          activity={editing === 'new' ? undefined : editing}
          categories={categoryList}
          onClose={() => setEditing(undefined)}
        />
      )}
      <DestructiveActionDialog
        open={deleting !== undefined}
        title="Delete processing activity"
        confirmLabel="Delete"
        pending={remove.isPending}
        error={remove.isError ? privacyErrorMessage(remove.error) : undefined}
        onClose={() => setDeleting(undefined)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      >
        <p>
          Remove {deleting ? `“${deleting.name}”` : 'this activity'} from the record of processing activities? The data
          itself is not affected.
        </p>
      </DestructiveActionDialog>
    </Stack>
  );
}
