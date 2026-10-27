import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../../api/generated/models';
import { App } from '../../../app/App';
import { currentUserFixture, personFixture } from '../../../test/fixtures';
import { renderRoute } from '../../../test/render';
import { server } from '../../../test/server';
import { candidate, previewOf } from './mergeFixtures';

const idA = '0192f6f8-743e-7c77-a349-cd07c3e8a911';
const idB = '0192f6f8-743e-7c77-a349-cd07c3e8a912';
const mergePermissions = [PermissionId.peoplereadall, PermissionId.peoplemerge];

function useWizardMocks(
  preview = previewOf([candidate(idA, { phone: null }), candidate(idB, { firstName: 'Augusta', phone: '555' })]),
) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(mergePermissions))),
    http.get('*/api/v1/people/:id', ({ params }) =>
      HttpResponse.json(personFixture({ id: String(params.id), firstName: params.id === idA ? 'Ada' : 'Augusta' })),
    ),
    http.post('*/api/v1/people/merge/preview', () => HttpResponse.json(preview)),
  );
}

async function openPreview() {
  const user = userEvent.setup();
  renderRoute(<App />, `/people/merge?person=${idA}&person=${idB}`);
  const next = await screen.findByRole('button', { name: 'Continue' });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
  return user;
}

describe('People merge wizard', () => {
  it('hides the batch action without people.merge and offers it with the permission', async () => {
    const page = { items: [personFixture({ id: idA }), personFixture({ id: idB })], page: 1, pageSize: 25, total: 2 };
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.peoplereadall]))),
      http.get('*/api/v1/people', () => HttpResponse.json(page)),
    );
    const first = renderRoute(<App />, '/people');
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByText('Merge people')).not.toBeInTheDocument();
    first.unmount();

    server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(mergePermissions))));
    renderRoute(<App />, '/people');
    expect(await screen.findByText('Merge people')).toBeInTheDocument();
  });

  it('disables continue and explains every blocking conflict', async () => {
    useWizardMocks(
      previewOf([candidate(idA), candidate(idB)], {
        canMerge: false,
        conflicts: [{ code: 'pin_conflict', message: 'x', personIds: [idA, idB] }],
      }),
    );
    await openPreview();
    expect(await screen.findByText(/More than one of these accounts has a PIN/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('sends the versions and only the changed field sources', async () => {
    useWizardMocks();
    let body: unknown;
    server.use(
      http.post('*/api/v1/people/merge', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ person: personFixture({ id: idA }), mergedPersonIds: [idB], moved: [] });
      }),
    );
    const user = await openPreview();
    await user.click(await screen.findByLabelText('Phone from Ada Lovelace'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByLabelText(/I understand/));
    await user.click(screen.getByRole('button', { name: 'Merge 2 people' }));
    expect(await screen.findByText('People merged')).toBeInTheDocument();
    expect(body).toMatchObject({
      targetPersonId: idA,
      sourcePersonIds: [idB],
      fieldSources: { phone: idA },
      expectedVersions: [
        { personId: idA, version: 1, accountVersion: null },
        { personId: idB, version: 1, accountVersion: null },
      ],
    });
  });

  it('offers a new preview after a stale write', async () => {
    useWizardMocks();
    server.use(
      http.post('*/api/v1/people/merge', () =>
        HttpResponse.json({ code: 'stale_write', message: 'stale' }, { status: 409 }),
      ),
    );
    const user = await openPreview();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByLabelText(/I understand/));
    await user.click(screen.getByRole('button', { name: 'Merge 2 people' }));
    expect(await screen.findByText('Someone changed these people')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge 2 people' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Run preview again' }));
    expect(await screen.findByRole('table', { name: /Values to keep/ })).toBeInTheDocument();
  });
});
