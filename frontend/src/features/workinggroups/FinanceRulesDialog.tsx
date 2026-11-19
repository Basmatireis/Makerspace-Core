import { useState } from 'react';
import { Button, IconButton, InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { Checkmark, Edit, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { WorkingGroupFinanceRules, WorkingGroupProjectRequest } from '../../api/generated/models';
import {
  createWorkingGroupProjectRequest,
  deleteWorkingGroupProjectRequest,
  setWorkingGroupFinanceRules,
  updateWorkingGroupProjectRequest,
} from '../../api/generated/working-groups/working-groups';
import { fromCents, moneyInputText, parseMoneyInput, toCents } from '../orders/money';
import { financeRulesOptions } from './financeQueries';
import { taskErrorText, useWgMutation } from './useWgMutation';

/** Project and offers thresholds and the standing project requests. */
export function FinanceRulesDialog({ onClose }: { onClose: () => void }) {
  const query = useQuery(financeRulesOptions);
  return (
    <Modal open passiveModal size="md" modalHeading="Rules and limits" onRequestClose={onClose}>
      {query.isError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="The rules could not be loaded" />
      )}
      {query.data ? <Rules key={query.data.version} rules={query.data} /> : <p className="wg-muted">Loading…</p>}
    </Modal>
  );
}

function Rules({ rules }: { rules: WorkingGroupFinanceRules }) {
  const [project, setProject] = useState(moneyInputText(toCents(rules.projectThreshold)));
  const [offers, setOffers] = useState(moneyInputText(toCents(rules.offersThreshold)));
  const [touched, setTouched] = useState(false);
  const projectCents = parseMoneyInput(project);
  const offersCents = parseMoneyInput(offers);
  const save = useWgMutation(() =>
    setWorkingGroupFinanceRules({
      expectedVersion: rules.version,
      projectThreshold: fromCents(projectCents ?? 0),
      offersThreshold: fromCents(offersCents ?? 0),
    }),
  );
  return (
    <Stack gap={6}>
      <Stack gap={5}>
        <TextInput
          id="wg-rule-project"
          labelText="Project threshold"
          inputMode="decimal"
          value={project}
          invalid={touched && projectCents === null}
          invalidText="Enter an amount."
          onChange={(event) => setProject(event.target.value)}
        />
        <TextInput
          id="wg-rule-offers"
          labelText="Offers threshold"
          inputMode="decimal"
          value={offers}
          invalid={touched && offersCents === null}
          invalidText="Enter an amount."
          onChange={(event) => setOffers(event.target.value)}
        />
        {save.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not saved"
            subtitle={taskErrorText(save.error, 'Reload and try again.')}
          />
        )}
        <div>
          <Button
            kind="primary"
            size="md"
            disabled={save.isPending}
            onClick={() => {
              setTouched(true);
              if (projectCents !== null && offersCents !== null) save.mutate();
            }}
          >
            Save limits
          </Button>
        </div>
      </Stack>
      <ProjectRequests requests={rules.projectRequests} />
    </Stack>
  );
}

function ProjectRequests({ requests }: { requests: readonly WorkingGroupProjectRequest[] }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const save = useWgMutation(() =>
    editing === 'new'
      ? createWorkingGroupProjectRequest({ number: number.trim(), label: label.trim() })
      : updateWorkingGroupProjectRequest(editing as string, { number: number.trim(), label: label.trim() }),
  );
  const remove = useWgMutation((id: string) => deleteWorkingGroupProjectRequest(id));
  const edit = (request: WorkingGroupProjectRequest | null) => {
    setEditing(request?.id ?? 'new');
    setNumber(request?.number ?? '');
    setLabel(request?.label ?? '');
    save.reset();
  };
  return (
    <section aria-labelledby="wg-projects-h">
      <h3 id="wg-projects-h" className="wg-subhead">
        Project requests
      </h3>
      <ul className="wg-rules-list">
        {requests.map((request) =>
          editing === request.id ? (
            <li key={request.id}>{editor()}</li>
          ) : (
            <li key={request.id} className="wg-rules-list__row">
              <span>
                <strong>{request.number}</strong> {request.label}
              </span>
              <IconButton kind="ghost" size="sm" label={`Edit ${request.number}`} onClick={() => edit(request)}>
                <Edit />
              </IconButton>
              <IconButton
                kind="ghost"
                size="sm"
                label={`Remove ${request.number}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(request.id)}
              >
                <TrashCan />
              </IconButton>
            </li>
          ),
        )}
        {requests.length === 0 && editing !== 'new' && <li className="wg-muted">None yet.</li>}
        {editing === 'new' && <li>{editor()}</li>}
      </ul>
      {remove.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not removed"
          subtitle={taskErrorText(remove.error, 'Try again.')}
        />
      )}
      {editing === null && (
        <Button kind="tertiary" size="md" onClick={() => edit(null)}>
          Add a project request
        </Button>
      )}
    </section>
  );

  function editor() {
    return (
      <div className="wg-rules-edit">
        <TextInput id="wg-pr-number" labelText="Number" value={number} onChange={(e) => setNumber(e.target.value)} />
        <TextInput id="wg-pr-label" labelText="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <IconButton
          kind="primary"
          size="md"
          label="Save project request"
          disabled={save.isPending || number.trim() === '' || label.trim() === ''}
          onClick={() => save.mutate(undefined, { onSuccess: () => setEditing(null) })}
        >
          <Checkmark />
        </IconButton>
        <Button kind="ghost" size="md" onClick={() => setEditing(null)}>
          Cancel
        </Button>
        {save.isError && <p className="wg-buyrow__error">{taskErrorText(save.error, 'Not saved.')}</p>}
      </div>
    );
  }
}
