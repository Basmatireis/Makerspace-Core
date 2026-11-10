import { http, HttpResponse } from 'msw';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { AUTOSAVE_DELAY_MS } from './editor/useAutosave';
import {
  blockFixture,
  displayFixture,
  groupFixture,
  ids,
  mockSignage,
  ruleFixture,
  sceneFixture,
} from './testFixtures';
import { defaultWidget } from './widgets';

const editor = `/signage/scenes/${ids.scene}`;
const editing = [PermissionId.signageread, PermissionId.signagecontentmanage];

/** Two blocks apart from each other, so arranging them changes something. */
const twoBlocks = () =>
  sceneFixture({
    blocks: [
      blockFixture('left', { x: 96, y: 96, w: 320, h: 240 }, defaultWidget('clock')),
      blockFixture('right', { x: 504, y: 600, w: 400, h: 240 }, { type: 'empty' }),
    ],
  });

const block = (id: string) => document.querySelector<HTMLElement>(`.sg-canvas [data-block-id="${id}"]`);
const layer = (name: string) => screen.findByRole('button', { name, pressed: false });

const mockPut = (respond?: (body: Record<string, unknown>) => Response) => {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.put('*/api/v1/signage/scenes/:id', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      bodies.push(body);
      return (
        respond?.(body) ??
        HttpResponse.json(sceneFixture({ ...(body as object), version: (body.expectedVersion as number) + 1 } as never))
      );
    }),
  );
  return bodies;
};

