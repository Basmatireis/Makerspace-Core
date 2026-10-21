import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { announcementFixture, displayFixture, ids, mockSignage, previewFixture, ruleFixture } from './testFixtures';

const route = `/signage/displays/${ids.display}`;
/** The default publication with a camera widget in the main zone of its scene. */
function cameraPreview() {
  const base = previewFixture();
  const scene = base.manifest!.scenes[0];
  const camera = {
    type: 'camera' as const,
    source: 'auto' as const,
    machineId: null,
    machineIds: [],
    multi: 'split' as const,
    showProgress: true,
    showRemaining: true,
    fallback: 'text' as const,
    fallbackMediaId: null,
  };
  return previewFixture({
    manifest: { ...base.manifest!, scenes: [{ ...scene, zones: { ...scene.zones, main: camera } }] },
  });
}

const pending = [
  { kind: 'scene' as const, name: 'Open days poster', change: 'modified' as const },
  { kind: 'rule' as const, name: '', change: 'added' as const },
];

describe('Display detail', () => {
  it('shows pending changes and a publish button only with signage.publish', async () => {
    mockSignage([PermissionId.signageread], { displays: [displayFixture({ pendingChanges: pending })] });
    renderRoute(<App />, route);
    expect(await screen.findByText('2 unpublished changes')).toBeInTheDocument();
    expect(screen.getByText(/Scene “Open days poster” edited · Rule added/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show announcement' })).not.toBeInTheDocument();
  });

  it('publishes the pending changes', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagepublish, PermissionId.signageoverride], {
      displays: [displayFixture({ pendingChanges: pending })],
    });
    let published = 0;
    server.use(
      http.post('*/api/v1/signage/displays/:id/publish', () => {
        published += 1;
        return HttpResponse.json(displayFixture({ publishedRevision: 3 }));
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Publish 2 changes' }));
    await waitFor(() => expect(published).toBe(1));
    expect(screen.getByRole('button', { name: 'Show announcement' })).toBeInTheDocument();
  });

  it('shows "Up to date" instead of a publish button when nothing changed', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagepublish], { displays: [displayFixture()] });
    renderRoute(<App />, route);
    expect((await screen.findAllByText('Up to date')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Publish/ })).not.toBeInTheDocument();
  });

  it('offers the first publication for a display that was never published', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagepublish], {
      displays: [displayFixture({ publishedRevision: null, publishedAt: null })],
      preview: previewFixture({ manifest: null }),
    });
    renderRoute(<App />, route);
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeInTheDocument();
    expect(await screen.findByText('Nothing is published yet, so there is nothing to preview.')).toBeInTheDocument();
  });

  it('previews the publication and marks the engine-winning rule as active', async () => {
    const manifestRule = {
      id: ids.rule,
      kind: 'announcement_active' as const,
      weekdays: [],
      timeFrom: null,
      timeTo: null,
      machineIds: [],
      machineMatch: null,
      announcementTemplateIds: [],
      targetKind: 'scene' as const,
      targetId: ids.scene2,
      minSeconds: 20,
      multiMode: 'split' as const,
      alternateSeconds: 10,
    };
    const base = previewFixture();
    const preview = previewFixture({
      manifest: {
        ...base.manifest!,
        rules: [manifestRule],
        scenes: [...base.manifest!.scenes, { ...base.manifest!.scenes[0], id: ids.scene2, name: 'Closed notice' }],
      },
      live: {
        ...base.live,
        announcements: [
          {
            id: ids.announcement,
            templateId: ids.template,
            tone: 'warning',
            title: 'Closed today',
            body: '',
            startsAt: '2026-10-19T08:00:00Z',
            endsAt: null,
          },
        ],
      },
    });
    mockSignage([PermissionId.signageread], {
      displays: [displayFixture({ currentRule: ids.rule, currentSceneId: ids.scene2 })],
      rules: [ruleFixture({ conditionKind: 'announcement_active', targetId: ids.scene2 })],
      preview,
    });
    renderRoute(<App />, route);
    expect(await screen.findByText('Closed notice')).toBeInTheDocument();
    expect(screen.getByText(/Rule 1: announcement active/)).toBeInTheDocument();
    expect((await screen.findAllByText('Active')).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 announcement active/)).toBeInTheDocument();
    expect(screen.getByText('Otherwise')).toBeInTheDocument();
  });

  it('warns when the publication has a camera widget but the display does not allow live cameras', async () => {
    mockSignage([PermissionId.signageread], { displays: [displayFixture()], preview: cameraPreview() });
    renderRoute(<App />, route);
    expect(await screen.findByText('Live cameras are not shown')).toBeInTheDocument();
  });

  it.each([
    ['the display allows live cameras', displayFixture({ allowCameraOutside: true }), cameraPreview()],
    ['the display is not visible from outside', displayFixture({ visibleFromOutside: false }), cameraPreview()],
    ['the publication has no camera widget', displayFixture(), previewFixture()],
  ])('does not warn about cameras when %s', async (_, display, preview) => {
    mockSignage([PermissionId.signageread], { displays: [display], preview });
    renderRoute(<App />, route);
    expect(await screen.findByText(/Now showing/)).toBeInTheDocument();
    expect(screen.queryByText('Live cameras are not shown')).not.toBeInTheDocument();
  });

  it('says neutrally when the display reports something else', async () => {
    mockSignage([PermissionId.signageread], {
      displays: [displayFixture({ currentRule: ids.rule })],
      rules: [ruleFixture()],
    });
    renderRoute(<App />, route);
    expect(await screen.findByText(/Display reports: rule 1/)).toBeInTheDocument();
  });

  it('reorders rules with the display version and refreshes on a stale write', async () => {
    const rules = [
      ruleFixture(),
      ruleFixture({
        id: ids.rule2,
        position: 1,
        conditionKind: 'live_data_unavailable',
        timeFrom: null,
        timeTo: null,
        weekdays: [],
      }),
    ];
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], { displays: [displayFixture()], rules });
    const bodies: unknown[] = [];
    let attempts = 0;
    server.use(
      http.put('*/api/v1/signage/displays/:id/rule-order', async ({ request }) => {
        bodies.push(await request.json());
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 })
          : HttpResponse.json({ items: [rules[1], rules[0]], displayVersion: 6 });
      }),
    );
    renderRoute(<App />, route);
    expect(await screen.findByText('Mon–Fri 08:00–10:00')).toBeInTheDocument();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Move down' }))[0]);
    await waitFor(() => expect(bodies).toEqual([{ expectedVersion: 5, ruleIds: [ids.rule2, ids.rule] }]));
    expect(await screen.findByText('The rules were changed somewhere else')).toBeInTheDocument();
  });

  it('hides rule editing without signage.manage', async () => {
    mockSignage([PermissionId.signageread], { displays: [displayFixture()], rules: [ruleFixture()] });
    renderRoute(<App />, route);
    expect(await screen.findByText('Mon–Fri 08:00–10:00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
    expect(screen.queryByText('Move down', { selector: '.cds--tooltip-content' })).not.toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
  });

  it('adds a machine rule with the display version', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [displayFixture()],
      machines: [{ id: ids.machine, name: 'H2D', kind: 'Printer', hasCamera: false }],
    });
    let body: unknown;
    server.use(
      http.post('*/api/v1/signage/displays/:id/rules', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ items: [ruleFixture()], displayVersion: 6 }, { status: 201 });
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('When'), 'machine_printing');
    await user.click(await within(dialog).findByRole('combobox', { name: /Machines/ }));
    await user.click(await screen.findByLabelText('H2D', { selector: '[role="option"]' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Show' }));
    await user.click(await screen.findByRole('option', { name: 'Scene Open days poster' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(body).toEqual({
        expectedVersion: 5,
        enabled: true,
        conditionKind: 'machine_printing',
        machineIds: [ids.machine],
        machineMatch: 'any',
        targetKind: 'scene',
        targetId: ids.scene,
        minSeconds: 20,
        multiMode: 'split',
        alternateSeconds: 10,
      }),
    );
  });

  it('deletes a revoked display from the overflow menu', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [displayFixture({ status: 'revoked', revokedAt: '2026-10-19T09:00:00Z' })],
    });
    let deleted: unknown;
    server.use(
      http.delete('*/api/v1/signage/displays/:id', async ({ request }) => {
        deleted = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Display actions/ }));
    const item = (label: string) =>
      screen.findByText(label, { selector: '.cds--overflow-menu-options__option-content' });
    expect(
      screen.queryByText('Revoke', { selector: '.cds--overflow-menu-options__option-content' }),
    ).not.toBeInTheDocument();
    await user.click(await item('Delete'));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toEqual({ expectedVersion: 5 }));
  });

  it('offers Delete next to Revoke for an active display and returns to the list', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], { displays: [displayFixture()] });
    let deleted: unknown;
    server.use(
      http.delete('*/api/v1/signage/displays/:id', async ({ request }) => {
        deleted = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, route);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Display actions/ }));
    const item = (label: string) =>
      screen.findByText(label, { selector: '.cds--overflow-menu-options__option-content' });
    expect(await item('Revoke')).toBeInTheDocument();
    await user.click(await item('Delete'));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText(
        /The display is disconnected and removed with its rules and publications\. The screen shows a new pairing code\./,
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleted).toEqual({ expectedVersion: 5 }));
    expect(await screen.findByRole('heading', { name: 'Displays' })).toBeInTheDocument();
  });

  it('lists a started announcement on this display', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signageoverride], {
      displays: [displayFixture()],
      announcements: [announcementFixture()],
    });
    renderRoute(<App />, route);
    expect(await screen.findByRole('button', { name: 'Show announcement' })).toBeInTheDocument();
  });
});
