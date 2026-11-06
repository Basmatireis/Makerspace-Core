import { InlineNotification } from '@carbon/react';
import type { KioskNotice } from '../../../api/generated/models';

/** Notices a notification rule put on this tablet, drawn with Carbon's inline notification. */
export function KioskNotices({ notices }: { notices: KioskNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="tablet-notices">
      {notices.map((notice) => (
        <InlineNotification
          key={notice.id}
          kind={notice.level}
          title={notice.title}
          subtitle={notice.body}
          hideCloseButton
          lowContrast
          role="status"
        />
      ))}
    </div>
  );
}
