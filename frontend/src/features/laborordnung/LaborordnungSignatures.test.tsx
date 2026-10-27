import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const version = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a930',
  status: 'published' as const,
  humanRevision: '2026.1',
  pdfFileId: '0192f6f8-743e-7c77-a349-cd07c3e8a931',
  sha256: 'a'.repeat(64),
  createdAt: '2026-01-01T00:00:00Z',
  effectiveAt: '2026-01-01T00:00:00Z',
  publishedAt: '2026-01-01T00:00:00Z',
};
const signature = {
  id: '0192f6f8-743e-7c77-a349-cd07c3e8a932',
  personId: '0192f6f8-743e-7c77-a349-cd07c3e8a933',
  personName: 'Grace Hopper',
  versionId: version.id,
  humanRevision: '2026.1',
  signedDate: '2026-03-01',
  physicalDocumentReference: 'folder-7',
  confirmedByName: 'Ada Lovelace',
  confirmedAt: '2026-03-02T09:00:00Z',
};

describe('Lab Rules signatures', () => {
  it('lists signatures for readers and passes search, filter and paging to the server', async () => {
    const requests: URL[] = [];
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.laborordnungrequestsread])),
      ),
      http.get('*/api/v1/laborordnung/versions', () => HttpResponse.json({ items: [version] })),
      http.get('*/api/v1/laborordnung/requests', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/laborordnung/signatures', ({ request }) => {
        requests.push(new URL(request.url));
        return HttpResponse.json({ items: [signature], page: 1, pageSize: 25, total: 1 });
      }),
    );
    renderRoute(<App />, '/settings/laborordnung?tab=signatures&sig-q=hopper&sig-version=' + version.id);
    const row = (await screen.findByText('folder-7')).closest('tr') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Grace Hopper' })).toBeInTheDocument();
    expect(within(row).getByText('Ada Lovelace')).toBeInTheDocument();
    const last = requests[requests.length - 1];
    expect(last.searchParams.get('search')).toBe('hopper');
    expect(last.searchParams.get('versionId')).toBe(version.id);
    expect(last.searchParams.get('sort')).toBe('confirmedAt');
    expect(last.searchParams.get('direction')).toBe('desc');
  });

  it('offers no Signatures tab without laborordnung.requests.read', async () => {
    let called = false;
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.laborordnungmanage]))),
      http.get('*/api/v1/laborordnung/versions', () => HttpResponse.json({ items: [version] })),
      http.get('*/api/v1/laborordnung/signatures', () => {
        called = true;
        return HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0 });
      }),
    );
    renderRoute(<App />, '/settings/laborordnung?tab=signatures');
    expect(await screen.findByText('Version history')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Signatures' })).not.toBeInTheDocument();
    expect(called).toBe(false);
  });
});
