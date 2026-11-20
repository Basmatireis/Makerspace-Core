import { useMemo, useRef, useState } from 'react';
import {
  Button,
  ContentSwitcher,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Search,
  Switch,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkingGroupLinkedTask, WorkingGroupTaskLink } from '../../api/generated/models';
import { setWorkingGroupTicketLink, setWorkingGroupTodoLink } from '../../api/generated/working-groups/working-groups';
import { DetailPanelSection } from '../../app/components/DetailPanel';
import { PURCHASE_STATUS_LABEL } from './financeModel';
import { purchasesOptions } from './financeQueries';
import { PROJECT_STATUS_LABEL } from './projectModel';
import { projectsOptions } from './projectQueries';
import { projectLink, purchaseLink, taskItemLink } from './linkModel';
import { type Task } from './taskModel';
import { saveErrorText, useWgMutation } from './useWgMutation';

const statusText = (link: WorkingGroupTaskLink) =>
  (link.kind === 'purchase'
    ? PURCHASE_STATUS_LABEL[link.status as keyof typeof PURCHASE_STATUS_LABEL]
    : PROJECT_STATUS_LABEL[link.status as keyof typeof PROJECT_STATUS_LABEL]) ?? link.status;

/** "Belongs to: <title> (status)" with Link or Unlink. Only shown to people who may edit the item. */
export function TaskLinkLine({
  task,
  link,
  canEdit,
  canSeeTargets,
}: {
  task: Task;
  link?: WorkingGroupTaskLink;
  canEdit: boolean;
  /** Purchases and projects are visible to members of the group and finance managers only. */
  canSeeTargets: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const line = useRef<HTMLDivElement>(null);
  const isTicket = task.kind === 'ticket';
  const save = useWgMutation((body: { purchaseId?: string; projectId?: string }) =>
    isTicket
      ? setWorkingGroupTicketLink(task.id, { expectedVersion: task.version, ...body })
      : setWorkingGroupTodoLink(task.id, { expectedVersion: task.version, ...body }),
  );
  if (!link && !canEdit) return null;
  const error = saveErrorText(save.error);
  // The Link and Unlink buttons replace each other, so focus moves to the stable line, not to a vanished button.
  const settle = () => window.setTimeout(() => line.current?.focus(), 0);
  return (
    <div className="wg-linkline" ref={line} tabIndex={-1}>
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
      <p>
        {link ? (
          <>
            Belongs to:{' '}
            <CarbonLink
              as={Link}
              to={link.kind === 'purchase' ? purchaseLink(task.groupId, link.id) : projectLink(link.id)}
            >
              {link.title}
            </CarbonLink>{' '}
            <span className="wg-muted">({statusText(link)})</span>
          </>
        ) : (
          <span className="wg-muted">Not linked to a purchase or project.</span>
        )}
      </p>
      {canEdit &&
        (link ? (
          <Button
            kind="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate({}, { onSuccess: settle })}
          >
            Unlink
          </Button>
        ) : (
          <Button kind="tertiary" size="sm" onClick={() => setPicking(true)}>
            Link
          </Button>
        ))}
      {picking && (
        <LinkDialog
          groupId={task.groupId}
          canSeeTargets={canSeeTargets}
          pending={save.isPending}
          onClose={() => {
            setPicking(false);
            settle();
          }}
          onPick={(body) =>
            save.mutate(body, {
              onSuccess: () => {
                setPicking(false);
                settle();
              },
            })
          }
        />
      )}
    </div>
  );
}

/** Pick ONE purchase or project of the group. */
function LinkDialog({
  groupId,
  canSeeTargets,
  pending,
  onClose,
  onPick,
}: {
  groupId: string;
  canSeeTargets: boolean;
  pending: boolean;
  onClose: () => void;
  onPick: (body: { purchaseId?: string; projectId?: string }) => void;
}) {
  const [tab, setTab] = useState<'purchase' | 'project'>('purchase');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<{ kind: 'purchase' | 'project'; id: string } | null>(null);
  const purchases = useQuery({ ...purchasesOptions({ groupId }), enabled: canSeeTargets });
  const projects = useQuery({ ...projectsOptions({ groupId }), enabled: canSeeTargets });
  const needle = search.trim().toLowerCase();
  const options = useMemo(() => {
    const items =
      tab === 'purchase'
        ? (purchases.data?.items ?? []).map((p) => ({ id: p.id, title: p.item, sub: PURCHASE_STATUS_LABEL[p.status] }))
        : (projects.data?.items ?? []).map((p) => ({ id: p.id, title: p.title, sub: PROJECT_STATUS_LABEL[p.status] }));
    return items.filter((item) => !needle || item.title.toLowerCase().includes(needle));
  }, [tab, purchases.data, projects.data, needle]);
  const query = tab === 'purchase' ? purchases : projects;
  return (
    <Modal
      open
      size="sm"
      modalHeading="Link to a purchase or project"
      primaryButtonText="Link"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={chosen === null || pending}
      onRequestClose={onClose}
      onRequestSubmit={() => {
        if (chosen) onPick(chosen.kind === 'purchase' ? { purchaseId: chosen.id } : { projectId: chosen.id });
      }}
    >
      {!canSeeTargets ? (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="You cannot see the purchases and projects of this group."
          subtitle="Members of the group and finance managers can link work to them."
        />
      ) : (
        <>
          <ContentSwitcher
            size="md"
            selectedIndex={tab === 'purchase' ? 0 : 1}
            onChange={(event) => setTab(event.name === 'project' ? 'project' : 'purchase')}
          >
            <Switch name="purchase" text="Purchases" />
            <Switch name="project" text="Projects" />
          </ContentSwitcher>
          <Search
            id="wg-link-search"
            size="md"
            labelText="Search"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch('')}
          />
          {query.isError && <p className="wg-empty">It could not be loaded.</p>}
          {query.isSuccess && options.length === 0 && <p className="wg-empty">Nothing found.</p>}
          <RadioButtonGroup
            key={tab}
            className="wg-linkpick"
            legendText={tab === 'purchase' ? 'Purchases' : 'Projects'}
            name="wg-link-target"
            orientation="vertical"
            valueSelected={chosen?.kind === tab ? chosen.id : ''}
            onChange={(value) => setChosen({ kind: tab, id: String(value) })}
          >
            {options.map((item) => (
              <RadioButton
                key={item.id}
                id={`wg-link-${item.id}`}
                labelText={`${item.title} (${item.sub})`}
                value={item.id}
              />
            ))}
          </RadioButtonGroup>
        </>
      )}
    </Modal>
  );
}

/** "From tickets and to-dos": what is linked to a purchase or project, each opening the item. */
export function LinkedTasks({
  groupId,
  tasks,
  section,
}: {
  groupId: string;
  tasks: readonly WorkingGroupLinkedTask[] | undefined;
  section?: boolean;
}) {
  if (!tasks || tasks.length === 0) return null;
  const list = (
    <ul className="wg-linked">
      {tasks.map((task) => (
        <li key={`${task.kind}:${task.id}`}>
          <CarbonLink as={Link} to={taskItemLink(groupId, task.kind, task.id)}>
            {task.title}
          </CarbonLink>{' '}
          <span className="wg-muted">{task.kind === 'ticket' ? 'Ticket' : 'To-do'}</span>
        </li>
      ))}
    </ul>
  );
  return section ? (
    <DetailPanelSection title="From tickets and to-dos">{list}</DetailPanelSection>
  ) : (
    <section className="wg-card" aria-label="From tickets and to-dos">
      <h3>From tickets and to-dos</h3>
      {list}
    </section>
  );
}
