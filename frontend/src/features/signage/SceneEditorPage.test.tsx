import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { displayFixture, ids, mockSignage, sceneFixture } from './testFixtures';
import { draftError, toDraft } from './sceneDraft';
import { gridLayoutFixture, layoutIds, mockCustomLayouts } from './layoutFixtures';

const editor = `/signage/scenes/${ids.scene}`;

describe('Scene editor', () => {
  const clickSave = () => userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
  const mockPut = (version = 4) => {
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json(sceneFixture({ ...(body as object), version } as never));
      }),
    );
    return bodies;
  };
  const rename = async (name: string) =>
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: name } });

  it('saves on click with the expected version and not before', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    const bodies = mockPut();
    renderRoute(<App />, editor);
    expect((await screen.findAllByText('Saved')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();
    await rename('Renamed poster');
    expect(screen.getAllByText('Unsaved changes').length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(bodies).toHaveLength(0);
    await clickSave();
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      expectedVersion: 3,
      name: 'Renamed poster',
      layoutId: 'stack3',
      aspectRatio: { width: 9, height: 16 },
      backgroundColor: '#161616',
    });
    expect(await screen.findByRole('heading', { name: 'Renamed poster' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('Saved').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves with Ctrl+S even while typing in a field', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    const bodies = mockPut();
    renderRoute(<App />, editor);
    await rename('Via keyboard');
    screen.getByLabelText('Name').focus();
    await userEvent.setup().keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ expectedVersion: 3, name: 'Via keyboard' });
  });

  it('undoes and redoes edits, with typing in one field as one step', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    const original = (name as HTMLInputElement).value;
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    fireEvent.change(name, { target: { value: 'A' } });
    fireEvent.change(name, { target: { value: 'AB' } });
    fireEvent.change(name, { target: { value: 'ABC' } });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Name')).toHaveValue(original);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByLabelText('Name')).toHaveValue('ABC');
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    // Outside text fields the shortcuts work; inside them the browser keeps its own undo.
    (document.activeElement as HTMLElement | null)?.blur();
    await user.keyboard('{Control>}z{/Control}');
    expect(screen.getByLabelText('Name')).toHaveValue(original);
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(screen.getByLabelText('Name')).toHaveValue('ABC');
    await user.keyboard('{Control>}z{/Control}{Control>}y{/Control}');
    expect(screen.getByLabelText('Name')).toHaveValue('ABC');
    screen.getByLabelText('Name').focus();
    await user.keyboard('{Control>}z{/Control}');
    expect(screen.getByLabelText('Name')).toHaveValue('ABC');
  });

  it('keeps edits as separate steps when typing pauses and can undo past a save', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    mockPut();
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    const original = (name as HTMLInputElement).value;
    fireEvent.change(name, { target: { value: 'One' } });
    await new Promise((resolve) => setTimeout(resolve, 600));
    fireEvent.change(name, { target: { value: 'Two' } });
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Name')).toHaveValue('One');
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await clickSave();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Name')).toHaveValue(original);
    expect(screen.getAllByText('Unsaved changes').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('discards the edits after confirmation', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    const bodies = mockPut();
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    const original = ((await screen.findByLabelText('Name')) as HTMLInputElement).value;
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    await rename('Throw away');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(original));
    expect(screen.getAllByText('Saved').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(bodies).toHaveLength(0);
  });

  it('asks before leaving with unsaved changes', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    const bodies = mockPut();
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await rename('Not saved');
    await user.click(screen.getAllByRole('link', { name: 'Content' })[0]);
    const dialog = await screen.findByRole('alertdialog', { name: /Leave without saving/ });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Not saved');
    await user.click(screen.getAllByRole('link', { name: 'Content' })[0]);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument());
    expect(bodies).toHaveLength(0);
  });

  it('offers to reload or overwrite after a stale write (409)', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let puts = 0;
    let gets = 0;
    server.use(
      http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
        puts += 1;
        const body = (await request.json()) as { expectedVersion: number; name: string };
        return body.expectedVersion === 3
          ? HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 })
          : HttpResponse.json(sceneFixture({ name: body.name, version: body.expectedVersion + 1 }));
      }),
      http.get('*/api/v1/signage/scenes/:id', () => {
        gets += 1;
        return HttpResponse.json(gets === 1 ? sceneFixture() : sceneFixture({ name: 'Edited elsewhere', version: 7 }));
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await rename('Mine');
    await clickSave();
    expect(await screen.findByText('This scene was changed somewhere else')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep my changes' }));
    await waitFor(() => expect(puts).toBe(2));
    await waitFor(() => expect(screen.queryByText('This scene was changed somewhere else')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('drops the local edits and the history when loading the latest version', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let gets = 0;
    server.use(
      http.put('*/api/v1/signage/scenes/:id', () =>
        HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 }),
      ),
      http.get('*/api/v1/signage/scenes/:id', () => {
        gets += 1;
        return HttpResponse.json(gets === 1 ? sceneFixture() : sceneFixture({ name: 'Edited elsewhere', version: 7 }));
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await rename('Mine');
    await clickSave();
    await user.click(await screen.findByRole('button', { name: 'Load latest' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Edited elsewhere'));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('does not send what the backend would reject and says why', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let puts = 0;
    server.use(
      http.put('*/api/v1/signage/scenes/:id', () => {
        puts += 1;
        return HttpResponse.json(sceneFixture());
      }),
    );
    renderRoute(<App />, editor);
    fireEvent.change(await screen.findByLabelText('Background colour'), { target: { value: 'red' } });
    expect(await screen.findByText('Enter the background colour as #rrggbb.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(puts).toBe(0);
  });

  const prusa = {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8a201',
    name: 'Prusa MK4',
    kind: 'FDM printer',
    hasCamera: false,
  };
  const bambu = { id: '0192f6f8-743e-7c77-a349-cd07c3e8a202', name: 'Bambu H2D', kind: 'FDM printer', hasCamera: true };
  const x1c = { id: '0192f6f8-743e-7c77-a349-cd07c3e8a203', name: 'Bambu X1C', kind: 'FDM printer', hasCamera: true };

  it('lists picker machines from the signage endpoint without the machines permission', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { machines: [bambu] });
    let machinesApiCalled = false;
    server.use(
      http.get('*/api/v1/machines', () => {
        machinesApiCalled = true;
        return HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 });
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'camera');
    await user.selectOptions(await screen.findByLabelText('Source'), 'machine');
    expect(await screen.findByRole('option', { name: 'Bambu H2D' })).toBeEnabled();
    expect(machinesApiCalled).toBe(false);
  });

  it('never offers machines without a camera in the camera widget', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { machines: [prusa, bambu] });
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'camera');
    expect(await screen.findByRole('option', { name: 'Active machine (auto)' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /Machines/ }));
    expect(await screen.findByRole('option', { name: 'Bambu H2D' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Prusa MK4/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.selectOptions(screen.getByLabelText('Source'), 'machine');
    expect(await screen.findByRole('option', { name: 'Bambu H2D' })).toBeEnabled();
    expect(screen.queryByRole('option', { name: /Prusa MK4/ })).not.toBeInTheDocument();
  });

  it('explains that no machine has a camera and links to Printer connectors only with the permission', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage, PermissionId.printer_connectorsmanage], {
      machines: [prusa],
    });
    const first = renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'camera');
    expect(await screen.findByText('No machine has a camera yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings, Printer connectors' })).toHaveAttribute(
      'href',
      '/settings/local-services?tab=connectors',
    );
    first.unmount();

    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { machines: [prusa] });
    renderRoute(<App />, editor);
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'camera');
    expect(await screen.findByText('No machine has a camera yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings, Printer connectors' })).not.toBeInTheDocument();
  });

  it('saves the machines an automatic camera may show', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { machines: [prusa, bambu, x1c] });
    let zones: Record<string, Record<string, unknown>> | undefined;
    server.use(
      http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
        zones = ((await request.json()) as { zones: typeof zones }).zones;
        return HttpResponse.json(sceneFixture());
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'camera');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(zones?.footer).toMatchObject({ type: 'camera', source: 'auto', machineIds: [] }));
    await user.click(await screen.findByRole('combobox', { name: /Machines/ }));
    await user.click(await screen.findByRole('option', { name: 'Bambu X1C' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(zones?.footer).toMatchObject({ type: 'camera', source: 'auto', machineId: null, machineIds: [x1c.id] }),
    );
  });

  it('saves the machines of a status widget', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { machines: [prusa, bambu] });
    let zones: Record<string, Record<string, unknown>> | undefined;
    server.use(
      http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
        zones = ((await request.json()) as { zones: typeof zones }).zones;
        return HttpResponse.json(sceneFixture());
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'status');
    await user.click(await screen.findByRole('combobox', { name: /Machines/ }));
    await user.click(await screen.findByRole('option', { name: 'Prusa MK4' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(zones?.footer).toMatchObject({ type: 'status', machineIds: [prusa.id] }));
  });

  it('previews the real open days and events, and the empty text when there are none', async () => {
    const open = {
      ...sceneFixture(),
      zones: { header: { type: 'open_days', count: 3 }, main: { type: 'events', count: 3 }, footer: { type: 'empty' } },
    } as ReturnType<typeof sceneFixture>;
    const soon = new Date(Date.now() + 2 * 86_400_000);
    soon.setHours(14, 0, 0, 0);
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], {
      scenes: [open],
      calendar: {
        calendar: null,
        openDays: [
          {
            startsAt: soon.toISOString(),
            endsAt: new Date(soon.getTime() + 3_600_000).toISOString(),
            status: 'scheduled',
            competencies: [],
          },
        ],
        events: [{ title: 'Real repair cafe', startsAt: soon.toISOString(), endsAt: null, location: null }],
      },
    });
    const first = renderRoute(<App />, editor);
    expect(await screen.findByText('Real repair cafe')).toBeInTheDocument();
    expect(screen.queryByText('No open days planned')).not.toBeInTheDocument();
    expect(screen.queryByText('Soldering workshop')).not.toBeInTheDocument();
    first.unmount();

    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], { scenes: [open] });
    renderRoute(<App />, editor);
    expect(await screen.findByText('No open days planned')).toBeInTheDocument();
    expect(screen.getByText('No events planned')).toBeInTheDocument();
  });

  it('names the outside-visible displays that show the fallback because live cameras are not allowed', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], {
      displays: [
        displayFixture({
          name: 'Entrance window',
          visibleFromOutside: true,
          allowCameraOutside: false,
        } as never),
        displayFixture({
          id: '0192f6f8-743e-7c77-a349-cd07c3e8a152',
          name: 'Workshop',
          visibleFromOutside: true,
          allowCameraOutside: true,
        } as never),
      ],
    });
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    await user.selectOptions(screen.getByLabelText('Widget type'), 'camera');
    expect(
      await screen.findByText(
        'On Entrance window this camera shows its fallback, because live cameras are not allowed there.',
      ),
    ).toBeInTheDocument();
  });

  it('selects a zone and changes its widget type', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let zones: Record<string, { type: string }> | undefined;
    server.use(
      http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
        zones = ((await request.json()) as { zones: typeof zones }).zones;
        return HttpResponse.json(sceneFixture());
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Select zone Footer' }));
    expect(screen.getByRole('heading', { name: 'Zone: Footer' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Widget type'), 'qr');
    expect(await screen.findByText('Enter an https:// URL without credentials.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://makerspace.example/open' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(zones?.footer).toMatchObject({ type: 'qr', url: 'https://makerspace.example/open' }));
    expect(zones?.header).toMatchObject({ type: 'text' });
  });

  it('is read-only with signage.read only', async () => {
    mockSignage([PermissionId.signageread]);
    renderRoute(<App />, editor);
    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change layout' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete scene' })).not.toBeInTheDocument();
  });

  it('lists the references when a scene cannot be deleted', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    server.use(
      http.delete('*/api/v1/signage/scenes/:id', () =>
        HttpResponse.json(
          {
            code: 'signage_in_use',
            message: 'in use',
            details: { references: [{ kind: 'rule', id: ids.display, name: 'Rule 1 of Entrance window' }] },
          },
          { status: 409 },
        ),
      ),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete scene' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Delete scene' }));
    expect(
      await within(await screen.findByRole('dialog')).findByRole('link', { name: 'Rule 1 of Entrance window' }),
    ).toHaveAttribute('href', `/signage/displays/${ids.display}`);
  });
});

