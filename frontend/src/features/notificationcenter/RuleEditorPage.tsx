import { Button, IconButton, InlineNotification, Select, SelectItem, Tag, TextInput, Toggle } from '@carbon/react';
import { Copy, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { NotificationCatalog, NotificationCategory, NotificationRule } from '../../api/generated/models';
import {
  createNotificationRule,
  createOwnNotificationSubscription,
  deleteNotificationRule,
  deleteOwnNotificationSubscription,
  updateNotificationRule,
  updateOwnNotificationSubscription,
} from '../../api/generated/notification-rules/notification-rules';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { ErrorState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import { settingsGroup, settingsItem } from '../settings/settingsCatalog';
import { ConditionsStep, LoopStep, WhenStep } from './editor/WhenSteps';
import { EscalationStep, LimitsStep, ThenStep } from './editor/OutcomeSteps';
import type { StepProps } from './editor/FlowStep';
import { PreviewColumn } from './editor/PreviewColumn';
import {
  catalogQuery,
  categoriesQuery,
  notificationCenterKeys,
  ruleQuery,
  saveProblem,
  useNameLookup,
} from './queries';
import {
  blankDefinition,
  clone,
  draftFromRule,
  pruneDefinition,
  toInput,
  validateDraft,
  type Definition,
  type RuleDraft,
  type RuleKind,
} from './ruleModel';
import './notificationcenter.scss';

const listPath = '/settings/notifications';
/** Where the personal editor returns to and where its subscriptions live. */
export const personalListPath = '/profile/notifications';
export const personalSubscriptionPath = `${personalListPath}/subscriptions`;
const kinds: readonly RuleKind[] = ['event', 'schedule', 'loop', 'manual'];

function categoryHint(category: NotificationCategory | undefined): string {
  if (!category) return '';
  return category.basis === 'consent'
    ? `Reaches only the people who allowed ${category.name}. Nobody is asked again for this rule.`
    : 'Reaches everyone, without consent. Only for messages people need to use the makerspace.';
}

export type EditorProps = {
  catalog: NotificationCatalog;
  categories: NotificationCategory[];
  rule?: NotificationRule;
  initial: RuleDraft;
  canManage: boolean;
  /** Edits a subscription of the signed-in person instead of a central rule. */
  personal?: boolean;
};

export function RuleEditor({ catalog, categories, rule, initial, canManage, personal = false }: EditorProps) {
  const back = personal ? personalListPath : listPath;
  const newPath = personal ? `${personalSubscriptionPath}/new` : `${listPath}/rules/new`;
  const noun = personal ? 'Subscription' : 'Rule';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<RuleDraft>({ defaultValues: initial });
  const draft = form.watch();
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty && canManage });
  const personIds = [
    ...new Set(
      [...draft.definition.actions, ...(draft.definition.escalation?.steps.map((step) => step.action) ?? [])]
        .flatMap((action) => action.recipients)
        .filter((key) => key.startsWith('person:'))
        .map((key) => key.slice(7)),
    ),
  ];
  const lookup = useNameLookup(personIds);
  const category = categories.find((candidate) => candidate.id === draft.categoryId);

  const save = useMutation({
    mutationFn: (values: RuleDraft) =>
      personal
        ? rule
          ? updateOwnNotificationSubscription(rule.id, { expectedVersion: rule.version, ...toInput(values) })
          : createOwnNotificationSubscription(toInput(values))
        : rule
          ? updateNotificationRule(rule.id, { expectedVersion: rule.version, ...toInput(values) })
          : createNotificationRule(toInput(values)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationCenterKeys.all });
      guard.bypassAfterSubmit(() => navigate(back));
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      personal
        ? deleteOwnNotificationSubscription(rule!.id, { expectedVersion: rule!.version })
        : deleteNotificationRule(rule!.id, { expectedVersion: rule!.version }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: notificationCenterKeys.all });
      setConfirmDelete(false);
      guard.bypassAfterSubmit(() => navigate(back));
    },
  });

  const edit: StepProps['edit'] = (recipe, options) => {
    const next = clone(draft.definition) as Definition;
    recipe(next);
    form.setValue('definition', options?.prune ? pruneDefinition(catalog, next) : next, { shouldDirty: true });
  };
  const stepProps: StepProps = { catalog, definition: draft.definition, lookup, edit, personal };

  const submit = form.handleSubmit((values) => {
    const found = validateDraft(catalog, values, personal);
    setProblems(found);
    if (found.length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    save.mutate(values);
  });
  const problem = save.isError ? saveProblem(save.error, noun) : null;
  const nameProblem = problem?.reason.startsWith('name') ? problem.reason : undefined;

  const group = settingsGroup(settingsItem('notification-center').group);
  const breadcrumbs = personal
    ? [
        { label: 'Your account', to: '/profile' },
        { label: 'My notifications', to: personalListPath },
      ]
    : [
        { label: 'Settings', to: '/settings' },
        { label: group.title, to: `/settings#${group.id}` },
        { label: 'Notification center', to: listPath },
      ];
  const unsaved = form.formState.isDirty && canManage;

  return (
    <PageShell
      title={rule ? rule.name : `New ${noun.toLowerCase()}`}
      width="wide"
      breadcrumbs={breadcrumbs}
      actions={
        <div className="nc-header-actions">
          {unsaved && (
            <Tag type="warm-gray" size="md">
              Unsaved changes
            </Tag>
          )}
          {rule && (
            <IconButton
              kind="ghost"
              label={`Duplicate ${noun.toLowerCase()}`}
              align="bottom"
              onClick={() => guard.requestDiscard(() => navigate(newPath, { state: { template: rule } }))}
            >
              <Copy />
            </IconButton>
          )}
          {rule && canManage && !rule.systemKey && (
            <IconButton
              ref={deleteButton}
              kind="ghost"
              label={`Delete ${noun.toLowerCase()}`}
              align="bottom"
              onClick={() => setConfirmDelete(true)}
            >
              <TrashCan />
            </IconButton>
          )}
          <Button kind="secondary" size="md" onClick={() => guard.requestDiscard(() => navigate(back))}>
            {canManage ? 'Cancel' : 'Back'}
          </Button>
          {canManage && (
            <Button kind="primary" size="md" disabled={save.isPending} onClick={() => void submit()}>
              {rule ? 'Save' : 'Create'}
            </Button>
          )}
        </div>
      }
    >
      {!canManage && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="View only"
          subtitle="You can see this rule but not change it."
        />
      )}
      {problems.length > 0 && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Fix these before saving">
          <ul className="nc-problems">
            {problems.map((entry) => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </InlineNotification>
      )}
      {problem && (
        <InlineNotification kind="error" lowContrast hideCloseButton title={problem.title} subtitle={problem.message}>
          {problem.stale && (
            <Button
              kind="tertiary"
              size="sm"
              onClick={() => void queryClient.invalidateQueries({ queryKey: notificationCenterKeys.all })}
            >
              Reload the rule
            </Button>
          )}
        </InlineNotification>
      )}
      <fieldset className="nc-fieldset" disabled={!canManage}>
        <legend className="cds--visually-hidden">{noun}</legend>
        <div className="nc-head">
          <TextInput
            id="nc-name"
            labelText="Name"
            maxLength={120}
            invalid={Boolean(nameProblem)}
            invalidText={nameProblem}
            {...form.register('name')}
          />
          {!personal && (
            <>
              <TextInput
                id="nc-description"
                labelText="Description"
                maxLength={500}
                {...form.register('description')}
              />
              <Select
                id="nc-category"
                labelText="Category"
                helperText={categoryHint(category)}
                {...form.register('categoryId')}
              >
                <SelectItem value="" text="Choose a category" />
                {categories.map((candidate) => (
                  <SelectItem
                    key={candidate.id}
                    value={candidate.id}
                    text={`${candidate.name}${candidate.basis === 'consent' ? ' · needs consent' : ''}`}
                  />
                ))}
              </Select>
            </>
          )}
          <Toggle
            id="nc-enabled"
            labelText={noun}
            labelA="Off"
            labelB="On"
            toggled={draft.enabled}
            onToggle={(on) => form.setValue('enabled', on, { shouldDirty: true })}
          />
        </div>
        <div className="nc-grid">
          <div className="nc-flow">
            <WhenStep {...stepProps} />
            <LoopStep {...stepProps} />
            <ConditionsStep {...stepProps} />
            <ThenStep {...stepProps} />
            {!personal && <EscalationStep {...stepProps} />}
            <LimitsStep
              {...stepProps}
              mandatory={draft.mandatory}
              onMandatory={personal ? undefined : (next) => form.setValue('mandatory', next, { shouldDirty: true })}
            />
          </div>
          <PreviewColumn catalog={catalog} definition={draft.definition} lookup={lookup} />
        </div>
      </fieldset>
      <UnsavedChangesDialog guard={guard} />
      <DestructiveActionDialog
        open={confirmDelete}
        title={`Delete “${rule?.name ?? ''}”?`}
        fate="permanent"
        confirmLabel={`Delete ${noun.toLowerCase()}`}
        pending={remove.isPending}
        error={remove.isError ? saveProblem(remove.error, noun).message : undefined}
        launcherButtonRef={deleteButton}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
      >
        <p>
          {personal
            ? "You won't get these messages any more."
            : "Nobody gets these messages any more, and people's mutes for this rule are removed."}
        </p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

/** Loads what the editor needs, then mounts it keyed by the rule version so a reload starts from the server state. */
export function RuleEditorPage() {
  const { ruleId } = useParams();
  const [search] = useSearchParams();
  const location = useLocation();
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.notification_rulesmanage);
  const catalog = useQuery(catalogQuery());
  const categories = useQuery(categoriesQuery());
  const rule = useQuery({ ...ruleQuery(ruleId ?? ''), enabled: Boolean(ruleId) });

  const queries = [catalog, categories, ...(ruleId ? [rule] : [])];
  if (queries.some((query) => query.status === 'error')) {
    return (
      <PageShell title="Rule" width="wide">
        <ErrorState
          message="The rule could not be loaded."
          onRetry={() => queries.forEach((query) => void query.refetch())}
        />
      </PageShell>
    );
  }
  if (!catalog.data || !categories.data || (ruleId && !rule.data)) {
    return (
      <PageShell title="Rule" width="wide">
        <SettingsLoading label="Loading rule" />
      </PageShell>
    );
  }

  const template = (location.state as { template?: NotificationRule } | null)?.template;
  let initial: RuleDraft;
  if (rule.data) {
    initial = draftFromRule(rule.data);
  } else if (template) {
    // A copy starts switched off so it cannot double-send until it has been looked at.
    initial = { ...draftFromRule(template), name: `Copy of ${template.name}`, enabled: false };
  } else {
    const requested = search.get('type');
    const kind = kinds.find((candidate) => candidate === requested) ?? 'event';
    const preferred = categories.data.items.find((category) => category.key === 'service') ?? categories.data.items[0];
    initial = {
      name: '',
      description: '',
      categoryId: preferred?.id ?? '',
      enabled: true,
      mandatory: false,
      definition: blankDefinition(catalog.data, kind),
    };
  }
  return (
    <RuleEditor
      key={`${rule.data?.id ?? 'new'}-${rule.data?.version ?? 0}`}
      catalog={catalog.data}
      categories={categories.data.items}
      rule={rule.data}
      initial={initial}
      canManage={canManage}
    />
  );
}
