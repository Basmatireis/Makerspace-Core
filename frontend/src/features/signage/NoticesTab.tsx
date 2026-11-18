import { useState } from 'react';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  InlineNotification,
  Link as CarbonLink,
  Stack,
  Tag,
  Toggle,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { notificationCenterKeys } from '../notificationcenter/queries';
import type { SignageNoticeSelection } from '../../api/generated/models';
import { setSignageDisplayNotices, setSignageGroupNotices } from '../../api/generated/signage/signage';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { errorMessage } from './helpers';
import { signagePaths } from './paths';
import { groupQuery, noticeRulesQuery, noticesQuery, signageKeys } from './queries';

type Owner = { kind: 'display' | 'group'; id: string };

const sameSelection = (a: SignageNoticeSelection, b: SignageNoticeSelection) =>
  a.allRules === b.allRules && a.ruleIds.length === b.ruleIds.length && a.ruleIds.every((id) => b.ruleIds.includes(id));

/** Which notices of notification rules a display or group shows. Saved at once: there is nothing to publish. */
export function NoticesTab({
  owner,
  groupId,
  canManage,
}: {
  owner: Owner;
  groupId?: string | null;
  canManage: boolean;
}) {
  const rules = useQuery(noticeRulesQuery());
  const selection = useQuery(noticesQuery(owner));
  const noun = owner.kind === 'group' ? 'group' : 'display';
  if (rules.isPending || selection.isPending) return <FullPageLoading label="Loading notices" />;
  if (rules.isError || selection.isError)
    return (
      <ErrorState
        message={errorMessage(rules.error ?? selection.error, 'The notices could not be loaded.')}
        onRetry={() => void Promise.all([rules.refetch(), selection.refetch()])}
      />
    );
  const available = rules.data.items.filter((rule) => rule.hasSignageAction);
  return (
    <Stack gap={5}>
      <p className="sg-secondary">
        Notices that notification rules show on this {noun}: a short message that lies over the running scene. A change
        takes effect at once; nothing needs to be published. A {noun} shows no notices until you choose some.
      </p>
      {groupId ? <GroupNotices groupId={groupId} /> : null}
      {available.length === 0 && selection.data.ruleIds.length === 0 ? (
        <EmptyState
          title="No rule shows notices on signage"
          description="Add a signage action to a rule in the Notification center, then choose it here."
          action={
            <CarbonLink as={Link} to="/settings/notifications">
              Notification center
            </CarbonLink>
          }
        />
      ) : (
        <NoticesForm
          key={owner.id}
          owner={owner}
          noun={noun}
          saved={selection.data}
          rules={rules.data.items}
          canManage={canManage}
        />
      )}
    </Stack>
  );
}

/** A display in a group shows its own choice plus the group's; the group's part is edited on the group. */
function GroupNotices({ groupId }: { groupId: string }) {
  const group = useQuery(groupQuery(groupId)).data;
  const selection = useQuery(noticesQuery({ kind: 'group', id: groupId }));
  const rules = useQuery(noticeRulesQuery()).data?.items ?? [];
  const names = (selection.data?.ruleIds ?? []).map(
    (id) => rules.find((rule) => rule.id === id)?.name ?? 'Unknown rule',
  );
  return (
    <div>
      <h3 className="sg-section-title">From its group</h3>
      <p className="sg-secondary">
        This display also shows the notices that group{' '}
        <CarbonLink as={Link} to={signagePaths.group(groupId)}>
          {group?.name ?? 'its group'}
        </CarbonLink>{' '}
        chose. Both choices are added together; a notice cannot be switched off here that the group shows.
      </p>
      {selection.isSuccess && (
        <p>{selection.data.allRules ? 'All signage notices' : names.length ? names.join(', ') : 'No notices'}</p>
      )}
    </div>
  );
}

function NoticesForm({
  owner,
  noun,
  saved,
  rules,
  canManage,
}: {
  owner: Owner;
  noun: string;
  saved: SignageNoticeSelection;
  rules: { id: string; name: string; enabled: boolean; hasSignageAction: boolean }[];
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  // Without edits the form follows the saved choice. With edits, a choice saved elsewhere meanwhile does not overwrite
  // them but is pointed out.
  const [draft, setDraft] = useState<SignageNoticeSelection>(saved);
  const [base, setBase] = useState<SignageNoticeSelection>(saved);
  const [savedOnce, setSavedOnce] = useState(false);
  const edited = !sameSelection(draft, base);
  const shown = edited ? draft : saved;
  const dirty = !sameSelection(shown, saved);
  const changedElsewhere = edited && !sameSelection(base, saved);
  const save = useMutation({
    mutationFn: (body: SignageNoticeSelection) =>
      owner.kind === 'group' ? setSignageGroupNotices(owner.id, body) : setSignageDisplayNotices(owner.id, body),
    onSuccess: async (updated) => {
      queryClient.setQueryData(signageKeys.notices(owner), updated);
      setDraft(updated);
      setBase(updated);
      setSavedOnce(true);
      // The group's choice shown on its displays and the rule editor's "Shown on" list read from the server too.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: signageKeys.all,
          predicate: (query) => String(query.queryKey[1]).endsWith('-notices'),
        }),
        queryClient.invalidateQueries({ queryKey: notificationCenterKeys.all }),
      ]);
    },
  });
  const edit = (next: (current: SignageNoticeSelection) => SignageNoticeSelection) => {
    save.reset();
    setSavedOnce(false);
    if (!edited) setBase(saved);
    setDraft(next(shown));
  };
  const toggle = (id: string, on: boolean) =>
    edit((current) => ({
      ...current,
      ruleIds: on ? [...current.ruleIds, id] : current.ruleIds.filter((candidate) => candidate !== id),
    }));
  return (
    <Stack gap={5}>
      <Toggle
        id={`${owner.kind}-notices-all`}
        labelText="All signage notices"
        labelA="Off"
        labelB="On"
        toggled={shown.allRules}
        readOnly={!canManage}
        onToggle={(on) => edit((current) => ({ ...current, allRules: on }))}
      />
      {changedElsewhere && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Changed elsewhere"
          subtitle={`Someone else saved this ${noun}'s notices meanwhile. Saving replaces their choice with yours.`}
        />
      )}
      <CheckboxGroup legendText={`Rules whose notices this ${noun} shows`} readOnly={!canManage}>
        {rules.map((rule) => (
          <div key={rule.id} className="sg-notice-rule">
            <Checkbox
              id={`${owner.kind}-notice-${rule.id}`}
              labelText={rule.name}
              checked={shown.allRules || shown.ruleIds.includes(rule.id)}
              disabled={!canManage || shown.allRules}
              onChange={(_event, { checked }) => toggle(rule.id, checked)}
            />
            {!rule.enabled && <Tag type="gray">Rule is off</Tag>}
            {!rule.hasSignageAction && <Tag type="warm-gray">No signage action any more</Tag>}
          </div>
        ))}
      </CheckboxGroup>
      {save.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not saved"
          subtitle={errorMessage(save.error)}
        />
      )}
      {savedOnce && !dirty && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          role="status"
          title="Saved"
          subtitle="Shown at once."
        />
      )}
      {canManage ? (
        <div>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(shown)}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      ) : (
        <p className="sg-secondary">You can see this choice but not change it.</p>
      )}
    </Stack>
  );
}
