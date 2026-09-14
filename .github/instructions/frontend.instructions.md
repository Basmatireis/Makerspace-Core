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

## UI implementation and verification

- Do not judge UI correctness from source code alone.

- For frontend changes that affect the rendered interface, run the application and inspect the affected page in a real browser whenever browser tooling is available.

- Use browser inspection iteratively:
  - open the affected page
  - inspect the rendered result
  - identify visual or interaction issues
  - adjust the implementation
  - reload and verify again

- Verify layout, spacing, alignment, sizing, typography, overflow, responsive behavior, and component states.

- Compare the rendered result with provided screenshots, mockups, or existing application patterns when available.

- Treat screenshots and the rendered browser result as more authoritative for visual correctness than assumptions made from the source code.

- Do not consider a UI task complete only because the code compiles, linting passes, or automated tests pass.

- Use Playwright or equivalent browser tooling for navigation, interaction, and visual inspection when available.

- Do not create brittle pixel-perfect tests unless explicitly required.

- Verify relevant component states such as loading, empty, error, disabled, hover, focus, and destructive confirmation states.

- Check for obvious browser console errors after UI changes.

- Prefer consistency with the existing application UI and Carbon conventions over introducing new visual patterns.

- Avoid unnecessary custom styling when the same result can be achieved through Carbon components, Carbon tokens, or existing application layout primitives.