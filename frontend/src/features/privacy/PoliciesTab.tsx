import {
  Button,
  DataTable,
  InlineNotification,
  Modal,
  NumberInput,
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
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { PrivacyCategory, RetentionPolicy, RetentionPolicyInput } from '../../api/generated/models';
import { createPrivacyPolicy, transitionPrivacyPolicy, updatePrivacyPolicy } from '../../api/generated/privacy/privacy';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import {
  categoryName,
  privacyCategoriesQueryOptions,
  privacyErrorMessage,
  privacyPoliciesQueryOptions,
  privacyQueryKey,
} from './privacy';

const statusTagTypes: Record<RetentionPolicy['status'], 'gray' | 'blue' | 'green' | 'cool-gray'> = {
  draft: 'gray',
  approved: 'blue',
  active: 'green',
  retired: 'cool-gray',
};

const headers = [
  { key: 'category', header: 'Category' },
  { key: 'version', header: 'Version' },
  { key: 'period', header: 'Retention' },
  { key: 'action', header: 'Action' },
  { key: 'status', header: 'Status' },
  { key: 'source', header: 'Source' },
  { key: 'actions', header: 'Actions' },
];

function sourceText(policy: RetentionPolicy): string {
  if (policy.sourceTemplate?.startsWith('legacy:')) {
    return `Seeded from legacy: ${policy.sourceTemplate.slice('legacy:'.length)}`;
  }
  return policy.sourceTemplate ?? 'Entered manually';
}

type EditorTarget =
  { kind: 'create' } | { kind: 'version'; from: RetentionPolicy } | { kind: 'edit'; policy: RetentionPolicy };

function PolicyEditor({
  target,
  categories,
  onClose,
}: {
  target: EditorTarget;
  categories: readonly PrivacyCategory[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const source = target.kind === 'edit' ? target.policy : target.kind === 'version' ? target.from : undefined;
  const lockedCategory = source?.categoryId;
  const firstCategory = categories.find((category) => category.id === (source?.categoryId ?? categories[0]?.id));
  const form = useForm<RetentionPolicyInput>({
    defaultValues: {
      categoryId: firstCategory?.id ?? '',
      trigger: source?.trigger ?? firstCategory?.triggers[0],
      periodDays: source?.periodDays ?? 365,
      action: source?.action ?? firstCategory?.actions[0],
      purpose: source?.purpose ?? '',
      legalBasis: source?.legalBasis ?? '',
      reason: source?.reason ?? '',
    },
  });
  const {
    control,
    register,
    setValue,
    watch,
    formState: { errors },
  } = form;
  const selected = categories.find((category) => category.id === (lockedCategory ?? watch('categoryId')));

  const mutation = useMutation({
    mutationFn: (body: RetentionPolicyInput) =>
      target.kind === 'edit' ? updatePrivacyPolicy(target.policy.id, body) : createPrivacyPolicy(body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: privacyQueryKey });
      onClose();
    },
  });
  const submit = form.handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync({
        ...values,
        categoryId: lockedCategory ?? values.categoryId,
        periodDays: Number(values.periodDays),
      });
    } catch {
      /* rendered in the dialog */
    }
  });
  const heading =
    target.kind === 'edit' ? 'Edit draft policy' : target.kind === 'version' ? 'New policy version' : 'New policy';

  return (
    <Modal
      open
      size="md"
      modalHeading={heading}
      primaryButtonText={mutation.isPending ? 'Saving…' : 'Save draft'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || !selected}
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
            title="Policy not saved"
            subtitle={privacyErrorMessage(mutation.error)}
          />
        )}
        <Select
          id="policy-category"
          labelText="Category"
          disabled={lockedCategory !== undefined}
          {...register('categoryId', {
            onChange: (event: { target: { value: string } }) => {
              const next = categories.find((category) => category.id === event.target.value);
              if (next) {
                setValue('trigger', next.triggers[0]);
                setValue('action', next.actions[0]);
              }
            },
          })}
        >
          {categories.map((category) => (
            <SelectItem key={category.id} value={category.id} text={category.name} />
          ))}
        </Select>
        <Select id="policy-trigger" labelText="Retention starts at" {...register('trigger')}>
          {(selected?.triggers ?? []).map((trigger) => (
            <SelectItem key={trigger} value={trigger} text={trigger} />
          ))}
        </Select>
        <Controller
          control={control}
          name="periodDays"
          rules={{
            validate: (value) => {
              const n = Number(value);
              return (Number.isInteger(n) && n >= 0 && n <= 36500) || 'Enter a whole number from 0 to 36500.';
            },
          }}
          render={({ field }) => (
            <NumberInput
              id="policy-period"
              label="Period (days)"
              min={0}
              max={36500}
              step={1}
              allowEmpty
              value={field.value}
              invalid={Boolean(errors.periodDays)}
              invalidText={errors.periodDays?.message}
              onChange={(_event, { value }) => field.onChange(value)}
            />
          )}
        />
        <Select id="policy-action" labelText="Action after the period" {...register('action')}>
          {(selected?.actions ?? []).map((action) => (
            <SelectItem key={action} value={action} text={action} />
          ))}
        </Select>
        <TextArea id="policy-purpose" labelText="Purpose" maxLength={1000} rows={3} {...register('purpose')} />
        <TextArea
          id="policy-legal-basis"
          labelText="Legal basis"
          maxLength={500}
          rows={2}
          {...register('legalBasis')}
        />
        <TextArea
          id="policy-reason"
          labelText="Reason for this period"
          maxLength={2000}
          rows={3}
          helperText="Purpose, legal basis and reason are required before the policy can be approved."
          {...register('reason')}
        />
      </Stack>
    </Modal>
  );
}

