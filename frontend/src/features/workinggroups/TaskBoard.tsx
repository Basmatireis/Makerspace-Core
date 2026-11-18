import { useRef, useState } from 'react';
import { Button, Tag } from '@carbon/react';
import type { WorkingGroup } from '../../api/generated/models';
import { Avatar } from './TaskList';
import { dueHint, firstName, isOpen, kindLine, type Task } from './taskModel';

/** Where a card is dropped: the inbox, the done column or one of the group's columns. */
export type BoardTarget = 'inbox' | 'done' | string;

interface Props {
  group: WorkingGroup;
  tasks: readonly Task[];
  today: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onMove: (task: Task, target: BoardTarget) => void;
}

const DONE_SHOWN = 15;
const HINT_ID = 'wg-board-hint';

export function TaskBoard({ group, tasks, today, selectedKey, onSelect, onMove }: Props) {
  const dragging = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [allDone, setAllDone] = useState(false);

  const lanes: { id: BoardTarget; label: string; items: Task[] }[] = [
    { id: 'inbox', label: 'Inbox', items: tasks.filter((task) => task.state === 'new') },
    ...group.columns.map((column) => ({
      id: column.id,
      label: column.name,
      items: tasks.filter((task) => task.state === 'open' && task.columnId === column.id),
    })),
    { id: 'done', label: 'Done', items: tasks.filter((task) => !isOpen(task)) },
  ];

  const drop = (target: BoardTarget) => {
    const key = dragging.current;
    dragging.current = null;
    setOver(null);
    const task = tasks.find((candidate) => candidate.key === key);
    if (task) onMove(task, target);
  };

  return (
    <div className="wg-board" role="group" aria-label="Board" aria-describedby={HINT_ID}>
      <p id={HINT_ID} className="wg-visually-hidden">
        Drag a card to another column, or change its column in the detail panel.
      </p>
      {lanes.map((lane) => {
        const shown = lane.id === 'done' && !allDone ? lane.items.slice(0, DONE_SHOWN) : lane.items;
        return (
          <section
            key={lane.id}
            className={`wg-col${over === lane.id ? ' is-over' : ''}${lane.id === 'inbox' ? ' wg-col--inbox' : ''}`}
            aria-label={`${lane.label}, ${lane.items.length}`}
            onDragOver={(event) => {
              if (dragging.current === null) return;
              event.preventDefault();
              setOver(lane.id);
            }}
            onDragLeave={() => setOver((current) => (current === lane.id ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              drop(lane.id);
            }}
          >
            <h3 className="wg-col__head">
              {lane.label} <small>{lane.items.length}</small>
            </h3>
            <ul className="wg-col__cards">
              {shown.map((task) => {
                const hint = dueHint(task, today);
                return (
                  <li key={task.key}>
                    <div
                      className={`wg-card${task.key === selectedKey ? ' is-sel' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={task.key === selectedKey}
                      draggable={task.inside}
                      onClick={() => onSelect(task.key)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onSelect(task.key);
                        }
                      }}
                      onDragStart={(event) => {
                        dragging.current = task.key;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', task.key);
                      }}
                      onDragEnd={() => {
                        dragging.current = null;
                        setOver(null);
                      }}
                    >
                      <span className="wg-card__top">
                        <Tag size="sm" type={task.kind === 'ticket' ? 'blue' : 'gray'}>
                          {task.kind === 'ticket' ? 'Ticket' : 'To-do'}
                        </Tag>
                        <small>{kindLine(task).split(' · ').slice(1).join(' · ')}</small>
                      </span>
                      <span className="wg-card__title">{task.title}</span>
                      <span className="wg-card__foot">
                        <span className="wg-card__who">
                          {task.assignee ? (
                            <>
                              <Avatar name={task.assignee} />
                              {firstName(task.assignee)}
                            </>
                          ) : (
                            <span className="wg-muted">Unassigned</span>
                          )}
                        </span>
                        {hint && <span className={`wg-ldue is-${hint.tone}`}>{hint.text}</span>}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
            {lane.id === 'done' && !allDone && lane.items.length > DONE_SHOWN && (
              <Button kind="ghost" size="sm" onClick={() => setAllDone(true)}>
                Show all {lane.items.length}
              </Button>
            )}
          </section>
        );
      })}
    </div>
  );
}
