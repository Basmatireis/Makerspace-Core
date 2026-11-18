import { queryOptions } from '@tanstack/react-query';
import {
  getSignageAsset,
  getSignageCalendar,
  getSignageDisplay,
  getSignageDisplayNotices,
  getSignageDisplayGroup,
  getSignageDisplayGroupPreview,
  getSignageDisplayPreview,
  getSignageGroupNotices,
  getSignageScene,
  getSignageWebEmbed,
  listSignageAnnouncementTemplates,
  listSignageAnnouncements,
  listSignageAssets,
  listSignageDisplayGroups,
  listSignageDisplays,
  listSignageGroupRules,
  listSignageMachines,
  listSignageNotificationRules,
  listSignageRules,
  listSignageScenes,
  listSignageWebEmbeds,
} from '../../api/generated/signage/signage';

export const signageKeys = {
  all: ['signage'] as const,
  scenes: () => [...signageKeys.all, 'scenes'] as const,
  scene: (id: string) => [...signageKeys.all, 'scene', id] as const,
  templates: () => [...signageKeys.all, 'templates'] as const,
  announcements: () => [...signageKeys.all, 'announcements'] as const,
  assets: () => [...signageKeys.all, 'assets'] as const,
  asset: (id: string) => [...signageKeys.all, 'asset', id] as const,
  machines: () => [...signageKeys.all, 'machines'] as const,
  calendar: () => [...signageKeys.all, 'calendar'] as const,
  displays: () => [...signageKeys.all, 'displays'] as const,
  display: (id: string) => [...signageKeys.all, 'display', id] as const,
  rules: (id: string) => [...signageKeys.all, 'rules', id] as const,
  preview: (id: string) => [...signageKeys.all, 'preview', id] as const,
  groups: () => [...signageKeys.all, 'groups'] as const,
  group: (id: string) => [...signageKeys.all, 'group', id] as const,
  groupRules: (id: string) => [...signageKeys.all, 'group-rules', id] as const,
  groupPreview: (id: string) => [...signageKeys.all, 'group-preview', id] as const,
  noticeRules: () => [...signageKeys.all, 'notice-rules'] as const,
  notices: (owner: { kind: 'display' | 'group'; id: string }) =>
    [...signageKeys.all, `${owner.kind}-notices`, owner.id] as const,
  embeds: () => [...signageKeys.all, 'embeds'] as const,
  embed: (id: string) => [...signageKeys.all, 'embed', id] as const,
};

export const scenesQuery = () =>
  queryOptions({ queryKey: signageKeys.scenes(), queryFn: ({ signal }) => listSignageScenes({ signal }) });
export const sceneQuery = (id: string) =>
  queryOptions({ queryKey: signageKeys.scene(id), queryFn: ({ signal }) => getSignageScene(id, { signal }) });
export const templatesQuery = () =>
  queryOptions({
    queryKey: signageKeys.templates(),
    queryFn: ({ signal }) => listSignageAnnouncementTemplates({ signal }),
  });
export const announcementsQuery = () =>
  queryOptions({
    queryKey: signageKeys.announcements(),
    queryFn: ({ signal }) => listSignageAnnouncements({ signal }),
  });
export const assetsQuery = () =>
  queryOptions({ queryKey: signageKeys.assets(), queryFn: ({ signal }) => listSignageAssets(undefined, { signal }) });
export const assetQuery = (id: string) =>
  queryOptions({ queryKey: signageKeys.asset(id), queryFn: ({ signal }) => getSignageAsset(id, { signal }) });

/** Machines for widget pickers: id, name and kind only. Any signage permission is enough (no `machines.read` needed). */
export const machinesQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: signageKeys.machines(),
    queryFn: ({ signal }) => listSignageMachines({ signal }),
    enabled,
  });

/** The upcoming public open days and events players show (the same lists as the live endpoint). Previews use them instead of samples. */
export const calendarQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: signageKeys.calendar(),
    queryFn: ({ signal }) => getSignageCalendar({ signal }),
    enabled,
    staleTime: 60_000,
  });

