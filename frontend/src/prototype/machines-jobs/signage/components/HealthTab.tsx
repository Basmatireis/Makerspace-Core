import { ProgressBar, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper, Tag } from '@carbon/react';
import { camerasSeed } from '../mockData';
import { cameraState, formatDateTime, relativeTime } from '../helpers';
import { useSignage } from '../SignageContext';
import type { Display } from '../types';

export function HealthTab({ display, now }: { display: Display; now: number }) {
  const { sim } = useSignage();
  const cachePercent = Math.round((display.cacheGb / display.cacheLimitGb) * 100);
  return (
    <div className="mj-stack sg-tab">
      <StructuredListWrapper isCondensed aria-label="Display health">
        <StructuredListBody>
          <StructuredListRow><StructuredListCell noWrap>Last heartbeat</StructuredListCell><StructuredListCell>{display.revoked ? 'Credential revoked' : display.status === 'offline' ? `${relativeTime(display.lastSeenAt, now)} (offline)` : relativeTime(display.lastSeenAt, now)}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap>Published revision</StructuredListCell><StructuredListCell>Revision {display.revision}{display.publishedAt ? ` · ${formatDateTime(display.publishedAt)}` : ''}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap>Player version</StructuredListCell><StructuredListCell>{display.playerVersion}</StructuredListCell></StructuredListRow>
          <StructuredListRow><StructuredListCell noWrap>Cache usage</StructuredListCell><StructuredListCell><ProgressBar label="Cache" hideLabel helperText={`${display.cacheGb} of ${display.cacheLimitGb} GB`} value={cachePercent} max={100} size="small" /></StructuredListCell></StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Cameras</StructuredListCell>
            <StructuredListCell>
              <ul className="sg-plain-list">
                {camerasSeed.map((camera) => {
                  const state = cameraState(sim[camera.machine], sim.coreReachable);
                  return <li key={camera.machine}><span>{camera.name}</span> <Tag type={state.type} size="sm">{state.label}</Tag> <span className="mj-secondary">{camera.format}</span></li>;
                })}
              </ul>
            </StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Recent errors</StructuredListCell>
            <StructuredListCell>
              {display.errors.length === 0 ? <span className="mj-secondary">No errors in the last 7 days</span> : (
                <ul className="sg-plain-list">{display.errors.map((error) => <li key={error.at + error.message}><span>{error.message}</span> <span className="mj-secondary">· {relativeTime(error.at, now)}</span></li>)}</ul>
              )}
            </StructuredListCell>
          </StructuredListRow>
        </StructuredListBody>
      </StructuredListWrapper>
    </div>
  );
}
