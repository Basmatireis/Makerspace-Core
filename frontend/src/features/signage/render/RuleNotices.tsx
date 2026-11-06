import type { SignagePlayerRuleNotice } from '../../../api/generated/models';

/**
 * Notices a notification rule put on this display, shown above the scene with the announcement colours until they end.
 * Plain text only: a rule notice never carries media or job data.
 */
export function RuleNotices({ notices }: { notices: SignagePlayerRuleNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="sg-rule-notices" role="status" aria-live="polite">
      {notices.map((notice) => (
        <div key={notice.id} className={`sg-ann sg-ann--${notice.tone} sg-ann--banner`}>
          <strong className="sg-ann__title" style={{ fontSize: 'calc(var(--u) * 2.4)' }}>
            {notice.title}
          </strong>
          {notice.body.trim() !== '' && (
            <span className="sg-ann__body" style={{ fontSize: 'calc(var(--u) * 1.5)' }}>
              {notice.body}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
