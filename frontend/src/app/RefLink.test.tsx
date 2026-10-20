import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../api/generated/models';
import { renderRoute } from '../test/render';
import { LinkifiedText, RefLink } from './RefLink';
import { RichNotification } from './RichNotification';
import { refKind, splitRefs } from './references';

const auth = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../features/auth/auth', () => ({ useCurrentUser: () => ({ permissions: auth.permissions }) }));

describe('references', () => {
  it('recognises reference prefixes and splits text around them', () => {
    expect(refKind('J-2026-000001')).toBe('job');
    expect(refKind('S-2026-000001')).toBe('spool');
    expect(refKind('X-2026-000001')).toBeNull();
    expect(splitRefs('R-2026-000002 follows J-2026-000001, not XJ-2026-000001.')).toEqual([
      '',
      'R-2026-000002',
      ' follows ',
      'J-2026-000001',
      ', not XJ-2026-000001.',
    ]);
  });
});

describe('RefLink', () => {
  it('links each kind to its detail page', () => {
    auth.permissions = [
      PermissionId.machine_jobsread,
      PermissionId.ordersread,
      PermissionId.paymentsread,
      PermissionId.inventoryread,
    ];
    renderRoute(
      <p>
        <RefLink reference="J-2026-000001" id="j1" /> <RefLink reference="R-2026-000001" id="r1" />{' '}
        <RefLink reference="O-2026-000001" id="o1" /> <RefLink reference="P-2026-000001" id="p1" />{' '}
        <RefLink reference="S-2026-000001" id="s1" />
      </p>,
    );
    expect(screen.getByRole('link', { name: 'J-2026-000001' })).toHaveAttribute('href', '/machine-logbook/jobs/j1');
    expect(screen.getByRole('link', { name: 'R-2026-000001' })).toHaveAttribute(
      'href',
      '/machine-logbook/jobs/runs/r1',
    );
    expect(screen.getByRole('link', { name: 'O-2026-000001' })).toHaveAttribute('href', '/orders/o1');
    expect(screen.getByRole('link', { name: 'P-2026-000001' })).toHaveAttribute('href', '/payments/p1');
    expect(screen.getByRole('link', { name: 'S-2026-000001' })).toHaveAttribute(
      'href',
      '/machine-logbook/inventory/spools/s1',
    );
  });

  it('stays plain text without the read permission, without an id, or on the page itself', () => {
    auth.permissions = [PermissionId.machine_jobsread];
    renderRoute(
      <p>
        <RefLink reference="O-2026-000001" id="o1" /> <RefLink reference="J-2026-000002" id={null} />{' '}
        <RefLink reference="J-2026-000003" id="j3" />
      </p>,
      '/machine-logbook/jobs/j3',
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText(/O-2026-000001/)).toBeInTheDocument();
  });

  it('linkifies only the references it has targets for', () => {
    auth.permissions = [PermissionId.ordersread];
    renderRoute(
      <p>
        <LinkifiedText text="Moved from O-2026-000001 to O-2026-000002." targets={{ 'O-2026-000002': 'o2' }} />
      </p>,
    );
    expect(screen.getByRole('link', { name: 'O-2026-000002' })).toHaveAttribute('href', '/orders/o2');
    expect(screen.queryByRole('link', { name: 'O-2026-000001' })).not.toBeInTheDocument();
  });

  it('RichNotification may contain links', () => {
    auth.permissions = [PermissionId.ordersread];
    renderRoute(
      <RichNotification kind="info" title="On an order">
        <RefLink reference="O-2026-000001" id="o1" /> was charged.
      </RichNotification>,
    );
    expect(screen.getByText('On an order')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'O-2026-000001' })).toBeInTheDocument();
  });
});