describe('Screen editor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads a screen and renders its blocks on the canvas and in the list, front first', async () => {
    mockSignage(editing);
    renderRoute(<App />, editor);
    expect(await screen.findByRole('textbox', { name: 'Screen name' })).toHaveValue('Open days poster');
    const rows = within(screen.getByRole('region', { name: 'Blocks' })).getAllByRole('button', { pressed: false });
    expect(rows.map((row) => row.textContent)).toEqual(['footer', 'main', 'header']);
    expect(block('header')).toHaveStyle({ left: '0px', top: '0px', width: '1080px' });
    expect(block('main')).not.toBeNull();
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
    expect(screen.getByText(/Looks exactly like on every 9:16 display/)).toBeInTheDocument();
  });

  it('adds a block from the palette and fills a selected empty block', async () => {
    mockSignage(editing);
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    const palette = await screen.findByRole('region', { name: 'Add to screen' });
    await user.click(within(palette).getByRole('button', { name: 'QR code' }));
    expect(await screen.findByRole('button', { name: 'QR code', pressed: true })).toBeInTheDocument();
    expect(document.querySelectorAll('.sg-canvas [data-block-id]')).toHaveLength(4);
    // With the empty footer selected, a palette click fills it instead of adding a block.
    await user.click(await layer('footer'));
    await user.click(within(palette).getByRole('button', { name: 'Clock' }));
    expect(document.querySelectorAll('.sg-canvas [data-block-id]')).toHaveLength(4);
    expect(block('footer')).toHaveClass('sg-block--clock');
  });

  it('nudges the selection with the arrow keys and undoes and redoes it', async () => {
    mockSignage(editing);
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await layer('header'));
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}{ArrowDown}');
    expect(block('header')).toHaveStyle({ left: '10px', top: '1px' });
    // Nudges right after each other are one undo step.
    await user.click(screen.getByRole('button', { name: /^Undo/ }));
    expect(block('header')).toHaveStyle({ left: '0px', top: '0px' });
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(block('header')).toHaveStyle({ left: '10px', top: '1px' });
    await user.keyboard('{Control>}z{/Control}');
    expect(block('header')).toHaveStyle({ left: '0px' });
    await user.keyboard('{Delete}');
    expect(block('header')).toBeNull();
  });

  it('selects several blocks with Shift and aligns them with the group toolbar', async () => {
    mockSignage(editing, { scenes: [twoBlocks()] });
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await layer('left'));
    await user.keyboard('{Shift>}');
    await user.click(await layer('right'));
    await user.keyboard('{/Shift}');
    const toolbar = await screen.findByRole('toolbar', { name: 'Actions for 2 blocks' });
    await user.click(within(toolbar).getByRole('button', { name: 'Align left edges' }));
    expect(block('right')).toHaveStyle({ left: '96px', top: '600px' });
    await user.click(within(toolbar).getByRole('button', { name: 'Align top edges' }));
    expect(block('right')).toHaveStyle({ top: '96px' });
    expect(block('left')).toHaveStyle({ left: '96px', top: '96px' });
  });

  it('autosaves after a pause with the version of the last response and saves again after more changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    mockSignage(editing);
    const bodies = mockPut();
    renderRoute(<App />, editor);
    const name = await screen.findByRole('textbox', { name: 'Screen name' });
    fireEvent.change(name, { target: { value: 'Renamed poster' } });
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 300));
    expect(bodies).toHaveLength(0);
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(400));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ expectedVersion: 3, name: 'Renamed poster', blocks: expect.any(Array) });
    expect(await screen.findByText('Draft saved')).toBeInTheDocument();
    fireEvent.change(name, { target: { value: 'Renamed again' } });
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ expectedVersion: 4, name: 'Renamed again' });
  });

  it('stops on a stale write and loads the latest version or keeps the changes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    mockSignage(editing);
    let gets = 0;
    const bodies = mockPut((body) =>
      body.expectedVersion === 3
        ? HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 })
        : HttpResponse.json(sceneFixture({ ...(body as object), version: 8 } as never)),
    );
    server.use(
      http.get('*/api/v1/signage/scenes/:id', () => {
        gets += 1;
        return HttpResponse.json(gets === 1 ? sceneFixture() : sceneFixture({ name: 'Edited elsewhere', version: 7 }));
      }),
    );
    renderRoute(<App />, editor);
    const name = await screen.findByRole('textbox', { name: 'Screen name' });
    fireEvent.change(name, { target: { value: 'Mine' } });
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100));
    expect(await screen.findByText('Changed elsewhere')).toBeInTheDocument();
    // No retries while the conflict waits for a decision.
    await act(() => vi.advanceTimersByTimeAsync(3 * AUTOSAVE_DELAY_MS));
    expect(bodies).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Keep my changes' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toMatchObject({ expectedVersion: 7, name: 'Mine' });
    expect(await screen.findByText('Draft saved')).toBeInTheDocument();
  });

  it('replaces the draft with the latest version on Load latest', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    mockSignage(editing);
    let gets = 0;
    mockPut(() => HttpResponse.json({ code: 'stale_write', message: 'Stale' }, { status: 409 }));
    server.use(
      http.get('*/api/v1/signage/scenes/:id', () => {
        gets += 1;
        return HttpResponse.json(gets === 1 ? sceneFixture() : sceneFixture({ name: 'Edited elsewhere', version: 7 }));
      }),
    );
    renderRoute(<App />, editor);
    const name = await screen.findByRole('textbox', { name: 'Screen name' });
    fireEvent.change(name, { target: { value: 'Mine' } });
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 100));
    fireEvent.click(await screen.findByRole('button', { name: 'Load latest' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Screen name' })).toHaveValue('Edited elsewhere'));
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  });

  it('is read-only without signage.content.manage', async () => {
    mockSignage([PermissionId.signageread], { displays: [displayFixture()] });
    const bodies = mockPut();
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    expect(await screen.findByRole('textbox', { name: 'Screen name' })).toHaveAttribute('readonly');
    expect(screen.getByText('Read only')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Add to screen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Lock / })).not.toBeInTheDocument();
    // Blocks can be selected to look at them, but keys change nothing.
    await user.click(await layer('header'));
    expect(screen.getByRole('button', { name: 'header', pressed: true })).toBeInTheDocument();
    await user.keyboard('{ArrowRight}{Delete}');
    expect(block('header')).toHaveStyle({ left: '0px' });
    expect(screen.queryByRole('toolbar', { name: /Actions for/ })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(bodies).toHaveLength(0);
  });

  it('publishes the displays and groups that show the screen after saving', async () => {
    mockSignage([...editing, PermissionId.signagepublish], {
      displays: [
        displayFixture(),
        displayFixture({ id: ids.scene2, name: 'Member', groupId: ids.group, defaultScenes: [] }),
      ],
      groups: [groupFixture({ defaultScenes: [], displayIds: [ids.scene2] })],
      groupRules: [ruleFixture()],
    });
    const published: string[] = [];
    server.use(
      http.post('*/api/v1/signage/displays/:id/publish', ({ params }) => {
        published.push(`display:${params.id as string}`);
        return HttpResponse.json(displayFixture());
      }),
      http.post('*/api/v1/signage/groups/:id/publish', ({ params }) => {
        published.push(`group:${params.id as string}`);
        return HttpResponse.json(groupFixture());
      }),
    );
    renderRoute(<App />, editor);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Publish screen' })).toBeInTheDocument();
    expect(await within(dialog).findByLabelText('Entrance window · Ground floor')).toBeChecked();
    expect(within(dialog).getByLabelText('Hallway screens · Group of 1 display')).toBeChecked();
    // A member of a group is published with its group.
    expect(within(dialog).queryByText(/Member/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Hallway screens · Group of 1 display'));
    await user.click(within(dialog).getByRole('button', { name: 'Publish to 1 display' }));
    await waitFor(() => expect(published).toEqual([`display:${ids.display}`]));
  });

  it('has no Publish button without signage.publish', async () => {
    mockSignage(editing, { displays: [displayFixture()] });
    renderRoute(<App />, editor);
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });
});
