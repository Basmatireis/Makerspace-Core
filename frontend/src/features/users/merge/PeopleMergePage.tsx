import { useState } from 'react';
import {
  Button,
  Checkbox,
  InlineNotification,
  Link as CarbonLink,
  ProgressIndicator,
  ProgressStep,
  Stack,
} from '@carbon/react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { PeopleMergePreview, PeopleMergeResult, Person } from '../../../api/generated/models';
import { mergePeople, previewPeopleMerge } from '../../../api/generated/people/people';
import { clearPrivateQueryData } from '../../../api/query-client';
import { PageShell } from '../../../app/PageShell';
import { useCurrentUser } from '../../auth/auth';
import { peopleKeys, personOptions } from '../queries';
import './merge.scss';
import { MergePreviewStep } from './MergePreviewStep';
import { MergeSelectStep } from './MergeSelectStep';
import {
  buildFieldSources,
  categoryLabels,
  defaultFieldChoices,
  describeMergeFailure,
  expectedVersions,
  MAX_MERGE_PEOPLE,
  type FieldChoices,
  type MergeFailure,
} from './mergeFields';

const STEPS = ['Select people', 'Compare', 'Confirm', 'Done'] as const;
const personName = (person: Pick<Person, 'firstName' | 'lastName'>) => `${person.firstName} ${person.lastName}`;

