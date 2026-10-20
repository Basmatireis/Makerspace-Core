import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SceneRenderer } from './SceneRenderer';
import type { RenderData, RenderMachine, RenderScene } from './types';

const machine = (id: string, name: string, state: RenderMachine['state'] = 'printing'): RenderMachine => ({ machineId: id, name, state, progressPercent: 10, remainingMinutes: 5, stale: false });
const data = (machines: RenderMachine[]): RenderData => ({ now: Date.now(), liveAvailable: true, machines, announcements: [], openDays: [], events: [], assetUrl: () => null });
const scene = (camera: Record<string, unknown>): RenderScene => ({
  orientation: 'landscape', layoutId: 'full', backgroundColor: '#161616', backgroundAssetId: null, backgroundFit: 'cover', backgroundDim: 0, theme: 'dark',
  zones: { main: { type: 'camera', source: 'auto', machineId: null, multi: 'split', showProgress: false, showRemaining: false, fallback: 'text', fallbackMediaId: null, ...camera } },
}) as RenderScene;

describe('camera widget machine list', () => {
  const machines = [machine('a', 'Alpha'), machine('b', 'Beta'), machine('c', 'Gamma', 'idle')];

  it('auto without a list shows every printing machine', () => {
    render(<SceneRenderer scene={scene({})} data={data(machines)} />);
    expect(screen.getByRole('img', { name: 'Camera of Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Camera of Beta' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Camera of Gamma' })).not.toBeInTheDocument();
  });

  it('auto with a list only picks allowed machines that print', () => {
    render(<SceneRenderer scene={scene({ machineIds: ['b', 'c'] })} data={data(machines)} />);
    expect(screen.queryByRole('img', { name: 'Camera of Alpha' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Camera of Beta' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Camera of Gamma' })).not.toBeInTheDocument();
  });

  it('falls back when no allowed machine prints', () => {
    render(<SceneRenderer scene={scene({ machineIds: ['c'] })} data={data(machines)} />);
    expect(screen.getByText('Live view unavailable')).toBeInTheDocument();
  });
});
