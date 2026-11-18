import { useRef, useState } from 'react';
import { Button, Checkbox, InlineNotification, Select, SelectItem, Tag, TextArea } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import type { WorkingGroup, WorkingGroupComment } from '../../api/generated/models';
import {
  addWorkingGroupTicketComment,
  addWorkingGroupTodoComment,
  closeWorkingGroupTicket,
  deleteWorkingGroupTodo,
  followWorkingGroupTicket,
  markWorkingGroupTodoDone,
  reopenWorkingGroupTicket,
  reopenWorkingGroupTodo,
  unfollowWorkingGroupTicket,
  updateWorkingGroupTicket,
  updateWorkingGroupTodo,
} from '../../api/generated/working-groups/working-groups';
import { DateInput } from '../../app/DateInput';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { Avatar } from './TaskList';
import { workingGroupTicketOptions, workingGroupTodoOptions } from './queries';
import { firstName, formatDate, kindLine, personName, repeatLabel, type Task } from './taskModel';
import { saveErrorText, useWgMutation } from './useWgMutation';

interface Props {
  task: Task;
  group: WorkingGroup | undefined;
  me: string;
  onPlan: (task: Task) => void;
  onAnswer: (task: Task) => void;
  onGone: () => void;
}

const STATUS_TAG = {
  new: { text: 'In the inbox', type: 'blue' },
  open: { text: 'Planned', type: 'teal' },
  done: { text: 'Done', type: 'green' },
  declined: { text: 'Declined', type: 'gray' },
} as const;

/** The detail panel of a ticket or to-do: head, one action row, facts, plain sections. Keyed by the task. */
export function TaskPanel({ task, group, me, onPlan, onAnswer, onGone }: Props) {
  const ticket = task.ticket;
  const isTicket = task.kind === 'ticket';
  const ticketDetail = useQuery({ ...workingGroupTicketOptions(task.id), enabled: isTicket });
  const todoDetail = useQuery({ ...workingGroupTodoOptions(task.id), enabled: !isTicket });
  const comments = (isTicket ? ticketDetail.data?.comments : todoDetail.data?.comments) ?? [];
  const followers = ticketDetail.data?.followers ?? [];

  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);

  const patch = useWgMutation((body: { assigneePersonId?: string | null; dueOn?: string | null; columnId?: string }) =>
    isTicket
      ? updateWorkingGroupTicket(task.id, { expectedVersion: task.version, ...body })
      : updateWorkingGroupTodo(task.id, {
          expectedVersion: task.version,
          ...body,
          dueOn: body.dueOn ?? undefined,
        }),
  );
  const reopen = useWgMutation(() => (isTicket ? reopenWorkingGroupTicket(task.id) : reopenWorkingGroupTodo(task.id)));
  const finish = useWgMutation(() =>
    isTicket ? closeWorkingGroupTicket(task.id, { outcome: 'done' }) : markWorkingGroupTodoDone(task.id),
  );
  const follow = useWgMutation((following: boolean) =>
    following ? unfollowWorkingGroupTicket(task.id) : followWorkingGroupTicket(task.id),
  );
  const remove = useWgMutation(() => deleteWorkingGroupTodo(task.id));

  const inside = task.inside;
  const members = group?.members ?? [];
  const columns = group?.columns ?? [];
  const status = STATUS_TAG[task.state];
  const open = task.state === 'new' || task.state === 'open';
  const error = saveErrorText(patch.error ?? reopen.error ?? finish.error ?? follow.error ?? remove.error);
  const canFollow = isTicket && !inside && open && task.author?.personId !== me;

  return (
    <DetailPanel>
      <DetailPanelHead
        title={task.title}
        meta={`${isTicket ? 'Ticket' : 'To-do'} · ${task.groupName}`}
        secondary={kindLine(task).split(' · ').slice(1).join(' · ')}
        helper={
          <Tag size="sm" type={status.type}>
            {status.text}
          </Tag>
        }
      />

      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}

      <div className="wg-panel-actions">
        {isTicket && inside && task.state === 'new' && (
          <>
            <Button kind="tertiary" size="md" onClick={() => onAnswer(task)}>
              Answer and close
            </Button>
            <Button kind="primary" size="md" onClick={() => onPlan(task)}>
              Plan it
            </Button>
          </>
        )}
        {isTicket && inside && task.state === 'open' && (
          <>
            <Button kind="ghost" size="md" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
              Back to the inbox
            </Button>
            <Button kind="primary" size="md" disabled={finish.isPending} onClick={() => finish.mutate()}>
              Mark as done
            </Button>
          </>
        )}
        {isTicket && inside && !open && (
          <Button kind="tertiary" size="md" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
            Open it again
          </Button>
        )}
        {canFollow && (
          <Button
            kind={task.isFollowing ? 'tertiary' : 'primary'}
            size="md"
            aria-pressed={task.isFollowing}
            disabled={follow.isPending}
            onClick={() => follow.mutate(task.isFollowing)}
          >
            {task.isFollowing ? 'You are following this' : 'I have this too'}
          </Button>
        )}
        {!isTicket && (
          <>
            <Button
              ref={deleteButton}
              kind="danger--ghost"
              size="md"
              onClick={() => {
                remove.reset();
                setConfirmDelete(true);
              }}
            >
              Delete
            </Button>
            {open ? (
              <Button kind="primary" size="md" disabled={finish.isPending} onClick={() => finish.mutate()}>
                Mark as done
              </Button>
            ) : (
              <Button kind="tertiary" size="md" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
                Open it again
              </Button>
            )}
          </>
        )}
      </div>

      {ticket?.body && <p className="wg-panel-body">{ticket.body}</p>}
      {ticket?.blocksUse && <p className="wg-panel-body wg-panel-blocks">It cannot be used right now.</p>}

      <FactsGrid columns={2}>
        {isTicket && (
          <>
            <Fact label="Written by" helper={formatDate(task.createdAt)}>
              {personName(task.author)}
            </Fact>
            <Fact label="Also affected">
              {task.followerCount === 0
                ? 'Nobody else'
                : followers.length > 0
                  ? followers.map((person) => firstName(person)).join(', ')
                  : `${task.followerCount}`}
            </Fact>
          </>
        )}
        {(task.state === 'open' || !isTicket) && (
          <>
            <Fact label="Who">
              {inside ? (
                <Select
                  id={`wg-who-${task.key}`}
                  labelText="Who"
                  hideLabel
                  size="sm"
                  value={task.assignee?.personId ?? ''}
                  disabled={patch.isPending}
                  onChange={(event) => patch.mutate({ assigneePersonId: event.target.value || null })}
                >
                  <SelectItem value="" text="Unassigned" />
                  {task.assignee && !members.some((member) => member.personId === task.assignee?.personId) && (
                    <SelectItem value={task.assignee.personId} text={task.assignee.displayName} />
                  )}
                  {members.map((member) => (
                    <SelectItem key={member.personId} value={member.personId} text={member.displayName} />
                  ))}
                </Select>
              ) : task.assignee ? (
                personName(task.assignee)
              ) : (
                'Unassigned'
              )}
            </Fact>
            <Fact label="Due">
              {inside ? (
                <DateInput
                  id={`wg-due-${task.key}`}
                  labelText="Due"
                  value={task.dueOn ?? ''}
                  onChange={(value) => {
                    if (value === (task.dueOn ?? '')) return;
                    if (value === '' && !isTicket) return;
                    patch.mutate({ dueOn: value === '' ? null : value });
                  }}
                />
              ) : task.dueOn ? (
                formatDate(task.dueOn)
              ) : (
                'No due date'
              )}
            </Fact>
            <Fact label="Column">
              {inside ? (
                <Select
                  id={`wg-col-${task.key}`}
                  labelText="Column"
                  hideLabel
                  size="sm"
                  value={task.columnId ?? ''}
                  disabled={patch.isPending || columns.length === 0}
                  onChange={(event) => event.target.value && patch.mutate({ columnId: event.target.value })}
                >
                  {columns.map((column) => (
                    <SelectItem key={column.id} value={column.id} text={column.name} />
                  ))}
                </Select>
              ) : (
                (columns.find((column) => column.id === task.columnId)?.name ?? '–')
              )}
            </Fact>
          </>
        )}
        {!isTicket && <Fact label="Repeats">{repeatLabel(task.repeatEveryDays)}</Fact>}
        {isTicket && !open && ticket?.closedAt && <Fact label="Closed">{formatDate(ticket.closedAt)}</Fact>}
      </FactsGrid>

      <Comments task={task} comments={comments} inside={inside} />

      {!isTicket && (
        <DestructiveActionDialog
          open={confirmDelete}
          title="Delete to-do"
          fate="permanent"
          confirmLabel="Delete to-do"
          pending={remove.isPending}
          error={remove.isError ? 'The to-do could not be deleted.' : undefined}
          launcherButtonRef={deleteButton}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                setConfirmDelete(false);
                onGone();
              },
            })
          }
        >
          <p>{task.title}</p>
        </DestructiveActionDialog>
      )}
    </DetailPanel>
  );
}

