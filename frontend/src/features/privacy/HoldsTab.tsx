import {
  Button,
  DataTable,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
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
  TableToolbar,
  TableToolbarContent,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { PrivacyCategory, RetentionHold } from '../../api/generated/models';
import { createPrivacyHold, releasePrivacyHold } from '../../api/generated/privacy/privacy';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { formatDateTime } from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import {
  categoryName,
  privacyCategoriesQueryOptions,
  privacyErrorMessage,
  privacyHoldsQueryOptions,
  privacyQueryKey,
} from './privacy';

const headers = [
  { key: 'scope', header: 'Scope' },
  { key: 'reason', header: 'Reason' },
  { key: 'created', header: 'Placed' },
  { key: 'released', header: 'Released' },
  { key: 'actions', header: 'Actions' },
];

type HoldFormValues = { scope: 'category' | 'person'; categoryId: string; personId: string; reason: string };

function scopeText(hold: RetentionHold, categories: readonly PrivacyCategory[]): string {
  return hold.categoryId ? categoryName(categories, hold.categoryId) : `Person ${hold.personId}`;
}

function PlaceHoldModal({ categories, onClose }: { categories: readonly PrivacyCategory[]; onClose: () => void }) {
  const client = useQueryClient();
  const form = useForm<HoldFormValues>({
    defaultValues: { scope: 'category', categoryId: categories[0]?.id ?? '', personId: '', reason: '' },
  });
  const { register, setValue, watch, formState } = form;
  const scope = watch('scope');
  const mutation = useMutation({
    mutationFn: (values: HoldFormValues) =>
      createPrivacyHold({
        ...(values.scope === 'category' ? { categoryId: values.categoryId } : { personId: values.personId.trim() }),
        reason: values.reason.trim(),
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
      size="sm"
      modalHeading="Place hold"
      primaryButtonText={mutation.isPending ? 'Placing…' : 'Place hold'}
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
            title="Hold not placed"
            subtitle={privacyErrorMessage(mutation.error)}
          />
        )}
        <p className="cds--type-helper-text-01">
          While a hold is open, retention runs skip the held data instead of removing it.
        </p>
        <RadioButtonGroup
          legendText="Hold applies to"
          name="hold-scope"
          orientation="vertical"
          valueSelected={scope}
          onChange={(value) => setValue('scope', value as HoldFormValues['scope'])}
        >
          <RadioButton id="hold-scope-category" value="category" labelText="A data category" />
          <RadioButton id="hold-scope-person" value="person" labelText="A person" />
        </RadioButtonGroup>
        {scope === 'category' ? (
          <Select id="hold-category" labelText="Category" {...register('categoryId')}>
            {categories.map((category) => (
              <SelectItem key={category.id} value={category.id} text={category.name} />
            ))}
          </Select>
        ) : (
          <TextInput
            id="hold-person"
            labelText="Person ID"
            helperText="The UUID of the person, as shown in their profile URL."
            invalid={Boolean(formState.errors.personId)}
            invalidText={formState.errors.personId?.message}
            {...register('personId', { required: 'Enter the person ID.' })}
          />
        )}
        <TextArea
          id="hold-reason"
          labelText="Reason"
          maxLength={2000}
          rows={3}
          invalid={Boolean(formState.errors.reason)}
          invalidText={formState.errors.reason?.message}
          {...register('reason', { validate: (value) => value.trim() !== '' || 'Enter a reason.' })}
        />
      </Stack>
    </Modal>
  );
}

export function HoldsTab() {
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, 'privacy.policies.manage');
  const client = useQueryClient();
  const holds = useQuery(privacyHoldsQueryOptions());
  const categories = useQuery(privacyCategoriesQueryOptions());
  const [placing, setPlacing] = useState(false);
  const [releasing, setReleasing] = useState<RetentionHold>();

  const release = useMutation({
    mutationFn: (hold: RetentionHold) => releasePrivacyHold(hold.id),
    onSuccess: async () => {
      setReleasing(undefined);
      await client.invalidateQueries({ queryKey: privacyQueryKey });
    },
  });

  if (holds.isPending || categories.isPending) return <SettingsLoading label="Loading holds" />;
  if (holds.isError) return <ErrorState message={holds.error.message} onRetry={() => void holds.refetch()} />;
  if (categories.isError) {
    return <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />;
  }

  const categoryList = categories.data.categories;
  const byId = new Map(holds.data.holds.map((hold) => [hold.id as string, hold]));
  const rows = holds.data.holds.map((hold) => ({ id: hold.id as string }));

  return (
    <Stack gap={5}>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            {canManage && (
              <TableToolbar>
                <TableToolbarContent>
                  <Button disabled={categoryList.length === 0} onClick={() => setPlacing(true)}>
                    Place hold
                  </Button>
                </TableToolbarContent>
              </TableToolbar>
            )}
            <Table {...getTableProps()} aria-label="Retention holds">
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
                  const hold = byId.get(row.id);
                  if (!hold) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    <TableRow key={key} {...rowProps}>
                      <TableCell>{scopeText(hold, categoryList)}</TableCell>
                      <TableCell>{hold.reason}</TableCell>
                      <TableCell>{formatDateTime(hold.createdAt)}</TableCell>
                      <TableCell>
                        {hold.releasedAt ? (
                          formatDateTime(hold.releasedAt)
                        ) : (
                          <Tag type="red" size="sm">
                            Open
                          </Tag>
                        )}
                      </TableCell>
                      <TableCell>
                        {canManage && !hold.releasedAt && (
                          <Button
                            kind="ghost"
                            size="sm"
                            onClick={() => {
                              release.reset();
                              setReleasing(hold);
                            }}
                          >
                            Release
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {rows.length === 0 && <p className="cds--type-helper-text-01">No holds placed.</p>}
          </TableContainer>
        )}
      </DataTable>
      {placing && <PlaceHoldModal categories={categoryList} onClose={() => setPlacing(false)} />}
      <DestructiveActionDialog
        open={releasing !== undefined}
        title="Release hold"
        confirmLabel="Release"
        pending={release.isPending}
        error={release.isError ? privacyErrorMessage(release.error) : undefined}
        onClose={() => setReleasing(undefined)}
        onConfirm={() => releasing && release.mutate(releasing)}
      >
        <p>
          After the release, the next retention run may remove the data that this hold protected
          {releasing ? ` (${scopeText(releasing, categoryList)})` : ''}.
        </p>
      </DestructiveActionDialog>
    </Stack>
  );
}
