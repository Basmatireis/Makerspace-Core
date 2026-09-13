---
applyTo: "frontend/**/*.{ts,tsx,scss,css}"
---

# Frontend instructions

- IBM Carbon is the authoritative design system.
- Use existing Carbon components whenever suitable, including forms, tables, navigation, overlays, notifications, loading states, and destructive confirmations.
- Use Carbon icons and pictograms whenever suitable.
- Use Carbon design tokens, typography, spacing, layout, and interaction patterns.
- Before building a component manually, check whether Carbon already provides one.
- Do not recreate existing Carbon components with handwritten HTML, CSS, or JavaScript.
- Custom CSS is primarily for application-specific layout or functionality Carbon does not provide.
- Import API types and request functions from `src/api/generated`; do not duplicate API contracts or call raw `fetch` from feature components.
- Keep server state in TanStack Query and forms in React Hook Form. Clear private query state after logout or session expiry.
- Permission checks in React only shape UX. Backend authorization remains authoritative.
- Never put passwords or reset tokens in URLs, query caches, persistent storage, telemetry, or notifications.
