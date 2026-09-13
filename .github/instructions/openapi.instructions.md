---
applyTo: "api/**/*.yaml"
---

# OpenAPI instructions

- `api/openapi.yaml` is the canonical HTTP contract.
- Use stable lower-camel-case `operationId` values and shared component schemas/responses.
- Model every expected success and error response. Keep the machine-readable error envelope stable.
- Mark password and token inputs `writeOnly`; never place real credentials or PII in examples.
- Preserve the difference between omitted and explicit `null` for PATCH fields.
- Generated Go and TypeScript outputs must be regenerated in the same change and never edited by hand.
- Do not generate business logic, services, repositories, or database code from OpenAPI.
