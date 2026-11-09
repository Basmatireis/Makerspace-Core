import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import {
  hasPermissionPresentation,
  permissionGroupOrder,
  presentPermission,
  sortPermissionsForDisplay,
} from './permissionPresentation';

describe('permission presentation', () => {
  it('presents every permission of the API contract in a known group with a label', () => {
    const missing = Object.values(PermissionId).filter((id) => !hasPermissionPresentation(id));
    expect(missing).toEqual([]);
    for (const id of Object.values(PermissionId)) {
      const presented = presentPermission({ id });
      expect(permissionGroupOrder).toContain(presented.group);
      expect(presented.label.trim()).not.toBe('');
    }
  });

  it('lists the permissions by app area with reading before editing before deleting', () => {
    const sorted = sortPermissionsForDisplay(Object.values(PermissionId).map((id) => ({ id })));
    const groups = sorted.map((permission) => presentPermission(permission).group);
    const firstSeen = permissionGroupOrder.filter((group) => groups.includes(group));
    expect(groups.filter((group, index) => groups.indexOf(group) === index)).toEqual(firstSeen);

    const ids = sorted.map((permission) => permission.id);
    expect(ids.indexOf('people.read.all')).toBeLessThan(ids.indexOf('people.update.all'));
    expect(ids.indexOf('people.update.all')).toBeLessThan(ids.indexOf('people.delete'));
    expect(ids.indexOf('inventory.read')).toBeLessThan(ids.indexOf('inventory.correct'));
    expect(ids.indexOf('inventory.correct')).toBeLessThan(ids.indexOf('inventory.delete'));
  });
});