// Heartbeats arrive every 30 s and live data every 10 s on the player, so the admin views poll at a similar pace.
export const displaysQuery = () =>
  queryOptions({
    queryKey: signageKeys.displays(),
    queryFn: ({ signal }) => listSignageDisplays({ signal }),
    refetchInterval: 30_000,
  });
export const displayQuery = (id: string) =>
  queryOptions({
    queryKey: signageKeys.display(id),
    queryFn: ({ signal }) => getSignageDisplay(id, { signal }),
    refetchInterval: 30_000,
  });
/** Ordered rules and the display version every rule write must quote. */
export const rulesQuery = (displayId: string, enabled = true) =>
  queryOptions({
    queryKey: signageKeys.rules(displayId),
    queryFn: ({ signal }) => listSignageRules(displayId, { signal }),
    enabled,
  });
/** The display's latest publication plus the live data its player would poll. */
export const previewQuery = (displayId: string, enabled = true) =>
  queryOptions({
    queryKey: signageKeys.preview(displayId),
    queryFn: ({ signal }) => getSignageDisplayPreview(displayId, { signal }),
    refetchInterval: 10_000,
    enabled,
  });

export const groupsQuery = () =>
  queryOptions({
    queryKey: signageKeys.groups(),
    queryFn: ({ signal }) => listSignageDisplayGroups({ signal }),
    refetchInterval: 30_000,
  });
export const groupQuery = (id: string) =>
  queryOptions({
    queryKey: signageKeys.group(id),
    queryFn: ({ signal }) => getSignageDisplayGroup(id, { signal }),
    refetchInterval: 30_000,
  });
/** The rules and the version every rule write quotes, of a display (its own, or its group's while it is a member) or of a group. */
export const ownerRulesQuery = (owner: { kind: 'display' | 'group' | 'embed'; id: string }, enabled = true) =>
  queryOptions({
    queryKey: (owner.kind === 'group'
      ? signageKeys.groupRules(owner.id)
      : signageKeys.rules(owner.id)) as readonly unknown[],
    queryFn: ({ signal }) =>
      owner.kind === 'group' ? listSignageGroupRules(owner.id, { signal }) : listSignageRules(owner.id, { signal }),
    enabled,
  });
/** The latest publication of the group's first member that has one, with that member's live data. */
export const groupPreviewQuery = (groupId: string, enabled = true) =>
  queryOptions({
    queryKey: signageKeys.groupPreview(groupId),
    queryFn: ({ signal }) => getSignageDisplayGroupPreview(groupId, { signal }),
    refetchInterval: 10_000,
    enabled,
  });

/** Web embeds: displays without a device that show a screen inside other websites. */
export const embedsQuery = () =>
  queryOptions({
    queryKey: signageKeys.embeds(),
    queryFn: ({ signal }) => listSignageWebEmbeds({ signal }),
    refetchInterval: 30_000,
  });
export const embedQuery = (id: string) =>
  queryOptions({
    queryKey: signageKeys.embed(id),
    queryFn: ({ signal }) => getSignageWebEmbed(id, { signal }),
    refetchInterval: 30_000,
  });

/** Notification rules a display or group can choose to show (any signage permission lists them). */
export const noticeRulesQuery = () =>
  queryOptions({
    queryKey: signageKeys.noticeRules(),
    queryFn: ({ signal }) => listSignageNotificationRules({ signal }),
  });
/** Which notification rules a display or group shows: all of them, or the chosen ones. */
export const noticesQuery = (owner: { kind: 'display' | 'group'; id: string }, enabled = true) =>
  queryOptions({
    queryKey: signageKeys.notices(owner),
    queryFn: ({ signal }) =>
      owner.kind === 'group'
        ? getSignageGroupNotices(owner.id, { signal })
        : getSignageDisplayNotices(owner.id, { signal }),
    enabled,
  });
