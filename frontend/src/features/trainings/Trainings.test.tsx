import { http, HttpResponse } from 'msw';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  CompetencyCategory,
  SetTrainingRecordRequest,
  Training,
  TrainingRecord,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixturePersonId, otherPersonId, personFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { CompetencyTags } from './CompetencyTags';

const h2dId = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
const laserId = '0192f6f8-743e-7c77-a349-cd07c3e8d002';
const printingId = '0192f6f8-743e-7c77-a349-cd07c3e8d101';

const records: TrainingRecord[] = [
  {
    trainingId: h2dId,
    trainingName: 'Bambu Lab H2D',
    trainingActive: true,
    status: 'not_trained',
    version: null,
    completedOn: null,
    updatedAt: null,
  },
  {
    trainingId: laserId,
    trainingName: 'Trotec Speedy',
    trainingActive: true,
    status: 'trainer',
    version: 3,
    completedOn: '2026-09-14',
    notes: 'Gave the October session',
    updatedAt: '2026-10-01T00:00:00Z',
  },
];

function serveRecords(personId: string, permissions: PermissionId[], items: TrainingRecord[] = records) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get(`*/api/v1/people/${otherPersonId}`, () => HttpResponse.json(personFixture())),
    http.get(`*/api/v1/people/${personId}/training-records`, () => HttpResponse.json({ items })),
  );
}

describe('training records on the person page', () => {
  it('sets one of three states for another person', async () => {
    const user = userEvent.setup();
    let body: SetTrainingRecordRequest | undefined;
    serveRecords(otherPersonId, [PermissionId.peoplereadall, PermissionId.training_recordsupdate]);
    server.use(
      http.put(`*/api/v1/people/${otherPersonId}/training-records/${h2dId}`, async ({ request }) => {
        body = (await request.json()) as SetTrainingRecordRequest;
        return HttpResponse.json({ ...records[0], status: body.status, version: 1 });
      }),
    );
    renderRoute(<App />, `/people/${otherPersonId}?tab=trainings`);

    const list = await screen.findByRole('table', { name: 'Trainings' });
    expect(within(list).getByText('Not trained')).toBeInTheDocument();
    expect(within(list).getByText('Can train others')).toBeInTheDocument();
    expect(within(list).getByText('14.09.2026')).toBeInTheDocument();
    expect(within(list).getByText('Gave the October session')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change status for Bambu Lab H2D' }));
    const dialog = await screen.findByRole('dialog');
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('value'))).toEqual(['not_trained', 'trained', 'trainer']);
    await user.click(within(dialog).getByRole('radio', { name: 'Trained' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(body).toEqual({ status: 'trained', completedOn: null, notes: null, expectedVersion: null }),
    );
  });

  it('removing a status sends only the version', async () => {
    const user = userEvent.setup();
    let body: SetTrainingRecordRequest | undefined;
    serveRecords(otherPersonId, [PermissionId.peoplereadall, PermissionId.training_recordsupdate]);
    server.use(
      http.put(`*/api/v1/people/${otherPersonId}/training-records/${laserId}`, async ({ request }) => {
        body = (await request.json()) as SetTrainingRecordRequest;
        return HttpResponse.json({ ...records[1], status: 'not_trained', version: null });
      }),
    );
    renderRoute(<App />, `/people/${otherPersonId}?tab=trainings`);
    await user.click(await screen.findByRole('button', { name: 'Change status for Trotec Speedy' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Not trained' }));
    expect(within(dialog).queryByLabelText(/Internal notes/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ status: 'not_trained', expectedVersion: 3 }));
  });

  it('shows the tab read-only to readers and hides it from others', async () => {
    serveRecords(otherPersonId, [PermissionId.peoplereadall, PermissionId.training_recordsreadall]);
    const { unmount } = renderRoute(<App />, `/people/${otherPersonId}?tab=trainings`);
    expect(await screen.findByRole('table', { name: 'Trainings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change status/ })).not.toBeInTheDocument();
    unmount();

    serveRecords(otherPersonId, [PermissionId.peoplereadall, PermissionId.training_recordsreadself]);
    renderRoute(<App />, `/people/${otherPersonId}`);
    expect(await screen.findByRole('tablist', { name: 'Person detail sections' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Trainings' })).not.toBeInTheDocument();
  });

  it('never offers to change the own status, even with the update permission', async () => {
    serveRecords(fixturePersonId, [PermissionId.training_recordsupdate]);
    renderRoute(<App />, '/profile');
    const section = await screen.findByRole('table', { name: 'Trainings' });
    expect(within(section).getByText('Can train others')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change status/ })).not.toBeInTheDocument();
  });
});

describe('trainings settings', () => {
  const category: CompetencyCategory = {
    id: printingId,
    name: '3D printing',
    description: null,
    active: true,
    sortOrder: 10,
    trainingCount: 1,
    version: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
  const training: Training = {
    id: h2dId,
    name: 'Bambu Lab H2D',
    description: null,
    active: true,
    sortOrder: 0,
    competencyIds: [printingId],
    machineTypeIds: [],
    recordCount: 2,
    version: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };

  function serveCatalogue() {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.trainingsmanage]))),
      http.get('*/api/v1/trainings', () => HttpResponse.json({ items: [training] })),
      http.get('*/api/v1/competency-categories', () => HttpResponse.json({ items: [category] })),
    );
  }

  it('lists trainings with their competencies and blocks deleting trainings with records', async () => {
    const user = userEvent.setup();
    serveCatalogue();
    renderRoute(<App />, '/settings/trainings');
    const table = await screen.findByRole('table');
    const row = within(table).getByText('Bambu Lab H2D').closest('tr')!;
    expect(within(row).getByText('3D printing')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Actions for Bambu Lab H2D' }));
    // jsdom never positions the floating menu: it stays visibility: hidden and its items have no accessible name.
    const items = await screen.findAllByRole('menuitem', { hidden: true });
    expect(items.find((item) => item.textContent === 'Delete')).toBeDisabled();
  });

  it('adds a competency', async () => {
    const user = userEvent.setup();
    let body: unknown;
    serveCatalogue();
    server.use(
      http.post('*/api/v1/competency-categories', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ ...category, id: '0192f6f8-743e-7c77-a349-cd07c3e8d102', name: 'Electronics' });
      }),
    );
    renderRoute(<App />, '/settings/trainings?tab=competencies');
    await user.click(await screen.findByRole('button', { name: 'Add competency' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Public label'), '  Electronics ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ name: 'Electronics', description: null, active: true, sortOrder: 0 }));
  });

  it('is reachable only with trainings.manage', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.training_recordsupdate, PermissionId.open_daysmanage])),
      ),
    );
    renderRoute(<App />, '/settings/trainings');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});

describe('competency tags', () => {
  const many = ['3D printing', 'Laser cutting', 'Electronics', 'A very long competency name that wraps'].map(
    (label, index) => ({ id: `0192f6f8-743e-7c77-a349-cd07c3e8d20${index}`, label }),
  );

  it('renders nothing without competencies', () => {
    const { container } = render(<CompetencyTags competencies={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the first entries and the rest as +N', () => {
    render(<CompetencyTags competencies={many} limit={2} />);
    expect(screen.getByText('3D printing')).toBeInTheDocument();
    expect(screen.getByText('Laser cutting')).toBeInTheDocument();
    expect(screen.queryByText('Electronics')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByTitle('Electronics, A very long competency name that wraps')).toBeInTheDocument();
  });
});
