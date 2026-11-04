/* eslint-disable react-refresh/only-export-components -- the provider and its hook belong together */
import { createContext, lazy, Suspense, useContext, useMemo, useState, type ReactNode } from 'react';

// The overlay, the step logic and the guide content load when a guide first starts.
const GuideRunner = lazy(() => import('./GuideRunner'));

interface GuidesValue {
  activeGuideId: string | null;
  startGuide: (id: string) => void;
  stopGuide: () => void;
}

const noGuides: GuidesValue = { activeGuideId: null, startGuide: () => undefined, stopGuide: () => undefined };
const GuidesContext = createContext<GuidesValue>(noGuides);

export function GuideProvider({ children }: { children: ReactNode }) {
  const [activeGuideId, setActiveGuideId] = useState<string | null>(null);
  const value = useMemo<GuidesValue>(
    // Identity matters: consumers list these in effect dependencies.
    () => ({ activeGuideId, startGuide: setActiveGuideId, stopGuide: () => setActiveGuideId(null) }),
    [activeGuideId],
  );
  return (
    <GuidesContext.Provider value={value}>
      {children}
      {activeGuideId && (
        <Suspense fallback={null}>
          <GuideRunner key={activeGuideId} guideId={activeGuideId} onClose={value.stopGuide} />
        </Suspense>
      )}
    </GuidesContext.Provider>
  );
}

export function useGuides(): GuidesValue {
  return useContext(GuidesContext);
}
