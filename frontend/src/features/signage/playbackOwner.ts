import { useQueryClient } from '@tanstack/react-query';
import type {
  SignageAspectRatio,
  SignageDisplay,
  SignageDisplayGroup,
  SignageSceneListItems,
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
 * Whatever owns an ordered rule list and a default scene list: a display, or a group of displays.
 * `canManage` is the viewer's `signage.manage`; the playback components add the state-dependent limits themselves
 * (revoked display, display in a group).
 */
export type PlaybackOwner =
  | { kind: 'display'; display: SignageDisplay; canManage: boolean }
  | { kind: 'group'; group: SignageDisplayGroup; canManage: boolean };

export type OwnerInfo = {
  kind: 'display' | 'group';
  id: string;
  name: string;
  version: number;
  aspectRatio: SignageAspectRatio;
  defaultScenes: SignageSceneListItems;
};

export function ownerInfo(owner: PlaybackOwner): OwnerInfo {
  const entity = owner.kind === 'display' ? owner.display : owner.group;
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
export const ownerRulesKey = (owner: { kind: 'display' | 'group'; id: string }) =>
  owner.kind === 'group' ? signageKeys.groupRules(owner.id) : signageKeys.rules(owner.id);

type RuleRequest = Parameters<typeof createSignageRule>[1];
type EnabledRequest = Parameters<typeof setSignageRuleEnabled>[2];
type DeleteRequest = Parameters<typeof deleteSignageRule>[2];
type ReorderRequest = Parameters<typeof reorderSignageRules>[1];

/** The rule endpoints of an owner; the group ones mirror the display ones. */
export function ruleApi(owner: { kind: 'display' | 'group'; id: string }) {
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

/** Invalidates what depends on the owner's drafts: the owner (version, pending changes), the lists and the preview. */
export function useRefreshOwner(owner: { kind: 'display' | 'group'; id: string }) {
  const queryClient = useQueryClient();
  const keys =
    owner.kind === 'group'
      ? [
          signageKeys.group(owner.id),
          signageKeys.groups(),
          signageKeys.groupPreview(owner.id),
          // The members' pending changes follow the group's drafts.
          signageKeys.displays(),
        ]
      : [signageKeys.display(owner.id), signageKeys.displays(), signageKeys.preview(owner.id)];
  return (...extra: (readonly unknown[])[]) =>
    Promise.all([...keys, ...extra].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
