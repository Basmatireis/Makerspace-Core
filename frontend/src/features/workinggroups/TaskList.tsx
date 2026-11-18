import { useState } from 'react';
import { Button } from '@carbon/react';
import { Notification } from '@carbon/icons-react';
import type { WorkingGroup } from '../../api/generated/models';
import {
  BUCKETS,
  bucketOf,
  dateParts,
  dueHint,
  firstName,
  initials,
  kindLine,
  personName,
  stageOf,
  type Bucket,
  type Task,
} from './taskModel';

const DONE_SHOWN = 15;

interface Props {
  tasks: readonly Task[];
  today: string;
  groups: ReadonlyMap<string, WorkingGroup>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const byDue = (a: Task, b: Task) =>
  (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') || a.createdAt.localeCompare(b.createdAt);

/** Rows grouped under Inbox, Overdue, This week… Done, in the style of the Open Days list. */
export function TaskList({ tasks, today, groups, selectedKey, onSelect }: Props) {
  const [allDone, setAllDone] = useState(false);
  const sections = BUCKETS.map((bucket) => {
    const items = tasks.filter((task) => bucketOf(task, today) === bucket.key);
    items.sort(bucket.key === 'done' ? (a, b) => b.updatedAt.localeCompare(a.updatedAt) : byDue);
    return { ...bucket, items };
  }).filter((section) => section.items.length > 0);

  if (sections.length === 0) {
    return <p className="wg-empty">Nothing matches.</p>;
  }
  return (
    <div className="wg-list">
      <div className="wg-lrow wg-lrow--head" aria-hidden="true">
        <span>Due</span>
        <span>What</span>
        <span>Who</span>
        <span>From</span>
        <span>Stage</span>
        <span />
      </div>
      {sections.map((section) => {
        const shown = section.key === 'done' && !allDone ? section.items.slice(0, DONE_SHOWN) : section.items;
        return (
          <section key={section.key} aria-labelledby={`wg-lgroup-${section.key}`}>
            <h3 id={`wg-lgroup-${section.key}`} className={`wg-lweek wg-bk-${section.key}`}>
              {section.label} <small>{section.items.length}</small>
            </h3>
            <ul className="wg-llist">
              {shown.map((task) => (
                <li key={task.key}>
                  <TaskRow
                    task={task}
                    bucket={section.key}
                    today={today}
                    columns={groups.get(task.groupId)?.columns ?? []}
                    selected={task.key === selectedKey}
                    onSelect={onSelect}
                  />
                </li>
              ))}
            </ul>
            {section.key === 'done' && !allDone && section.items.length > DONE_SHOWN && (
              <div className="wg-lmore">
                <Button kind="ghost" size="sm" onClick={() => setAllDone(true)}>
                  Show all {section.items.length}
                </Button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  bucket,
  today,
  columns,
  selected,
  onSelect,
}: {
  task: Task;
  bucket: Bucket;
  today: string;
  columns: WorkingGroup['columns'];
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const hint = dueHint(task, today);
  const date = task.dueOn ? dateParts(task.dueOn) : null;
  return (
    <button
      type="button"
      className={`wg-lrow wg-bk-${bucket}${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      onClick={() => onSelect(task.key)}
    >
      <span className="wg-ldate">
        {date ? (
          <>
            <span className="wg-ldate__wd">{date.weekday}</span>
            <span className="wg-ldate__d">{date.day}</span>
            <span className="wg-ldate__m">{date.month}</span>
          </>
        ) : (
          <span className="wg-ldate__none">
            {task.state === 'new' ? <Notification size={20} aria-label="New in the inbox" /> : '–'}
          </span>
        )}
      </span>
      <span className="wg-lwhat">
        <span className="wg-lwhat__title">{task.title}</span>
        <small>{kindLine(task)}</small>
      </span>
      <span className="wg-lwho">
        {task.assignee ? (
          <>
            <Avatar name={task.assignee} />
            {personName(task.assignee)}
          </>
        ) : task.kind === 'todo' && task.state === 'done' ? (
          '–'
        ) : (
          <span className="wg-muted">Unassigned</span>
        )}
      </span>
      <span className="wg-lfrom">
        {task.kind === 'todo' ? (
          'The group'
        ) : (
          <>
            {task.author ? firstName(task.author) : personName(task.author)}
            {task.followerCount > 0 && <span className="wg-muted"> +{task.followerCount}</span>}
          </>
        )}
      </span>
      <Track task={task} columns={columns} />
      <span className={`wg-ldue${hint ? ` is-${hint.tone}` : ''}`}>{hint?.text}</span>
    </button>
  );
}

export function Avatar({ name }: { name: Parameters<typeof initials>[0] }) {
  return (
    <span className="wg-av" aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** A segmented bar across Inbox → columns → Done, with the current stage written below. */
export function Track({ task, columns }: { task: Task; columns: WorkingGroup['columns'] }) {
  const stage = stageOf(task, columns);
  return (
    <span
      className={`wg-track${task.state === 'new' ? ' is-inbox' : ''}${task.state === 'done' ? ' is-done' : ''}${task.state === 'declined' ? ' is-declined' : ''}`}
      role="img"
      aria-label={`Stage: ${stage.label}, step ${stage.index + 1} of ${stage.steps.length}`}
    >
      <span className="wg-track__bar" aria-hidden="true">
        {stage.steps.map((step, index) => (
          <i
            key={`${step}-${index}`}
            className={index < stage.index ? 'is-past' : index === stage.index ? 'is-now' : ''}
          />
        ))}
      </span>
      <span className="wg-track__l" aria-hidden="true">
        {stage.label}
      </span>
    </span>
  );
}
