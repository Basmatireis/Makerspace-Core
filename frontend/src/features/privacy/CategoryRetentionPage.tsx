import {
  Button,
  InlineNotification,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Stack,
  Tag,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type {
  PrivacyCategory,
  RetentionAction,
  RetentionPolicy,
  RetentionPolicyInput,
  RetentionPolicyTransitionStatus,
  RetentionRun,
  RetentionTrigger,
} from '../../api/generated/models';
import {
  createPrivacyPolicy,
  startRetentionRun,
  transitionPrivacyPolicy,
  updatePrivacyPolicy,
} from '../../api/generated/privacy/privacy';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { formatDateTime } from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import {
  privacyCategoriesQueryOptions,
  privacyErrorMessage,
  privacyPoliciesQueryOptions,
  privacyQueryKey,
} from './privacy';
import { categoryIdFromPath, PrivacyLink, privacyPath, privacySections } from './privacyNavigation';
import './privacyCategories.scss';

const triggerOptions: Record<RetentionTrigger, { label: string; detail: string }> = {
  created_at: { label: 'The record is created', detail: 'The period counts from the moment the data was stored.' },
  completed_at: {
    label: 'It is completed',
    detail: 'Open records are never touched; the period starts at completion.',
  },
  cancelled_at: { label: 'It is cancelled', detail: 'The period starts when the record was cancelled.' },
  expired_at: { label: 'It expires', detail: 'The period starts once the record is no longer valid.' },
  account_closed_at: { label: 'The account is closed', detail: 'Nothing happens while the account exists.' },
  last_used_at: { label: 'It was last used', detail: 'Every use restarts the period.' },
  legal_period_end: {
    label: 'The legal retention period ends',
    detail: 'The statutory period runs first; this period follows it.',
  },
  ended_at: { label: 'It ends', detail: 'The period starts at the scheduled end.' },
};

const actionOptions: Record<RetentionAction, { label: string; detail: string; past: string }> = {
  delete: { label: 'Delete', detail: 'The rows are removed completely.', past: 'deleted' },
  anonymize: {
    label: 'Anonymise',
    detail: 'The link to the person is removed; totals and non-identifying data stay.',
    past: 'anonymised',
  },
  unlink: { label: 'Unlink', detail: 'The rows stay without the link to the person.', past: 'unlinked' },
  redact: { label: 'Redact', detail: 'Names and contact details are blanked; the rest stays.', past: 'redacted' },
  retain_with_review: {
    label: 'Keep, with a documented review',
    detail: 'Nothing is removed. Only for data you must keep; the reason below becomes the justification.',
    past: 'kept for review',
  },
};

const erasureText: Record<PrivacyCategory['erasure'], string> = {
  none: 'Not person-linked.',
  erased: 'Deleted with the person, regardless of this rule.',
  unlinked: 'Kept without the person link, regardless of this rule.',
  retained_legal: 'Kept for a legal obligation, without the person link.',
  manual_review: 'An operator must act first.',
};

function periodText(days: number): string {
  if (days === 0) return 'As soon as the clock starts.';
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}.`;
  if (days < 60) return `About ${Math.round(days / 7)} weeks.`;
  if (days < 365) return `About ${Math.round(days / 30)} months.`;
  const years = days / 365;
  return `About ${Number.isInteger(years) ? years : years.toFixed(1)} ${years === 1 ? 'year' : 'years'}.`;
}

function ruleSentence(category: PrivacyCategory, input: RetentionPolicyInput): string {
  const trigger = triggerOptions[input.trigger].label.toLowerCase();
  const action = actionOptions[input.action];
  if (input.action === 'retain_with_review') {
    return `${category.name} are kept with a documented review; nothing is removed automatically.`;
  }
  const when = input.periodDays === 0 ? 'as soon as' : `${input.periodDays} days after`;
  return `${category.name} are ${action.past} ${when} ${trigger}.`;
}

function versionLabel(policy: RetentionPolicy): string {
  return `v${policy.version}`;
}

const statusTag: Record<RetentionPolicy['status'], { label: string; type: 'green' | 'blue' | 'gray' | 'warm-gray' }> = {
  active: { label: 'in force', type: 'green' },
  approved: { label: 'approved, not yet active', type: 'blue' },
  draft: { label: 'draft', type: 'warm-gray' },
  retired: { label: 'retired', type: 'gray' },
};

function defaults(category: PrivacyCategory, draft: RetentionPolicy | undefined): RetentionPolicyInput {
  const base = draft ?? category.coverage.policy;
  if (base) {
    return {
      categoryId: category.id,
      trigger: base.trigger,
      periodDays: base.periodDays,
      action: base.action,
      purpose: base.purpose,
      legalBasis: base.legalBasis,
      reason: base.reason,
    };
  }
  const legacy = category.legacyDefault;
  return {
    categoryId: category.id,
    trigger: legacy?.trigger ?? category.triggers[0],
    periodDays: legacy?.periodDays ?? 0,
    action: legacy?.action ?? category.actions[0],
    purpose: '',
    legalBasis: '',
    reason: '',
  };
}

type Confirmation = { policy: RetentionPolicy; status: RetentionPolicyTransitionStatus };

function RetentionEditor({
  category,
  versions,
  canManage,
  canExecute,
}: {
  category: PrivacyCategory;
  versions: readonly RetentionPolicy[];
  canManage: boolean;
  canExecute: boolean;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const draft = versions.find((policy) => policy.status === 'draft');
  const approved = versions.find((policy) => policy.status === 'approved');
  const active = versions.find((policy) => policy.status === 'active');
  const decision = active ?? category.coverage.policy ?? undefined;
  const form = useForm<RetentionPolicyInput>({ defaultValues: defaults(category, draft) });
  const { control, handleSubmit, register, reset, watch, formState } = form;
  useEffect(() => {
    reset(defaults(category, draft));
    // Only the stored versions decide the form's starting point; editing keeps the typed values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category.id, draft?.id, draft?.updatedAt]);
  const values = watch();

  const save = useMutation({
    mutationFn: (input: RetentionPolicyInput) =>
      draft ? updatePrivacyPolicy(draft.id, input) : createPrivacyPolicy(input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: privacyQueryKey });
    },
  });
  const transition = useMutation({
    mutationFn: ({ policy, status }: Confirmation) => transitionPrivacyPolicy(policy.id, { status }),
    onSuccess: async () => {
      setConfirmation(undefined);
      await client.invalidateQueries({ queryKey: privacyQueryKey });
    },
  });
  const dryRun = useMutation({
    mutationFn: () => startRetentionRun({ mode: 'dry_run', categoryIds: [category.id] }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: privacyQueryKey });
    },
  });
  const [confirmation, setConfirmation] = useState<Confirmation | undefined>();

  const complete = values.purpose.trim() !== '' && values.legalBasis.trim() !== '' && values.reason.trim() !== '';
  const dryRunItem = (run: RetentionRun) => run.items.find((item) => item.categoryId === category.id);

  return (
    <>
      <div className="privacy-retention__notice">
        {draft && decision && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title={`You are editing a new version (${versionLabel(draft)})`}
            subtitle={`The decision in force (${versionLabel(decision)}) keeps applying until this version is approved by one person and activated by another. Nothing is deleted by saving.`}
          />
        )}
        {!draft && !decision && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="No decision yet"
            subtitle={
              category.legacyDefault
                ? 'The form starts from what the app did before the registry. Saving creates a draft; nothing changes until it is approved and activated.'
                : 'This data has never been removed automatically. Saving creates a draft; nothing changes until it is approved and activated.'
            }
          />
        )}
      </div>
      <div className="privacy-retention">
        <div className="privacy-retention__main">
          <form
            className="privacy-retention__form"
            onSubmit={handleSubmit((input) => save.mutate({ ...input, categoryId: category.id }))}
            noValidate
          >
            <Tile>
              <Stack gap={6}>
                <div>
                  <h2 className="cds--type-productive-heading-03">The rule</h2>
                  <p className="privacy-secondary">
                    Three questions: when the clock starts, how long the data stays, and what happens then.
                  </p>
                </div>
                <Controller
                  control={control}
                  name="trigger"
                  render={({ field }) => (
                    <RadioButtonGroup
                      legendText="The clock starts when"
                      name="trigger"
                      orientation="vertical"
                      valueSelected={field.value}
                      onChange={(value) => field.onChange(value)}
                      readOnly={!canManage}
                    >
                      {category.triggers.map((trigger) => (
                        <RadioButton
                          key={trigger}
                          id={`trigger-${trigger}`}
                          value={trigger}
                          labelText={`${triggerOptions[trigger].label} — ${triggerOptions[trigger].detail}`}
                        />
                      ))}
                    </RadioButtonGroup>
                  )}
                />
                <Controller
                  control={control}
                  name="periodDays"
                  rules={{ min: 0, max: 36500 }}
                  render={({ field }) => (
                    <NumberInput
                      id="retention-days"
                      label="Keep for (days)"
                      min={0}
                      max={36500}
                      value={field.value}
                      readOnly={!canManage}
                      helperText={`${periodText(field.value)} 0 days means: as soon as the clock starts.`}
                      invalid={formState.errors.periodDays !== undefined}
                      invalidText="Between 0 and 36 500 days."
                      onChange={(_event, { value }) => field.onChange(Number(value))}
                    />
                  )}
                />
                <Controller
                  control={control}
                  name="action"
                  render={({ field }) => (
                    <RadioButtonGroup
                      legendText="Then"
                      name="action"
                      orientation="vertical"
                      valueSelected={field.value}
                      onChange={(value) => field.onChange(value)}
                      readOnly={!canManage}
                    >
                      {category.actions.map((action) => (
                        <RadioButton
                          key={action}
                          id={`action-${action}`}
                          value={action}
                          labelText={`${actionOptions[action].label} — ${actionOptions[action].detail}`}
                        />
                      ))}
                    </RadioButtonGroup>
                  )}
                />
              </Stack>
            </Tile>
            <Tile>
              <Stack gap={6}>
                <div>
                  <h2 className="cds--type-productive-heading-03">Why</h2>
                  <p className="privacy-secondary">
                    Required before the decision can be approved. Shown in the record of processing and in every export
                    a person receives.
                  </p>
                </div>
                <TextArea
                  id="retention-purpose"
                  labelText="Purpose"
                  rows={2}
                  maxLength={1000}
                  readOnly={!canManage}
                  {...register('purpose', { maxLength: 1000 })}
                />
                <TextInput
                  id="retention-legal-basis"
                  labelText="Legal basis"
                  maxLength={500}
                  readOnly={!canManage}
                  placeholder="e.g. Legitimate interest, Art. 6(1)(f) GDPR"
                  {...register('legalBasis', { maxLength: 500 })}
                />
                <TextArea
                  id="retention-reason"
                  labelText="Why this period"
                  rows={3}
                  maxLength={2000}
                  readOnly={!canManage}
                  {...register('reason', { maxLength: 2000 })}
                />
              </Stack>
            </Tile>
            {save.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="The draft was not saved"
                subtitle={privacyErrorMessage(save.error)}
              />
            )}
            {save.isSuccess && !save.isPending && (
              <InlineNotification
                kind="success"
                lowContrast
                hideCloseButton
                title="Draft saved"
                subtitle="Approve it below once purpose, legal basis and reason are complete."
              />
            )}
            {canManage && (
              <div className="privacy-retention__actions">
                <Button kind="secondary" onClick={() => void navigate(privacyPath('categories'))}>
                  Back to categories
                </Button>
                <Button kind="primary" type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : draft ? 'Save draft' : 'Save as draft'}
                </Button>
              </div>
            )}
          </form>
        </div>

        <div className="privacy-retention__side">
          <Tile>
            <Stack gap={4}>
              <h2 className="cds--type-productive-heading-03">What this means</h2>
              <p>{ruleSentence(category, values)}</p>
              <dl className="privacy-kv">
                {decision && (
                  <>
                    <dt>In force today</dt>
                    <dd>
                      {ruleSentence(category, { ...decision, categoryId: category.id })} ({versionLabel(decision)}
                      {decision.activatedAt ? `, since ${formatDateTime(decision.activatedAt)}` : ''})
                    </dd>
                  </>
                )}
                <dt>Before the registry</dt>
                <dd>
                  {category.legacyDefault
                    ? `${category.legacyDefault.periodDays} days after ${category.legacyDefault.trigger} → ${category.legacyDefault.action}, from ${category.legacyDefault.source}`
                    : 'Never removed automatically'}
                </dd>
                <dt>On erasure</dt>
                <dd>{erasureText[category.erasure]}</dd>
              </dl>
              {canExecute && (
                <div>
                  <Button
                    kind="tertiary"
                    size="md"
                    disabled={!active || dryRun.isPending}
                    onClick={() => dryRun.mutate()}
                  >
                    {dryRun.isPending ? 'Running…' : 'Dry run the decision in force'}
                  </Button>
                  <p className="cds--type-helper-text-01">
                    {active
                      ? 'A dry run applies the active decision and changes nothing; a draft cannot be tried out yet.'
                      : 'A dry run needs an active decision.'}
                  </p>
                  {dryRun.isSuccess && (
                    <p>
                      {(() => {
                        const item = dryRunItem(dryRun.data);
                        if (!item) return 'The dry run planned no work for this category.';
                        if (item.status === 'skipped_hold') return 'Skipped: the category is on hold.';
                        return `Right now ${item.affectedCount} ${item.affectedCount === 1 ? 'row' : 'rows'} would be ${actionOptions[item.action].past}.`;
                      })()}
                    </p>
                  )}
                  {dryRun.isError && <p className="privacy-secondary">{privacyErrorMessage(dryRun.error)}</p>}
                </div>
              )}
            </Stack>
          </Tile>

          {canManage && (
            <Tile>
              <Stack gap={4}>
                <h2 className="cds--type-productive-heading-03">Getting it into force</h2>
                <ol className="privacy-steps">
                  <li
                    className={draft || approved || active ? 'privacy-steps__step--done' : 'privacy-steps__step--now'}
                  >
                    <strong>Draft</strong>
                    <span>
                      {draft ? `${versionLabel(draft)}, saved ${formatDateTime(draft.updatedAt)}` : 'save the form'}
                    </span>
                  </li>
                  <li className={approved ? 'privacy-steps__step--done' : draft ? 'privacy-steps__step--now' : ''}>
                    <strong>Approve</strong>
                    <span>{approved ? `${versionLabel(approved)} approved` : 'needs purpose, basis and reason'}</span>
                  </li>
                  <li className={approved ? 'privacy-steps__step--now' : ''}>
                    <strong>Activate</strong>
                    <span>by someone else</span>
                  </li>
                </ol>
                <p className="cds--type-helper-text-01">
                  Approving and activating are two different people (four eyes); masters may do both. Activation retires
                  the decision in force.
                </p>
                {transition.isError && !confirmation && (
                  <InlineNotification
                    kind="error"
                    lowContrast
                    hideCloseButton
                    title="The step was refused"
                    subtitle={privacyErrorMessage(transition.error)}
                  />
                )}
                <div className="privacy-retention__actions privacy-retention__actions--start">
                  {draft && (
                    <Button
                      kind="tertiary"
                      size="md"
                      disabled={!complete || formState.isDirty || transition.isPending}
                      onClick={() => transition.mutate({ policy: draft, status: 'approved' })}
                    >
                      Approve {versionLabel(draft)}
                    </Button>
                  )}
                  {approved && (
                    <Button
                      kind="primary"
                      size="md"
                      onClick={() => setConfirmation({ policy: approved, status: 'active' })}
                    >
                      Activate {versionLabel(approved)}
                    </Button>
                  )}
                  {active && (
                    <Button
                      kind="danger--ghost"
                      size="md"
                      onClick={() => setConfirmation({ policy: active, status: 'retired' })}
                    >
                      Retire {versionLabel(active)}
                    </Button>
                  )}
                </div>
                {draft && formState.isDirty && (
                  <p className="cds--type-helper-text-01">Save the draft before approving it.</p>
                )}
              </Stack>
            </Tile>
          )}

          {canManage && versions.length > 0 && (
            <Tile>
              <Stack gap={4}>
                <h2 className="cds--type-productive-heading-03">Versions</h2>
                <ol className="privacy-versions">
                  {versions.map((policy) => (
                    <li key={policy.id} className="privacy-versions__item">
                      <strong>{versionLabel(policy)}</strong>
                      <div>
                        <div>{ruleSentence(category, { ...policy, categoryId: category.id })}</div>
                        <div className="cds--type-helper-text-01">
                          {policy.sourceTemplate ? 'Seeded from the previous behaviour · ' : ''}
                          {policy.activatedAt
                            ? `activated ${formatDateTime(policy.activatedAt)}`
                            : policy.approvedAt
                              ? `approved ${formatDateTime(policy.approvedAt)}`
                              : `saved ${formatDateTime(policy.updatedAt)}`}
                          {policy.retiredAt ? ` · retired ${formatDateTime(policy.retiredAt)}` : ''}
                        </div>
                      </div>
                      <Tag type={statusTag[policy.status].type} size="sm">
                        {statusTag[policy.status].label}
                      </Tag>
                    </li>
                  ))}
                </ol>
              </Stack>
            </Tile>
          )}

          <Tile>
            <Stack gap={4}>
              <h2 className="cds--type-productive-heading-03">Recent runs for this category</h2>
              {category.coverage.lastRun ? (
                <div>
                  <div>
                    {category.coverage.lastRun.status === 'applied'
                      ? `${category.coverage.lastRun.affectedCount} rows ${actionOptions[category.coverage.lastRun.action].past}${category.coverage.lastRun.mode === 'dry_run' ? ' (dry run)' : ''}`
                      : category.coverage.lastRun.status === 'skipped_hold'
                        ? 'Skipped: on hold'
                        : 'Skipped: no policy'}
                  </div>
                  <div className="cds--type-helper-text-01">{formatDateTime(category.coverage.lastRun.startedAt)}</div>
                </div>
              ) : (
                <p className="privacy-secondary">No run yet.</p>
              )}
              <PrivacyLink section="runs">All runs</PrivacyLink>
            </Stack>
          </Tile>
        </div>

        <DestructiveActionDialog
          open={confirmation !== undefined}
          title={confirmation?.status === 'active' ? 'Activate this decision' : 'Retire this decision'}
          confirmLabel={confirmation?.status === 'active' ? 'Activate' : 'Retire'}
          pending={transition.isPending}
          error={transition.isError ? privacyErrorMessage(transition.error) : undefined}
          onClose={() => setConfirmation(undefined)}
          onConfirm={() => confirmation && transition.mutate(confirmation)}
        >
          {confirmation?.status === 'active' ? (
            <p>
              {ruleSentence(category, { ...confirmation.policy, categoryId: category.id })} This applies on the next run
              or <code>admin cleanup</code>
              {active ? ` and retires ${versionLabel(active)}` : ''}.
            </p>
          ) : (
            <p>
              Retiring {confirmation ? versionLabel(confirmation.policy) : ''} stops it from applying; the previous
              behaviour returns until another version is activated. It cannot be reactivated; save a new draft instead.
            </p>
          )}
        </DestructiveActionDialog>
      </div>
    </>
  );
}

/** One category's retention decision: the rule, why, and how it gets into force. */
export function CategoryRetentionPage() {
  const currentUser = useCurrentUser();
  const location = useLocation();
  const categoryId = categoryIdFromPath(location.pathname);
  const canManage = hasPermission(currentUser, 'privacy.policies.manage');
  const canExecute = hasPermission(currentUser, 'privacy.retention.execute');
  const categories = useQuery(privacyCategoriesQueryOptions());
  const policies = useQuery({ ...privacyPoliciesQueryOptions(), enabled: canManage });
  if (categoryId === null) return <Navigate to={privacyPath('categories')} replace />;
  const breadcrumbs = [
    { label: 'Settings', to: '/settings' },
    { label: 'Data', to: '/settings#data' },
    { label: privacySections.categories.title, to: privacyPath('categories') },
  ];
  if (categories.isPending || (canManage && policies.isPending)) {
    return (
      <PageShell title="Edit retention" breadcrumbs={breadcrumbs} width="wide">
        <SettingsLoading label="Loading the category" />
      </PageShell>
    );
  }
  if (categories.isError) {
    return (
      <PageShell title="Edit retention" breadcrumbs={breadcrumbs} width="wide">
        <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />
      </PageShell>
    );
  }
  const category = categories.data.categories.find((entry) => entry.id === categoryId);
  if (!category) return <Navigate to={privacyPath('categories')} replace />;
  const versions = (policies.data?.policies ?? [])
    .filter((policy) => policy.categoryId === category.id)
    .sort((a, b) => b.version - a.version);
  const subject = { person: 'A person', account: 'An account', none: 'No person' }[category.subject];
  return (
    <PageShell
      title={category.name}
      titleAdornment={
        <>
          <Tag
            type={category.subject === 'person' ? 'blue' : category.subject === 'account' ? 'purple' : 'gray'}
            size="md"
          >
            {subject}
          </Tag>
          <Tag type="cool-gray" size="md">
            {category.ownerModuleId.replace(/[_-]+/g, ' ')}
          </Tag>
        </>
      }
      description={category.contains}
      breadcrumbs={breadcrumbs}
      width="wide"
    >
      <RetentionEditor category={category} versions={versions} canManage={canManage} canExecute={canExecute} />
    </PageShell>
  );
}
