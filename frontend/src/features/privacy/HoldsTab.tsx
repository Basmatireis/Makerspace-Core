import {
  Button,
  DataTable,
  Dropdown,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
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
  TableToolbarSearch,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { PrivacyCategory, RetentionHold } from '../../api/generated/models';
import { createPrivacyHold, releasePrivacyHold } from '../../api/generated/privacy/privacy';
import { PrivacyLink } from './privacyNavigation';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { RichNotification } from '../../app/RichNotification';
import { formatDate, formatDateTime } from '../../app/dateTime';
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
  { key: 'scope', header: 'What is on hold' },
  { key: 'reason', header: 'Why' },
  { key: 'created', header: 'Placed' },
  { key: 'status', header: 'Status' },
  { key: 'actions', header: 'Actions' },
];

type HoldFormValues = { scope: 'category' | 'person'; categoryId: string; personId: string; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

const actionWords: Record<PrivacyCategory['actions'][number], string> = {
  delete: 'deleted',
  anonymize: 'anonymised',
  unlink: 'unlinked',
  redact: 'redacted',
  retain_with_review: 'kept for review',
};

function scopeText(hold: RetentionHold, categories: readonly PrivacyCategory[]): string {
  return hold.categoryId ? categoryName(categories, hold.categoryId) : `Person ${hold.personId}`;
}

function openDays(hold: RetentionHold): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(hold.createdAt)) / DAY_MS));
}

/** The rule retention applies to a category today, in plain words. */
function currentRule(category: PrivacyCategory | undefined): string {
  const rule = category?.coverage.policy ?? category?.legacyDefault;
  if (!category || !rule) return 'no policy';
  const when = rule.periodDays === 0 ? `as soon as ${rule.trigger}` : `${rule.periodDays} days after ${rule.trigger}`;
  return `${actionWords[rule.action]} ${when}${category.coverage.policy ? '' : ' (built-in default)'}`;
}

function categoryLabel(category: PrivacyCategory): string {
  return category.description ? `${category.name} · ${category.description}` : category.name;
}

function PlaceHoldModal({ categories, onClose }: { categories: readonly PrivacyCategory[]; onClose: () => void }) {
  const client = useQueryClient();
  const form = useForm<HoldFormValues>({
    defaultValues: { scope: 'category', categoryId: categories[0]?.id ?? '', personId: '', reason: '' },
  });
  const { register, setValue, watch, control, formState } = form;
  const scope = watch('scope');
  const categoryId = watch('categoryId');
  const selected = categories.find((category) => category.id === categoryId);
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
      modalLabel="Retention hold"
      modalHeading="Place a hold"
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
        <RadioButtonGroup
          legendText="What should retention leave alone?"
          name="hold-scope"
          orientation="vertical"
          valueSelected={scope}
          onChange={(value) => setValue('scope', value as HoldFormValues['scope'])}
        >
          <RadioButton id="hold-scope-category" value="category" labelText="A data category, for everyone" />
          <RadioButton id="hold-scope-person" value="person" labelText="One person, so they cannot be erased yet" />
        </RadioButtonGroup>
        {scope === 'category' ? (
          <Controller
            control={control}
            name="categoryId"
            render={({ field }) => (
              <Dropdown
                id="hold-category"
                titleText="Data category"
                label="Choose a category"
                items={[...categories]}
                itemToString={(item) => (item ? categoryLabel(item) : '')}
                selectedItem={selected ?? null}
                helperText={selected ? `Currently: ${currentRule(selected)}` : undefined}
                onChange={({ selectedItem }) => field.onChange(selectedItem?.id ?? '')}
              />
            )}
          />
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
          labelText="Why (shown in every run report and the audit log)"
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
  const [search, setSearch] = useState('');

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
  const term = search.trim().toLowerCase();
  const visible = holds.data.holds.filter(
    (hold) =>
      term === '' ||
      [
        hold.categoryId ? 'Category' : 'Person',
        scopeText(hold, categoryList),
        categoryList.find((candidate) => candidate.id === hold.categoryId)?.description ?? '',
        hold.reason,
        hold.createdBy ?? '',
        hold.releasedAt ? 'Released' : 'Open',
      ].some((text) => text.toLowerCase().includes(term)),
  );
  const byId = new Map(visible.map((hold) => [hold.id as string, hold]));
  const rows = visible.map((hold) => ({ id: hold.id as string }));
  const paused = holds.data.holds.filter((hold) => hold.categoryId && !hold.releasedAt);

  return (
    <Stack gap={5}>
      <p className="cds--type-body-compact-01">
        A hold stops retention from touching data while you still need it: a whole category, or one person who must not
        be erased yet. Released holds stay listed as evidence.
      </p>
      {paused.length > 0 && (
        <RichNotification
          kind="warning"
          title={paused.length === 1 ? '1 category is paused' : `${paused.length} categories are paused`}
        >
          {paused
            .map((hold) => `${categoryName(categoryList, hold.categoryId ?? '')} (since ${formatDate(hold.createdAt)})`)
            .join(', ')}{' '}
          {paused.length === 1 ? 'is' : 'are'} skipped by every run until released.{' '}
          <PrivacyLink section="categories">See the categories</PrivacyLink>
        </RichNotification>
      )}
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <TableToolbarSearch
                  persistent
                  labelText="Search holds"
                  placeholder="Search holds by category, person, reason or status"
                  value={search}
                  onChange={(event) => setSearch(typeof event === 'string' ? event : event.target.value)}
                />
                {canManage && (
                  <Button disabled={categoryList.length === 0} onClick={() => setPlacing(true)}>
                    Place hold
                  </Button>
                )}
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} aria-label="Retention holds">
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => {
                    const { key, ...props } = getHeaderProps({ header });
                    return (
                      <TableHeader key={key} {...props}>
                        {header.key === 'actions' ? (
                          <span className="cds--visually-hidden">Actions</span>
                        ) : (
                          header.header
                        )}
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
                  const category = hold.categoryId
                    ? categoryList.find((candidate) => candidate.id === hold.categoryId)
                    : undefined;
                  const days = openDays(hold);
                  return (
                    <TableRow key={key} {...rowProps}>
                      <TableCell>
                        <Tag type={hold.categoryId ? 'gray' : 'blue'} size="sm">
                          {hold.categoryId ? 'Category' : 'Person'}
                        </Tag>
                        <div>
                          {hold.categoryId ? (
                            <strong>
                              <PrivacyLink section="categories">
                                {categoryName(categoryList, hold.categoryId)}
                              </PrivacyLink>
                            </strong>
                          ) : (
                            <strong>{hold.personId}</strong>
                          )}
                        </div>
                        {category?.description && (
                          <div className="cds--type-helper-text-01">{category.description}</div>
                        )}
                      </TableCell>
                      <TableCell>{hold.reason}</TableCell>
                      <TableCell>
                        <div>{hold.createdBy ?? '—'}</div>
                        <div className="cds--type-helper-text-01">{formatDateTime(hold.createdAt)}</div>
                      </TableCell>
                      <TableCell>
                        {hold.releasedAt ? (
                          <>
                            <Tag type="gray" size="sm">
                              Released
                            </Tag>
                            <div className="cds--type-helper-text-01">on {formatDate(hold.releasedAt)}</div>
                          </>
                        ) : (
                          <Tag type="warm-gray" size="sm">
                            {`Open · ${days} ${days === 1 ? 'day' : 'days'}`}
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
            {rows.length === 0 && (
              <p className="cds--type-helper-text-01">
                {holds.data.holds.length === 0 ? 'No holds placed.' : 'No holds match the search.'}
              </p>
            )}
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
