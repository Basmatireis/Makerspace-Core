// The shell asks which guided tours the person has seen. Marking the welcome tour as dismissed keeps its first
// sign-in offer out of tests that are about something else.
export const welcomeTourSeen = {
  items: [{ guideId: 'welcome', status: 'dismissed', updatedAt: '2026-01-01T00:00:00Z' }],
};
