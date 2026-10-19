import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useNow } from '../../store';
import { DisplayScreen } from '../components/DisplayScreen';
import { SceneRenderer, ScreenFrame } from '../components/SceneRenderer';
import { sampleRendered } from '../helpers';
import { PAIRING_CODE } from '../mockData';
import { useSignage } from '../SignageContext';
import { PREVIEW_PRESETS } from '../widgets';
import type { MachineSim } from '../types';
import '../signage.scss';

const NEXT: Record<MachineSim, MachineSim> = { idle: 'printing', printing: 'camera_unavailable', camera_unavailable: 'idle' };
const LABEL: Record<MachineSim, string> = { idle: 'idle', printing: 'printing', camera_unavailable: 'camera down' };

/**
 * Fullscreen player. Intentionally plain markup and CSS: the real player is a separate small app without the design system.
 * Route `/signage/play/:id` is a paired display, `unpaired` the pairing screen, and a scene id previews that scene.
 */
export function PlayerPage() {
  const { displayId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const signage = useSignage();
  const now = useNow(1000);
  const display = signage.displays.find((item) => item.id === displayId);
  const scene = signage.scenes.find((item) => item.id === displayId);
  const back = () => { if (window.history.length > 1) navigate(-1); else navigate('/signage'); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') back(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const preset = scene ? PREVIEW_PRESETS.find((item) => item.id === search.get('as')) : undefined;
  const previewSim = preset?.sim ?? signage.sim;
  const previewAnnouncements = preset?.announcement ? sampleRendered(signage.announcementTemplates, new Date(now)) : [];
  const bar = (
    <div className="sg-player__bar">
      <button type="button" onClick={back}>Back</button>
      <button type="button" onClick={() => signage.setSim({ h2d: NEXT[signage.sim.h2d] })}>H2D: {LABEL[signage.sim.h2d]}</button>
      <button type="button" onClick={() => signage.setSim({ x1c: NEXT[signage.sim.x1c] })}>X1C: {LABEL[signage.sim.x1c]}</button>
      <button type="button" onClick={() => signage.setSim({ coreReachable: !signage.sim.coreReachable })}>Core: {signage.sim.coreReachable ? 'reachable' : 'unreachable'}</button>
      <button type="button" onClick={() => { if (signage.announcements.length > 0) signage.stopAllAnnouncements(); else signage.startSampleClosed(); }}>Announcement: {signage.announcements.length > 0 ? 'on' : 'off'}</button>
    </div>
  );

  if (display && !display.revoked) {
    return (
      <div className="sg-player">
        <DisplayScreen display={display} sim={signage.sim} now={now} media={signage.media} width={`min(100vw, calc(100vh * ${display.resolution.w / display.resolution.h}))`} />
        {bar}
      </div>
    );
  }
  if (scene) {
    return (
      <div className="sg-player">
        <ScreenFrame orientation={scene.orientation} width={`min(100vw, calc(100vh * ${scene.orientation === 'portrait' ? 1080 / 1920 : 1920 / 1080}))`}>
          <SceneRenderer scene={scene} sim={previewSim} now={now} media={signage.media} announcements={previewAnnouncements} />
        </ScreenFrame>
        {bar}
      </div>
    );
  }
  return (
    <div className="sg-player sg-pairing">
      <div className="sg-pairing__box">
        <p className="sg-pairing__title">This screen is not paired</p>
        <p className="sg-pairing__code" aria-label={`Pairing code ${PAIRING_CODE.split('').join(' ')}`}>{PAIRING_CODE}</p>
        <p className="sg-pairing__hint">Enter this code in Makerspace Core › Signage › Pair display</p>
        {display?.revoked && <p className="sg-pairing__hint">This screen’s credential was revoked.</p>}
      </div>
      {bar}
    </div>
  );
}