type Confirmation = { policy: RetentionPolicy; status: 'active' | 'retired' };

export function PoliciesTab() {
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, 'privacy.policies.manage');
  const client = useQueryClient();
  const policies = useQuery(privacyPoliciesQueryOptions());
  const categories = useQuery(privacyCategoriesQueryOptions());
  const [editor, setEditor] = useState<EditorTarget>();
  const [confirmation, setConfirmation] = useState<Confirmation>();

  const transition = useMutation({
    mutationFn: ({ policy, status }: { policy: RetentionPolicy; status: 'approved' | 'active' | 'retired' }) =>
      transitionPrivacyPolicy(policy.id, { status }),
    onSuccess: async () => {
      setConfirmation(undefined);
      await client.invalidateQueries({ queryKey: privacyQueryKey });
    },
  });

  if (policies.isPending || categories.isPending) return <SettingsLoading label="Loading retention policies" />;
  if (policies.isError) {
    return <ErrorState message={policies.error.message} onRetry={() => void policies.refetch()} />;
  }
  if (categories.isError) {
    return <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />;
  }

  const categoryList = categories.data.categories;
  const sorted = [...policies.data.policies].sort(
    (a, b) =>
      categoryName(categoryList, a.categoryId).localeCompare(categoryName(categoryList, b.categoryId)) ||
      b.version - a.version,
  );
  const byId = new Map(sorted.map((policy) => [policy.id as string, policy]));
  const latestVersion = new Map<string, number>();
  for (const policy of sorted) {
    latestVersion.set(policy.categoryId, Math.max(latestVersion.get(policy.categoryId) ?? 0, policy.version));
  }
  const rows = sorted.map((policy) => ({ id: policy.id as string }));
  const busy = transition.isPending;

  return (
    <Stack gap={5}>
      <InlineNotification
        kind="info"
        lowContrast
        hideCloseButton
        title="Not legal advice"
        subtitle="Policies are aids, not legal advice. Activation deletes data on the next run or `admin cleanup`."
      />
      {transition.isError && !confirmation && (
        <InlineNotification
          kind="error"
          lowContrast
          title="Policy not changed"
          subtitle={privacyErrorMessage(transition.error)}
          onClose={() => {
            transition.reset();
            return false;
          }}
        />
      )}
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            {canManage && (
              <TableToolbar>
                <TableToolbarContent>
                  <Button disabled={categoryList.length === 0} onClick={() => setEditor({ kind: 'create' })}>
                    New policy
                  </Button>
                </TableToolbarContent>
              </TableToolbar>
            )}
            <Table {...getTableProps()} aria-label="Retention policies">
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
                  const policy = byId.get(row.id);
                  if (!policy) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    <TableRow key={key} {...rowProps}>
                      <TableCell>{categoryName(categoryList, policy.categoryId)}</TableCell>
                      <TableCell>{policy.version}</TableCell>
                      <TableCell>{`${policy.periodDays} days after ${policy.trigger}`}</TableCell>
                      <TableCell>
                        <Tag type="teal" size="sm">
                          {policy.action}
                        </Tag>
                      </TableCell>
                      <TableCell>
                        <Tag type={statusTagTypes[policy.status]} size="sm">
                          {policy.status}
                        </Tag>
                      </TableCell>
                      <TableCell>{sourceText(policy)}</TableCell>
                      <TableCell>
                        {canManage && (
                          <>
                            {policy.status === 'draft' && (
                              <>
                                <Button
                                  kind="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => setEditor({ kind: 'edit', policy })}
                                >
                                  Edit
                                </Button>
                                <Button
                                  kind="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => {
                                    transition.reset();
                                    transition.mutate({ policy, status: 'approved' });
                                  }}
                                >
                                  Approve
                                </Button>
                              </>
                            )}
                            {policy.status === 'approved' && (
                              <Button
                                kind="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  transition.reset();
                                  setConfirmation({ policy, status: 'active' });
                                }}
                              >
                                Activate
                              </Button>
                            )}
                            {policy.status !== 'retired' && (
                              <Button
                                kind="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => {
                                  transition.reset();
                                  setConfirmation({ policy, status: 'retired' });
                                }}
                              >
                                Retire
                              </Button>
                            )}
                            {latestVersion.get(policy.categoryId) === policy.version && (
                              <Button
                                kind="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => setEditor({ kind: 'version', from: policy })}
                              >
                                New version
                              </Button>
                            )}
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {sorted.length === 0 && <p className="cds--type-helper-text-01">No retention policies yet.</p>}
          </TableContainer>
        )}
      </DataTable>
      {editor && <PolicyEditor target={editor} categories={categoryList} onClose={() => setEditor(undefined)} />}
      <DestructiveActionDialog
        open={confirmation !== undefined}
        title={confirmation?.status === 'active' ? 'Activate policy' : 'Retire policy'}
        confirmLabel={confirmation?.status === 'active' ? 'Activate' : 'Retire'}
        pending={transition.isPending}
        error={transition.isError ? privacyErrorMessage(transition.error) : undefined}
        onClose={() => setConfirmation(undefined)}
        onConfirm={() => confirmation && transition.mutate(confirmation)}
      >
        {confirmation?.status === 'active' ? (
          <p>
            Activating this policy for {categoryName(categoryList, confirmation.policy.categoryId)} enables deletion:
            data older than {confirmation.policy.periodDays} days will be removed on the next run or{' '}
            <code>admin cleanup</code>.
          </p>
        ) : (
          <p>
            Retiring this policy for {confirmation && categoryName(categoryList, confirmation.policy.categoryId)} stops
            it from applying. It cannot be reactivated; create a new version instead.
          </p>
        )}
      </DestructiveActionDialog>
    </Stack>
  );
}