/** Wizard that folds duplicate people into one. The service decides everything; this page only presents it. */
export function PeopleMergePage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const initialIds = [...new Set(searchParams.getAll('person'))].slice(0, MAX_MERGE_PEOPLE);
  const [ids, setIds] = useState<string[]>(initialIds);
  const [targetId, setTargetId] = useState<string | null>(searchParams.get('target') ?? initialIds[0] ?? null);
  const [step, setStep] = useState(0);
  const [preview, setPreview] = useState<PeopleMergePreview | null>(null);
  const [choices, setChoices] = useState<FieldChoices>({});
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<MergeFailure | null>(null);
  const [result, setResult] = useState<PeopleMergeResult | null>(null);

  // Display data for the selection; people added through the search are seeded into the same cache.
  const personQueries = useQueries({ queries: ids.map((id) => personOptions(id)) });
  const people = personQueries.flatMap((query) => (query.data ? [query.data] : []));
  const loadingPeople = personQueries.some((query) => query.isPending);

  const previewMutation = useMutation({
    mutationFn: () => {
      const sources = ids.filter((id) => id !== targetId);
      return previewPeopleMerge({ targetPersonId: targetId!, sourcePersonIds: sources });
    },
    onSuccess: (next) => {
      setPreview(next);
      setChoices(defaultFieldChoices(next));
      setConfirmed(false);
      setFailure(null);
      setStep(1);
    },
  });

  const mergeMutation = useMutation({
    mutationFn: (current: PeopleMergePreview) =>
      mergePeople({
        targetPersonId: current.targetPersonId,
        sourcePersonIds: current.people.filter((person) => person.id !== current.targetPersonId).map((p) => p.id),
        expectedVersions: expectedVersions(current),
        fieldSources: buildFieldSources(current, choices),
      }),
    onSuccess: async (merged, current) => {
      setFailure(null);
      setResult(merged);
      setStep(3);
      // Merging into oneself ends every session, so refreshing server state would only trigger a 401 redirect.
      if (currentUser.person.id === current.targetPersonId) return;
      for (const personId of merged.mergedPersonIds)
        queryClient.removeQueries({ queryKey: peopleKeys.detail(personId) });
      await queryClient.invalidateQueries({ queryKey: peopleKeys.all });
    },
    onError: (error) => setFailure(describeMergeFailure(error)),
  });

  const removePerson = (personId: string) => {
    const next = ids.filter((id) => id !== personId);
    setIds(next);
    if (targetId === personId) setTargetId(next[0] ?? null);
  };
  const canPreview = ids.length >= 2 && ids.length <= MAX_MERGE_PEOPLE && targetId !== null && !loadingPeople;
  const selfMerge = result !== null && preview !== null && currentUser.person.id === preview.targetPersonId;

  const rerunPreview = () => {
    setFailure(null);
    previewMutation.mutate();
  };

  return (
    <PageShell
      title="Merge people"
      breadcrumbs={[{ label: 'Directory' }, { label: 'People', to: '/people' }, { label: 'Merge people' }]}
      description="Fold duplicate people into one. The others and their accounts are permanently deleted."
      width="wide"
    >
      <Stack gap={6}>
        <ProgressIndicator currentIndex={step} spaceEqually>
          {STEPS.map((label) => (
            <ProgressStep key={label} label={label} />
          ))}
        </ProgressIndicator>

        {previewMutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={describeMergeFailure(previewMutation.error).title}
            subtitle={describeMergeFailure(previewMutation.error).messages.join(' ')}
          />
        )}

        {step === 0 && (
          <>
            <MergeSelectStep
              people={people}
              targetId={targetId}
              onAdd={(person) => !ids.includes(person.id) && setIds([...ids, person.id])}
              onRemove={removePerson}
              onTarget={setTargetId}
            />
            <div className="people-merge__actions">
              <Button kind="secondary" onClick={() => navigate('/people')}>
                Cancel
              </Button>
              <Button kind="primary" disabled={!canPreview || previewMutation.isPending} onClick={rerunPreview}>
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 1 && preview && (
          <>
            <MergePreviewStep
              preview={preview}
              choices={choices}
              onChoose={(field, personId) => setChoices({ ...choices, [field]: personId })}
            />
            <div className="people-merge__actions">
              <Button kind="secondary" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button kind="primary" disabled={!preview.canMerge} onClick={() => setStep(2)}>
                Continue
              </Button>
            </div>
          </>
        )}

        {step === 2 && preview && (
          <>
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="This cannot be undone"
              subtitle={`${preview.people
                .filter((person) => person.id !== preview.targetPersonId)
                .map(personName)
                .join(
                  ', ',
                )} will be permanently deleted together with their accounts. Their records move to ${personName(
                preview.people.find((person) => person.id === preview.targetPersonId) ?? preview.people[0],
              )}.`}
            />
            {currentUser.person.id === preview.targetPersonId && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="You will be signed out"
                subtitle="Merging revokes every session of the involved accounts, including yours. Sign in again afterwards."
              />
            )}
            {failure && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title={failure.title}
                subtitle={failure.messages.join(' ')}
              />
            )}
            <Checkbox
              id="merge-confirm"
              labelText={`I understand that ${preview.people.length - 1} ${
                preview.people.length === 2 ? 'person is' : 'people are'
              } deleted permanently`}
              checked={confirmed}
              onChange={(_event, { checked }) => setConfirmed(checked)}
            />
            <div className="people-merge__actions">
              <Button kind="secondary" onClick={() => setStep(1)} disabled={mergeMutation.isPending}>
                Back
              </Button>
              {failure?.kind === 'stale' && (
                <Button kind="tertiary" onClick={rerunPreview} disabled={previewMutation.isPending}>
                  Run preview again
                </Button>
              )}
              <Button
                kind="danger"
                disabled={!confirmed || mergeMutation.isPending || failure?.kind === 'stale'}
                onClick={() => mergeMutation.mutate(preview)}
              >
                {`Merge ${preview.people.length} people`}
              </Button>
            </div>
          </>
        )}

        {step === 3 && result && (
          <>
            <InlineNotification
              kind="success"
              lowContrast
              hideCloseButton
              title="People merged"
              subtitle={`${result.mergedPersonIds.length} ${result.mergedPersonIds.length === 1 ? 'person was' : 'people were'} merged into ${personName(result.person)}.`}
            />
            {selfMerge && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Your sessions ended"
                subtitle="You merged into your own person, so you need to sign in again."
              />
            )}
            {result.moved.length > 0 && (
              <p>{result.moved.map((item) => `${categoryLabels[item.category]}: ${item.count}`).join(' · ')}</p>
            )}
            {selfMerge ? (
              <Button
                onClick={() => {
                  clearPrivateQueryData();
                  navigate('/login', { replace: true });
                }}
              >
                Sign in again
              </Button>
            ) : (
              <CarbonLink as={Link} to={`/people/${result.person.id}`}>
                Open {personName(result.person)}
              </CarbonLink>
            )}
          </>
        )}
      </Stack>
    </PageShell>
  );
}