describe('draftError', () => {
  it('mirrors the backend rules', () => {
    const draft = toDraft(sceneFixture());
    expect(draftError(draft)).toBeNull();
    expect(draftError({ ...draft, name: '  ' })).toBe('Give the scene a name.');
    expect(
      draftError({
        ...draft,
        zones: {
          ...draft.zones,
          main: {
            type: 'camera',
            source: 'machine',
            machineId: null,
            multi: 'split',
            showProgress: true,
            showRemaining: true,
            fallback: 'text',
            fallbackMediaId: null,
          },
        },
      }),
    ).toBe('Zone Main: Choose a machine.');
  });
  it('lists the zones of a custom layout and widgets are chosen per custom zone', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage], {
      scenes: [
        sceneFixture({
          layoutId: 'custom',
          customLayoutId: layoutIds.grid,
          zones: { z1: { type: 'empty' }, z2: { type: 'empty' }, z3: { type: 'empty' } },
        }),
      ],
    });
    mockCustomLayouts([gridLayoutFixture()]);
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    expect(await screen.findByText('Poster with side')).toBeInTheDocument();
    expect(await screen.findByText('3 zones')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Select zone Top side' }));
    expect(await screen.findByRole('heading', { name: 'Zone: Top side' })).toBeInTheDocument();
  });

  it('offers custom layouts when changing the layout and saves customLayoutId', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    mockCustomLayouts([gridLayoutFixture()]);
    const bodies: Record<string, unknown>[] = [];
    server.use(
      http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json(sceneFixture({ version: 4 }));
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change layout' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByText('Poster with side'));
    await user.click(within(dialog).getByRole('button', { name: 'Change layout' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ layoutId: 'custom', customLayoutId: layoutIds.grid });
    // The header widget moves to the first custom zone; the others start empty.
    expect(Object.keys(bodies[0].zones as object)).toEqual(['z1', 'z2', 'z3']);
    expect((bodies[0].zones as Record<string, { type: string }>).z1.type).toBe('text');
  });
});
