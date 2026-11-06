import {
  Button,
  IconButton,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Tag,
  TextInput,
  Toggle,
} from '@carbon/react';
import { Copy, Play, SendAlt, TrashCan } from '@carbon/icons-react';
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
  runNotificationRule,
  testNotificationRule,
  updateNotificationRule,
  updateOwnNotificationSubscription,
} from '../../api/generated/notification-rules/notification-rules';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { useNotify } from '../../app/toasts';
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
import { useDryRun } from './editor/useDryRun';
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
  collectionOf,
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
  const [confirmRun, setConfirmRun] = useState(false);
  const notify = useNotify();
  const dry = useDryRun(draft, personal);
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
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: notificationCenterKeys.all });
      // A rule saved with warnings stays open, so they are read before the list takes over.
      const stay = saved.warnings?.length
        ? `${personal ? personalSubscriptionPath : `${listPath}/rules`}/${saved.id}`
        : back;
      guard.bypassAfterSubmit(() => navigate(stay));
    },
  });
  const afterSend = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: notificationCenterKeys.activity() }),
      queryClient.invalidateQueries({ queryKey: notificationCenterKeys.rules() }),
    ]);
  const run = useMutation({
    mutationFn: () => runNotificationRule(rule!.id),
    onSuccess: async (result) => {
      const sent = result.sent.inApp + result.sent.email;
      notify({
        kind: sent ? 'success' : 'info',
        title: sent ? `Sent ${sent} ${sent === 1 ? 'message' : 'messages'}` : 'Nothing sent',
        subtitle: `${result.sent.inApp} in-app, ${result.sent.email} e-mail. Looked at ${result.itemsExamined}, ${result.matched} matched.`,
      });
      await afterSend();
    },
    onError: (error) => notify({ kind: 'error', title: 'Run failed', subtitle: saveProblem(error, 'Rule').message }),
  });
  const test = useMutation({
    mutationFn: () => testNotificationRule(rule!.id),
    onSuccess: async (result) => {
      const sent = result.sent.inApp + result.sent.email;
      notify({
        kind: sent ? 'success' : 'info',
        title: sent ? 'Test sent to you' : 'Nothing to send you',
        subtitle: sent
          ? `${result.sent.inApp} in-app, ${result.sent.email} e-mail. It shows up under Activity as a test.`
          : 'None of the actions reaches you in the app or by e-mail.',
      });
      await afterSend();
    },
    onError: (error) => notify({ kind: 'error', title: 'Test failed', subtitle: saveProblem(error, 'Rule').message }),
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
  const savedTrigger = rule?.definition.trigger.type;
  const canRun = Boolean(rule) && !personal && canManage && (savedTrigger === 'manual' || savedTrigger === 'schedule');
  const canTest = Boolean(rule) && !personal && canManage;
  const unsavedReason = 'Save your changes first: this works on the saved rule.';
  const savedCollection = rule ? collectionOf(catalog, rule.definition) : undefined;
  const loopMode = rule?.definition.loop?.mode;
  const runWhat = !savedCollection
    ? 'It sends the messages once, right now.'
    : loopMode === 'each'
      ? dry.data
        ? `It looks at all ${dry.data.totalItems} ${savedCollection.plural} and sends a message to each one that matches (${dry.data.matchedItems} right now).`
        : `It looks at all ${savedCollection.plural} and sends a message to each one that matches.`
      : `It counts the matching ${savedCollection.plural} and sends one summary if the conditions hold.`;

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
          {canTest && (
            <span title={unsaved ? unsavedReason : undefined}>
              <Button
                kind="tertiary"
                size="md"
                renderIcon={SendAlt}
                disabled={unsaved || test.isPending}
                onClick={() => test.mutate()}
              >
                Send a test to me
              </Button>
            </span>
          )}
          {canRun && (
            <span title={unsaved ? unsavedReason : undefined}>
              <Button
                kind="tertiary"
                size="md"
                renderIcon={Play}
                disabled={unsaved || run.isPending}
                onClick={() => setConfirmRun(true)}
              >
                Run now
              </Button>
            </span>
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
      {rule && rule.warnings.length > 0 && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Check this rule">
          <ul className="nc-problems">
            {rule.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
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
          <PreviewColumn
            catalog={catalog}
            definition={draft.definition}
            lookup={lookup}
            dry={dry}
            personal={personal}
          />
        </div>
      </fieldset>
      <UnsavedChangesDialog guard={guard} />
      {canRun && confirmRun && (
        <Modal
          open
          size="sm"
          modalHeading={`Run “${rule?.name ?? ''}” now?`}
          modalLabel="Run now"
          primaryButtonText="Run now"
          secondaryButtonText="Cancel"
          onRequestClose={() => setConfirmRun(false)}
          onRequestSubmit={() => {
            setConfirmRun(false);
            run.mutate();
          }}
        >
          <p>{runWhat} The run shows up under Activity.</p>
        </Modal>
      )}
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
