---
applyTo: "backend/**/*.go"
---

# Backend instructions

- Keep features in their owning module; avoid global handler/service/repository folders.
- Business logic, authorization, and transaction boundaries belong in services, not HTTP handlers.
- Use pgx and sqlc rather than an ORM. Keep SQL explicit and reviewable.
- Depend on narrow interfaces only at real module/test seams; do not create speculative abstractions.
- Authorize with typed registered permissions, never business role-name checks. The `master` system key is the sole exception.
- Treat sensitive-field filtering as a backend response concern.
- Audit important mutations atomically without retaining secret or PII values.
- Do not expose sqlc rows or OpenAPI-generated types as domain models.
- Use structured safe errors and never return raw SQL or internal error text.
- Add tests for authentication, session handling, permission scopes, master invariants, deletion, and sensitive-field redaction.