function Comments({
  task,
  comments,
  inside,
}: {
  task: Task;
  comments: readonly WorkingGroupComment[];
  inside: boolean;
}) {
  const isTicket = task.kind === 'ticket';
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const post = useWgMutation(() =>
    isTicket
      ? addWorkingGroupTicketComment(task.id, { text: text.trim(), internal })
      : addWorkingGroupTodoComment(task.id, { text: text.trim() }),
  );
  const count = Math.max(task.commentCount, comments.length);
  return (
    <DetailPanelSection title={`Comments (${count})`}>
      {comments.length > 0 && (
        <ul className="wg-comments">
          {comments.map((comment) => (
            <li key={comment.id} className="wg-comment">
              <Avatar name={comment.author} />
              <div>
                <p className="wg-comment__meta">
                  <strong>{personName(comment.author)}</strong> · {formatDate(comment.createdAt)}
                  {comment.internal && isTicket && (
                    <>
                      {' '}
                      <Tag size="sm" type="gray">
                        Group only
                      </Tag>
                    </>
                  )}
                </p>
                <p className="wg-comment__text">{comment.text}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <TextArea
        id={`wg-comment-${task.key}`}
        labelText="Comment"
        hideLabel
        placeholder="Write a comment"
        rows={2}
        maxCount={2000}
        enableCounter={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {isTicket && inside && (
        <Checkbox
          id={`wg-internal-${task.key}`}
          labelText="Only the group and management see it"
          checked={internal}
          onChange={(_, { checked }) => setInternal(checked)}
        />
      )}
      {post.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not posted"
          subtitle="Check your connection and try again."
        />
      )}
      <div className="wg-panel-actions">
        <Button
          kind="tertiary"
          size="md"
          disabled={text.trim() === '' || post.isPending}
          onClick={() =>
            post.mutate(undefined, {
              onSuccess: () => {
                setText('');
                setInternal(false);
              },
            })
          }
        >
          Post
        </Button>
      </div>
    </DetailPanelSection>
  );
}
