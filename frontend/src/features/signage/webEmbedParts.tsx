import { Tag } from '@carbon/react';
import type { SignageWebEmbed } from '../../api/generated/models';

/** Turned off, never published, changed since the last publication, or live with its revision. */
export function EmbedStatusTag({ embed }: { embed: SignageWebEmbed }) {
  if (!embed.enabled)
    return (
      <Tag type="gray" size="md">
        Turned off
      </Tag>
    );
  if (embed.publishedRevision === null)
    return (
      <Tag type="warm-gray" size="md">
        Not published
      </Tag>
    );
  if (embed.pendingChanges.length > 0)
    return (
      <Tag type="warm-gray" size="md">
        Unpublished changes
      </Tag>
    );
  return (
    <Tag type="green" size="md">
      Live · revision {embed.publishedRevision}
    </Tag>
  );
}

/** Cameras and timelapses that are switched on; public information only otherwise. */
export function EmbedExtraTags({ embed }: { embed: SignageWebEmbed }) {
  if (!embed.cameraEnabled && !embed.timelapseEnabled)
    return <span className="sg-secondary">Public information only</span>;
  return (
    <div className="sg-inline">
      {embed.cameraEnabled && (
        <Tag type="purple" size="md">
          Cameras · {embed.cameraMachineIds.length}
        </Tag>
      )}
      {embed.timelapseEnabled && (
        <Tag type="purple" size="md">
          Timelapses
        </Tag>
      )}
    </div>
  );
}
