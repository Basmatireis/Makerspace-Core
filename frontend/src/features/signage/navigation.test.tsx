import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { AppNavigation } from '../../app/AppNavigation';
import { defaultPublicConfiguration } from '../branding/branding';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';

const renderNavigation = (permissions: PermissionId[], route = '/dashboard') =>
  renderRoute(
    <AppNavigation
      currentUser={currentUserFixture(permissions)}
      legal={defaultPublicConfiguration.legal}
      onNavigate={vi.fn()}
    />,
    route,
  );

describe('Signage navigation', () => {
  it('shows no Signage group without signage.read', () => {
    renderNavigation([PermissionId.signagecontentmanage, PermissionId.signagemanage]);
    expect(screen.queryByRole('button', { name: 'Signage' })).not.toBeInTheDocument();
  });

  it('lists Displays, Announcements, Content and Media for signage.read and opens the group on signage pages', () => {
    renderNavigation([PermissionId.signageread], '/signage/scenes/some-scene');
    expect(screen.getByRole('button', { name: 'Signage' })).toHaveAttribute('aria-expanded', 'true');
    const links = screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/signage'));
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Displays', '/signage'],
      ['Announcements', '/signage/announcements'],
      ['Content', '/signage/content'],
      ['Media', '/signage/media'],
    ]);
    expect(screen.getByRole('link', { name: 'Content' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Media' })).not.toHaveAttribute('aria-current');
  });

  it('marks Displays active on display pages', () => {
    renderNavigation([PermissionId.signageread], '/signage/displays/some-display');
    expect(screen.getByRole('link', { name: 'Displays' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Announcements' })).not.toHaveAttribute('aria-current');
  });

  it('shows only Announcements for signage.override', () => {
    renderNavigation([PermissionId.signageoverride], '/signage/announcements');
    const links = screen.getAllByRole('link').filter((link) => link.getAttribute('href')?.startsWith('/signage'));
    expect(links.map((link) => link.textContent)).toEqual(['Announcements']);
  });

  it('hides Displays, Content and Media for signage.manage alone', () => {
    renderNavigation([PermissionId.signagemanage]);
    expect(screen.queryByRole('button', { name: 'Signage' })).not.toBeInTheDocument();
  });
});
