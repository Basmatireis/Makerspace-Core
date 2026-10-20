import { Calendar, Copy, Launch } from '@carbon/icons-react';
import { Button, Tag, Tile } from '@carbon/react';
import type { Event } from '../../api/generated/models';
import { formatInstant } from './format';

type EventOverviewPanelProps = {
  event: Event;
  onOpenTab: (tab: 'planning' | 'staffing') => void;
  onOpenPublic: () => void;
};

export function EventOverviewPanel({ event, onOpenTab, onOpenPublic }: EventOverviewPanelProps) {
  const taskPercent = event.taskTotal > 0 ? Math.round((event.taskCompleted / event.taskTotal) * 100) : 0;
  const staffingPercent = event.requiredCount > 0 ? Math.round((event.filledCount / event.requiredCount) * 100) : 0;
  const publicUrl = `${window.location.origin}/events/public/${event.publicId}`;

  return (
    <div className="event-overview-grid">
      <Tile className="event-overview-card">
        <h2>About</h2>
        <p>{event.internalDescription ?? 'No internal description has been added.'}</p>
        <dl>
          <div>
            <dt>Location</dt>
            <dd>{event.location ?? 'Not set'}</dd>
          </div>
          <div>
            <dt>Public description</dt>
            <dd>{event.publicDescription ?? 'Not set'}</dd>
          </div>
        </dl>
      </Tile>
      <Tile className="event-overview-card">
        <h2>Progress</h2>
        <div className="event-progress-block">
          <div>
            <strong>Tasks</strong>
            <span>
              {event.taskCompleted} / {event.taskTotal}
            </span>
          </div>
          <progress aria-label="Task completion" max={100} value={taskPercent} />
          <Button kind="ghost" size="sm" onClick={() => onOpenTab('planning')}>
            Open planning
          </Button>
        </div>
        <div className="event-progress-block">
          <div>
            <strong>Staffing</strong>
            <span>
              {event.filledCount} / {event.requiredCount}
            </span>
          </div>
          <progress aria-label="Staffing progress" max={100} value={staffingPercent} />
          <Button kind="ghost" size="sm" onClick={() => onOpenTab('staffing')}>
            Open staffing
          </Button>
        </div>
      </Tile>
      <Tile className="event-overview-card">
        <h2>Next up</h2>
        <div className="event-next-item">
          <Calendar size={20} />
          <div>
            <strong>Next deadline</strong>
            <p>{formatInstant(event.nextDeadline)}</p>
          </div>
        </div>
        <div className="event-next-item">
          <Calendar size={20} />
          <div>
            <strong>Next session or shift</strong>
            <p>{formatInstant(event.nextScheduleAt)}</p>
          </div>
        </div>
      </Tile>
      <Tile className="event-overview-card">
        <h2>Public information</h2>
        <Tag type={event.publicSignupEnabled ? 'green' : 'gray'}>
          {event.publicSignupEnabled ? 'Public signup enabled' : 'Public signup disabled'}
        </Tag>
        <div className="event-public-link">
          <code>{publicUrl}</code>
          <Button
            hasIconOnly
            kind="ghost"
            size="sm"
            renderIcon={Copy}
            iconDescription="Copy public event link"
            onClick={() => void navigator.clipboard.writeText(publicUrl)}
          />
        </div>
        <Button kind="tertiary" size="sm" renderIcon={Launch} onClick={onOpenPublic}>
          Open public view
        </Button>
        <p>Public visitors see only published content, public sessions, shifts, staffing counts, and public files.</p>
      </Tile>
    </div>
  );
}
