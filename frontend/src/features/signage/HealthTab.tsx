import { ProgressBar, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import type { SignageDisplay } from '../../api/generated/models';
import { formatBytes, formatDateTime, relativeTime } from './helpers';

export function HealthTab({ display, now }: { display: SignageDisplay; now: number }) {
  const { cacheUsedBytes, cacheQuotaBytes } = display;
  const percent = cacheUsedBytes !== null && cacheQuotaBytes ? Math.min(100, Math.round((cacheUsedBytes / cacheQuotaBytes) * 100)) : null;
  const heartbeat = display.status === 'revoked' ? 'Credential revoked' : display.lastHeartbeatAt === null ? 'No heartbeat yet' : `${relativeTime(display.lastHeartbeatAt, now)}${display.status === 'offline' ? ' (offline)' : ''}`;
  return (
    <div className="sg-stack sg-tab">
      <StructuredListWrapper isCondensed aria-label="Display health">
        <StructuredListBody>
          <StructuredListRow><StructuredListCell noWrap>Last heartbeat</StructuredListCell><StructuredListCell>{heartbeat}</StructuredListCell></StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Published revision</StructuredListCell>
            <StructuredListCell>{display.publishedRevision === null ? 'Never published' : `Revision ${display.publishedRevision}${display.publishedAt ? ` · ${formatDateTime(display.publishedAt)}` : ''}`}</StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Running revision</StructuredListCell>
            <StructuredListCell>
              {display.reportedRevision === null ? '—' : `Revision ${display.reportedRevision}`}
              {display.reportedRevision !== null && display.publishedRevision !== null && display.reportedRevision !== display.publishedRevision && <span className="sg-secondary"> · the display has not picked up revision {display.publishedRevision} yet</span>}
            </StructuredListCell>
          </StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap>Player version</StructuredListCell><StructuredListCell>{display.playerVersion ?? '—'}</StructuredListCell></StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Cache usage</StructuredListCell>
            <StructuredListCell>
              {cacheUsedBytes === null ? '—' : percent === null ? formatBytes(cacheUsedBytes) : (
                <ProgressBar label="Cache" hideLabel helperText={`${formatBytes(cacheUsedBytes)} of ${formatBytes(cacheQuotaBytes ?? 0)}`} value={percent} max={100} size="small" />
              )}
            </StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Recent errors</StructuredListCell>
            <StructuredListCell>
              {display.errors.length === 0 ? <span className="sg-secondary">None reported</span> : <ul className="sg-plain-list">{display.errors.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul>}
            </StructuredListCell>
          </StructuredListRow>
        </StructuredListBody>
      </StructuredListWrapper>
    </div>
  );
}
