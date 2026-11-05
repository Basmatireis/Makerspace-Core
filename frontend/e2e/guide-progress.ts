// The shell asks which guided tours the person has seen. Marking the welcome tour and the area tours as dismissed
// keeps their offers out of tests that are about something else.
export const welcomeTourSeen = {
  items: ['open-days-tour', 'sales-tour', 'welcome', 'workshop-tour'].map((guideId) => ({
    guideId,
    status: 'dismissed',
    updatedAt: '2026-01-01T00:00:00Z',
  })),
};
