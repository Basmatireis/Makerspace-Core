# Copilot instructions

Follow `AGENTS.md` for repository-wide rules. Preserve the modular-monolith architecture, OpenAPI-first contracts, pgx/sqlc persistence, permission-based authorization, privacy constraints, and Carbon-first frontend implementation.

Generated files are outputs: change their source specification or query and regenerate them. Do not hand-edit generated Go, TypeScript, or sqlc code.

Keep changes feature-focused and test authorization-sensitive paths. Do not introduce future modules, infrastructure, or abstractions without an immediate requirement.
