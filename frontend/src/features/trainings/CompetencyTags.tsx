import './trainings.scss';
import { Tag } from '@carbon/react';
import type { OpenDayCompetency } from '../../api/generated/models';

/**
 * Planned competencies of an open day as tags. Only labels: who brings which competency stays internal to the
 * training records. `limit` keeps tight layouts to the first few and adds "+N".
 */
export function CompetencyTags({
  competencies,
  limit,
  size = 'md',
}: {
  competencies: readonly OpenDayCompetency[];
  limit?: number;
  size?: 'sm' | 'md';
}) {
  if (competencies.length === 0) return null;
  const shown = limit === undefined ? competencies : competencies.slice(0, limit);
  const hidden = competencies.length - shown.length;
  return (
    <div className="competency-tags" aria-label="Planned support">
      {shown.map((competency) => (
        <Tag key={competency.id} type="teal" size={size}>
          {competency.label}
        </Tag>
      ))}
      {hidden > 0 && (
        <span
          title={competencies
            .slice(shown.length)
            .map((item) => item.label)
            .join(', ')}
        >
          <Tag type="cool-gray" size={size}>
            +{hidden}
          </Tag>
        </span>
      )}
    </div>
  );
}
