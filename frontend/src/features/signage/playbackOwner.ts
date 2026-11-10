import { useQueryClient } from '@tanstack/react-query';
import type {
  SignageAspectRatio,
  SignageDisplay,
  SignageDisplayGroup,
  SignageSceneListItems,
  SignageWebEmbed,
} from '../../api/generated/models';
import {
  createSignageGroupRule,
  createSignageRule,
  deleteSignageGroupRule,
  deleteSignageRule,
  reorderSignageGroupRules,
  reorderSignageRules,
  setSignageGroupRuleEnabled,
  setSignageRuleEnabled,
  updateSignageGroupRule,
  updateSignageRule,
} from '../../api/generated/signage/signage';
import { signageKeys } from './queries';

/**
 * Whatever owns an ordered rule list and a default scene list: a display, a group of displays or a web embed.
 * `canManage` is the viewer's `signage.manage`; the playback components add the state-dependent limits themselves
 * (revoked display, display in a group).
 */
export type PlaybackOwner =
  | { kind: 'display'; display: SignageDisplay; canManage: boolean }
  | { kind: 'group'; group: SignageDisplayGroup; canManage: boolean }
  | { kind: 'embed'; embed: SignageWebEmbed; canManage: boolean };

export type OwnerKind = PlaybackOwner['kind'];

export type OwnerInfo = {
  kind: OwnerKind;
  id: string;
  name: string;
  version: number;
  aspectRatio: SignageAspectRatio;
  defaultScenes: SignageSceneListItems;
};

export function ownerInfo(owner: PlaybackOwner): OwnerInfo {
  const entity = owner.kind === 'display' ? owner.display : owner.kind === 'embed' ? owner.embed : owner.group;
  return {
    kind: owner.kind,
    id: entity.id,
    name: entity.name,
    version: entity.version,
    aspectRatio: entity.aspectRatio,
    defaultScenes: entity.defaultScenes,
  };
}

/** The cache key of the owner's rule list. */
export const ownerRulesKey = (owner: { kind: OwnerKind; id: string }) =>
  owner.kind === 'group' ? signageKeys.groupRules(owner.id) : signageKeys.rules(owner.id);

type RuleRequest = Parameters<typeof createSignageRule>[1];
type EnabledRequest = Parameters<typeof setSignageRuleEnabled>[2];
type DeleteRequest = Parameters<typeof deleteSignageRule>[2];
type ReorderRequest = Parameters<typeof reorderSignageRules>[1];

/** The rule endpoints of an owner; the group ones mirror the display ones, and a web embed uses the display ones with its own id. */
export function ruleApi(owner: { kind: OwnerKind; id: string }) {
  const { id } = owner;
  return owner.kind === 'group'
    ? {
        create: (request: RuleRequest) => createSignageGroupRule(id, request),
        update: (ruleId: string, request: RuleRequest) => updateSignageGroupRule(id, ruleId, request),
        setEnabled: (ruleId: string, request: EnabledRequest) => setSignageGroupRuleEnabled(id, ruleId, request),
        remove: (ruleId: string, request: DeleteRequest) => deleteSignageGroupRule(id, ruleId, request),
        reorder: (request: ReorderRequest) => reorderSignageGroupRules(id, request),
      }
    : {
        create: (request: RuleRequest) => createSignageRule(id, request),
        update: (ruleId: string, request: RuleRequest) => updateSignageRule(id, ruleId, request),
        setEnabled: (ruleId: string, request: EnabledRequest) => setSignageRuleEnabled(id, ruleId, request),
        remove: (ruleId: string, request: DeleteRequest) => deleteSignageRule(id, ruleId, request),
        reorder: (request: ReorderRequest) => reorderSignageRules(id, request),
      };
}

/** The cached queries that follow the owner's drafts: the owner (version, pending changes), the lists and the preview. */
export function ownerRefreshKeys(owner: { kind: OwnerKind; id: string }): (readonly unknown[])[] {
  if (owner.kind === 'group')
    return [
      signageKeys.group(owner.id),
      signageKeys.groups(),
      signageKeys.groupPreview(owner.id),
      // The members' pending changes follow the group's drafts.
      signageKeys.displays(),
    ];
  if (owner.kind === 'embed') return [signageKeys.embed(owner.id), signageKeys.embeds(), signageKeys.preview(owner.id)];
  return [signageKeys.display(owner.id), signageKeys.displays(), signageKeys.preview(owner.id)];
}

/** Invalidates what depends on the owner's drafts. */
export function useRefreshOwner(owner: { kind: OwnerKind; id: string }) {
  const queryClient = useQueryClient();
  const keys = ownerRefreshKeys(owner);
  return (...extra: (readonly unknown[])[]) =>
    Promise.all([...keys, ...extra].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
