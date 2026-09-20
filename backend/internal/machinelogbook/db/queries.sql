-- name: CreateMachineType :one
INSERT INTO machine_types (id, name) VALUES (sqlc.arg(id), sqlc.arg(name)) RETURNING *;

-- name: ListMachineTypes :many
SELECT * FROM machine_types ORDER BY active DESC, lower(name), id;

-- name: GetMachineType :one
SELECT * FROM machine_types WHERE id = sqlc.arg(id);

-- name: GetMachineTypeForUpdate :one
SELECT * FROM machine_types WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdateMachineType :one
UPDATE machine_types SET name = sqlc.arg(name), active = sqlc.arg(active),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CreateMachine :one
INSERT INTO machines (id, machine_type_id, name, status, external_identifier, automatic_collection_enabled)
VALUES (sqlc.arg(id), sqlc.arg(machine_type_id), sqlc.arg(name), sqlc.arg(status), sqlc.narg(external_identifier), sqlc.arg(automatic_collection_enabled))
RETURNING *;

-- name: GetMachine :one
SELECT m.*, mt.name AS machine_type_name, mt.active AS machine_type_active, mt.version AS machine_type_version,
       mt.created_at AS machine_type_created_at, mt.updated_at AS machine_type_updated_at,
       count(j.id)::bigint AS job_count,
       COALESCE(sum(EXTRACT(EPOCH FROM (j.ends_at - j.starts_at)))::bigint, 0)::bigint AS runtime_seconds,
       COALESCE(round(100.0 * count(j.id) FILTER (WHERE j.outcome IN ('failed', 'partial_failure')) / NULLIF(count(j.id), 0), 2), 0)::numeric AS failure_rate
FROM machines m
JOIN machine_types mt ON mt.id = m.machine_type_id
LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.review_state = 'confirmed'
WHERE m.id = sqlc.arg(id)
GROUP BY m.id, mt.id;

-- name: GetMachineForUpdate :one
SELECT * FROM machines WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListMachines :many
SELECT m.*, mt.name AS machine_type_name, mt.active AS machine_type_active, mt.version AS machine_type_version,
       mt.created_at AS machine_type_created_at, mt.updated_at AS machine_type_updated_at,
       count(j.id)::bigint AS job_count,
       COALESCE(sum(EXTRACT(EPOCH FROM (j.ends_at - j.starts_at)))::bigint, 0)::bigint AS runtime_seconds,
       COALESCE(round(100.0 * count(j.id) FILTER (WHERE j.outcome IN ('failed', 'partial_failure')) / NULLIF(count(j.id), 0), 2), 0)::numeric AS failure_rate
FROM machines m
JOIN machine_types mt ON mt.id = m.machine_type_id
LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.review_state = 'confirmed'
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(mt.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(status)::text IS NULL OR m.status = sqlc.narg(status)::text)
GROUP BY m.id, mt.id
ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'maintenance' THEN 1 ELSE 2 END, lower(m.name), m.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountMachines :one
SELECT count(*) FROM machines m JOIN machine_types mt ON mt.id = m.machine_type_id
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(mt.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(status)::text IS NULL OR m.status = sqlc.narg(status)::text);

-- name: UpdateMachine :one
UPDATE machines SET machine_type_id = sqlc.arg(machine_type_id), name = sqlc.arg(name), status = sqlc.arg(status),
    external_identifier = sqlc.narg(external_identifier), automatic_collection_enabled = sqlc.arg(automatic_collection_enabled),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: TouchMachineIngest :exec
UPDATE machines SET last_ingested_at = GREATEST(COALESCE(last_ingested_at, sqlc.arg(ingested_at)), sqlc.arg(ingested_at)), updated_at = now()
WHERE id = sqlc.arg(id);

-- name: CreateOrganization :one
INSERT INTO organizations (id, name, kind) VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(kind)) RETURNING *;

-- name: GetOrganization :one
SELECT * FROM organizations WHERE id = sqlc.arg(id);

-- name: GetOrganizationForUpdate :one
SELECT * FROM organizations WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: ListOrganizations :many
SELECT o.*, pg.id AS pricing_group_id, pg.name AS pricing_group_name,
       COALESCE(a.version, 0)::bigint AS pricing_group_assignment_version
FROM organizations o
LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE (sqlc.arg(search)::text = '' OR lower(o.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(active)::boolean IS NULL OR o.active = sqlc.narg(active)::boolean)
ORDER BY o.active DESC, lower(o.name), o.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountOrganizations :one
SELECT count(*) FROM organizations o
WHERE (sqlc.arg(search)::text = '' OR lower(o.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(active)::boolean IS NULL OR o.active = sqlc.narg(active)::boolean);

-- name: UpdateOrganization :one
UPDATE organizations SET name = sqlc.arg(name), kind = sqlc.arg(kind), active = sqlc.arg(active),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: SearchBillingParties :many
SELECT party_kind, party_id, display_name, organization_kind, pricing_group_id, pricing_group_name,
       pricing_group_assignment_version FROM (
    SELECT 'person'::text AS party_kind, p.id AS party_id, btrim(p.first_name || ' ' || p.last_name) AS display_name,
           NULL::text AS organization_kind, pg.id AS pricing_group_id, pg.name AS pricing_group_name,
           COALESCE(a.version, 0)::bigint AS pricing_group_assignment_version,
           lower(p.last_name || ' ' || p.first_name) AS ordering
    FROM people p
    LEFT JOIN person_pricing_group_assignments a ON a.person_id = p.id
    LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
    WHERE sqlc.arg(search)::text = '' OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
    UNION ALL
    SELECT 'organization'::text, o.id, o.name, o.kind, pg.id, pg.name,
           COALESCE(a.version, 0)::bigint, lower(o.name)
    FROM organizations o
    LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
    LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
    WHERE o.active AND (sqlc.arg(search)::text = '' OR lower(o.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
) parties
ORDER BY ordering, party_id
LIMIT sqlc.arg(page_limit);

-- name: SearchMachineJobOperators :many
SELECT p.id AS person_id, btrim(p.first_name || ' ' || p.last_name) AS display_name
FROM people p JOIN accounts a ON a.person_id = p.id AND a.status = 'enabled'
WHERE sqlc.arg(search)::text = '' OR lower(p.first_name || ' ' || p.last_name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
ORDER BY lower(p.last_name), lower(p.first_name), p.id
LIMIT sqlc.arg(page_limit);

-- name: GetBillingPerson :one
SELECT p.id, btrim(p.first_name || ' ' || p.last_name) AS display_name,
       pg.id AS pricing_group_id, pg.name AS pricing_group_name,
       COALESCE(a.version, 0)::bigint AS pricing_group_assignment_version
FROM people p
LEFT JOIN person_pricing_group_assignments a ON a.person_id = p.id
LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE p.id = sqlc.arg(id);

-- name: GetBillingOrganization :one
SELECT o.id, o.name AS display_name, o.kind AS organization_kind,
       pg.id AS pricing_group_id, pg.name AS pricing_group_name,
       COALESCE(a.version, 0)::bigint AS pricing_group_assignment_version
FROM organizations o
LEFT JOIN organization_pricing_group_assignments a ON a.organization_id = o.id
LEFT JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE o.id = sqlc.arg(id);

-- name: GetMachineJobOperator :one
SELECT p.id AS person_id, btrim(p.first_name || ' ' || p.last_name) AS display_name
FROM people p
WHERE p.id = sqlc.arg(id);

-- name: OperatorExists :one
SELECT EXISTS (SELECT 1 FROM accounts WHERE person_id = sqlc.arg(person_id) AND status = 'enabled');

-- name: BillingPersonExists :one
SELECT EXISTS (SELECT 1 FROM people WHERE id = sqlc.arg(id));

-- name: ActiveOrganizationExists :one
SELECT EXISTS (SELECT 1 FROM organizations WHERE id = sqlc.arg(id) AND active);

-- name: CreatePricingGroup :one
INSERT INTO pricing_groups (id, name, description, is_default)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.narg(description), sqlc.arg(is_default)) RETURNING *;

-- name: ClearDefaultPricingGroup :exec
UPDATE pricing_groups SET is_default = false, version = version + 1, updated_at = now()
WHERE is_default AND id <> sqlc.arg(except_id);

-- name: ListPricingGroups :many
SELECT * FROM pricing_groups ORDER BY active DESC, is_default DESC, lower(name), id;

-- name: GetPricingGroup :one
SELECT * FROM pricing_groups WHERE id = sqlc.arg(id);

-- name: GetPricingGroupForUpdate :one
SELECT * FROM pricing_groups WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetDefaultPricingGroup :one
SELECT * FROM pricing_groups WHERE is_default AND active;

-- name: UpdatePricingGroup :one
UPDATE pricing_groups SET name = sqlc.arg(name), description = sqlc.narg(description), active = sqlc.arg(active),
    is_default = sqlc.arg(is_default), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CreatePricingRule :one
INSERT INTO pricing_rules (id, pricing_group_id, kind, machine_type_id, material_category, material_unit, rate)
VALUES (sqlc.arg(id), sqlc.arg(pricing_group_id), sqlc.arg(kind), sqlc.narg(machine_type_id), sqlc.narg(material_category), sqlc.narg(material_unit), sqlc.arg(rate))
RETURNING *;

-- name: ListPricingRulesByGroup :many
SELECT * FROM pricing_rules WHERE pricing_group_id = sqlc.arg(pricing_group_id)
ORDER BY active DESC, kind, material_category NULLS FIRST, machine_type_id NULLS FIRST, id;

-- name: GetPricingRuleForUpdate :one
SELECT * FROM pricing_rules WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: UpdatePricingRule :one
UPDATE pricing_rules SET kind = sqlc.arg(kind), machine_type_id = sqlc.narg(machine_type_id),
    material_category = sqlc.narg(material_category), material_unit = sqlc.narg(material_unit), rate = sqlc.arg(rate),
    active = sqlc.arg(active), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: GetActivePricingRulesByGroup :many
SELECT * FROM pricing_rules WHERE pricing_group_id = sqlc.arg(pricing_group_id) AND active
ORDER BY kind, material_category NULLS FIRST, machine_type_id NULLS FIRST, id;

-- name: GetPersonPricingGroup :one
SELECT pg.* FROM person_pricing_group_assignments a JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE a.person_id = sqlc.arg(person_id) AND pg.active;

-- name: GetOrganizationPricingGroup :one
SELECT pg.* FROM organization_pricing_group_assignments a JOIN pricing_groups pg ON pg.id = a.pricing_group_id
WHERE a.organization_id = sqlc.arg(organization_id) AND pg.active;

-- name: UpsertPersonPricingAssignment :one
INSERT INTO person_pricing_group_assignments (person_id, pricing_group_id, assigned_by_account_id)
VALUES (sqlc.arg(person_id), sqlc.arg(pricing_group_id), sqlc.arg(assigned_by_account_id))
ON CONFLICT (person_id) DO UPDATE SET pricing_group_id = EXCLUDED.pricing_group_id,
    assigned_by_account_id = EXCLUDED.assigned_by_account_id, version = person_pricing_group_assignments.version + 1, updated_at = now()
WHERE person_pricing_group_assignments.version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeletePersonPricingAssignment :one
DELETE FROM person_pricing_group_assignments WHERE person_id = sqlc.arg(person_id) AND version = sqlc.arg(expected_version) RETURNING person_id;

-- name: UpsertOrganizationPricingAssignment :one
INSERT INTO organization_pricing_group_assignments (organization_id, pricing_group_id, assigned_by_account_id)
VALUES (sqlc.arg(organization_id), sqlc.arg(pricing_group_id), sqlc.arg(assigned_by_account_id))
ON CONFLICT (organization_id) DO UPDATE SET pricing_group_id = EXCLUDED.pricing_group_id,
    assigned_by_account_id = EXCLUDED.assigned_by_account_id, version = organization_pricing_group_assignments.version + 1, updated_at = now()
WHERE organization_pricing_group_assignments.version = sqlc.arg(expected_version)
RETURNING *;

-- name: DeleteOrganizationPricingAssignment :one
DELETE FROM organization_pricing_group_assignments WHERE organization_id = sqlc.arg(organization_id) AND version = sqlc.arg(expected_version) RETURNING organization_id;

-- name: CreateMaterial :one
INSERT INTO materials (id, name, category, color, unit, low_stock_threshold)
VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(category), sqlc.narg(color), sqlc.arg(unit), sqlc.narg(low_stock_threshold)) RETURNING *;

-- name: CreateMaterialBalance :one
INSERT INTO material_balances (material_id) VALUES (sqlc.arg(material_id)) RETURNING *;

-- name: GetMaterial :one
SELECT m.*, b.quantity, b.inventory_value, b.average_unit_cost, b.version AS inventory_version, b.updated_at AS balance_updated_at,
       COALESCE(-sum(t.quantity_delta) FILTER (WHERE t.quantity_delta < 0 AND t.occurred_at >= now() - interval '30 days'), 0)::numeric AS recent_consumption
FROM materials m JOIN material_balances b ON b.material_id = m.id
LEFT JOIN inventory_transactions t ON t.material_id = m.id
WHERE m.id = sqlc.arg(id)
GROUP BY m.id, b.material_id;

-- name: GetMaterialForUpdate :one
SELECT m.*, b.quantity, b.inventory_value, b.average_unit_cost, b.version AS inventory_version, b.updated_at AS balance_updated_at
FROM materials m JOIN material_balances b ON b.material_id = m.id
WHERE m.id = sqlc.arg(id)
FOR UPDATE OF b, m;

-- name: ListMaterials :many
SELECT m.*, b.quantity, b.inventory_value, b.average_unit_cost, b.version AS inventory_version, b.updated_at AS balance_updated_at,
       COALESCE(-sum(t.quantity_delta) FILTER (WHERE t.quantity_delta < 0 AND t.occurred_at >= now() - interval '30 days'), 0)::numeric AS recent_consumption
FROM materials m JOIN material_balances b ON b.material_id = m.id
LEFT JOIN inventory_transactions t ON t.material_id = m.id
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(m.category) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.arg(category)::text = '' OR m.category = lower(sqlc.arg(category)::text))
  AND (sqlc.arg(stock_state)::text = '' OR
       (sqlc.arg(stock_state)::text = 'empty' AND b.quantity = 0) OR
       (sqlc.arg(stock_state)::text = 'low_stock' AND b.quantity > 0 AND m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold) OR
       (sqlc.arg(stock_state)::text = 'in_stock' AND b.quantity > 0 AND (m.low_stock_threshold IS NULL OR b.quantity > m.low_stock_threshold)))
GROUP BY m.id, b.material_id
ORDER BY m.active DESC, lower(m.name), m.id
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountMaterials :one
SELECT count(*) FROM materials m JOIN material_balances b ON b.material_id = m.id
WHERE (sqlc.arg(search)::text = '' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(m.category) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.arg(category)::text = '' OR m.category = lower(sqlc.arg(category)::text))
  AND (sqlc.arg(stock_state)::text = '' OR
       (sqlc.arg(stock_state)::text = 'empty' AND b.quantity = 0) OR
       (sqlc.arg(stock_state)::text = 'low_stock' AND b.quantity > 0 AND m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold) OR
       (sqlc.arg(stock_state)::text = 'in_stock' AND b.quantity > 0 AND (m.low_stock_threshold IS NULL OR b.quantity > m.low_stock_threshold)));

-- name: TotalInventoryValue :one
SELECT COALESCE(sum(inventory_value), 0)::numeric FROM material_balances;

-- name: UpdateMaterial :one
UPDATE materials SET name = sqlc.arg(name), category = sqlc.arg(category), color = sqlc.narg(color), unit = sqlc.arg(unit),
    active = sqlc.arg(active), low_stock_threshold = sqlc.narg(low_stock_threshold), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: UpdateMaterialBalance :one
UPDATE material_balances SET quantity = sqlc.arg(quantity), inventory_value = sqlc.arg(inventory_value),
    average_unit_cost = sqlc.arg(average_unit_cost), version = version + 1, updated_at = now()
WHERE material_id = sqlc.arg(material_id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: InsertInventoryTransaction :one
INSERT INTO inventory_transactions (id, material_id, kind, quantity_delta, unit_acquisition_cost, inventory_value_delta,
    total_purchase_price, occurred_at, supplier, note, adjustment_reason, machine_job_usage_id, actor_account_id)
VALUES (sqlc.arg(id), sqlc.arg(material_id), sqlc.arg(kind), sqlc.arg(quantity_delta), sqlc.arg(unit_acquisition_cost), sqlc.arg(inventory_value_delta),
    sqlc.narg(total_purchase_price), sqlc.arg(occurred_at), sqlc.narg(supplier), sqlc.narg(note), sqlc.narg(adjustment_reason), sqlc.narg(machine_job_usage_id), sqlc.narg(actor_account_id))
RETURNING *;

-- name: ListInventoryTransactions :many
SELECT t.*, j.id AS machine_job_id, j.display_id AS machine_job_display_id
FROM inventory_transactions t
LEFT JOIN machine_job_material_usages u ON u.id = t.machine_job_usage_id
LEFT JOIN machine_jobs j ON j.id = u.machine_job_id
WHERE t.material_id = sqlc.arg(material_id)
ORDER BY t.occurred_at DESC, t.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountInventoryTransactions :one
SELECT count(*) FROM inventory_transactions WHERE material_id = sqlc.arg(material_id);

-- name: NextMachineJobSequence :one
SELECT nextval('machine_job_display_sequence')::bigint;

-- name: CreateMachineJob :one
INSERT INTO machine_jobs (id, display_id, machine_id, starts_at, ends_at, source, external_id, external_metadata,
    review_state, customer_person_id, customer_organization_id, operator_person_id, outcome, notes)
VALUES (sqlc.arg(id), sqlc.arg(display_id), sqlc.arg(machine_id), sqlc.arg(starts_at), sqlc.arg(ends_at), sqlc.arg(source),
    sqlc.narg(external_id), sqlc.arg(external_metadata), sqlc.arg(review_state), sqlc.narg(customer_person_id),
    sqlc.narg(customer_organization_id), sqlc.narg(operator_person_id), sqlc.arg(outcome), sqlc.narg(notes))
RETURNING *;

-- name: GetMachineJobBase :one
SELECT * FROM machine_jobs WHERE id = sqlc.arg(id);

-- name: GetMachineJobForUpdate :one
SELECT * FROM machine_jobs WHERE id = sqlc.arg(id) FOR UPDATE;

-- name: GetAutomaticMachineJob :one
SELECT * FROM machine_jobs WHERE machine_id = sqlc.arg(machine_id) AND source = 'automatic' AND external_id = sqlc.arg(external_id);

-- name: InsertMachineJobUsage :one
INSERT INTO machine_job_material_usages (id, machine_job_id, material_id, quantity)
VALUES (sqlc.arg(id), sqlc.arg(machine_job_id), sqlc.arg(material_id), sqlc.arg(quantity)) RETURNING *;

-- name: ListMachineJobUsages :many
SELECT u.*, m.name AS material_name, m.category, m.unit
FROM machine_job_material_usages u JOIN materials m ON m.id = u.material_id
WHERE u.machine_job_id = sqlc.arg(machine_job_id) AND u.active
ORDER BY lower(m.name), u.id;

-- name: ListAllMachineJobUsagesForUpdate :many
SELECT * FROM machine_job_material_usages WHERE machine_job_id = sqlc.arg(machine_job_id) AND active ORDER BY material_id FOR UPDATE;

-- name: DeactivateMachineJobUsages :exec
UPDATE machine_job_material_usages SET active = false, updated_at = now()
WHERE machine_job_id = sqlc.arg(machine_job_id) AND active;

-- name: ListMachineJobIDs :many
SELECT DISTINCT j.id, j.starts_at FROM machine_jobs j
JOIN machines m ON m.id = j.machine_id
LEFT JOIN people cp ON cp.id = j.customer_person_id
LEFT JOIN organizations co ON co.id = j.customer_organization_id
LEFT JOIN people op ON op.id = j.operator_person_id
LEFT JOIN machine_job_material_usages u ON u.machine_job_id = j.id AND u.active
LEFT JOIN materials mat ON mat.id = u.material_id
WHERE (sqlc.arg(search)::text = '' OR lower(j.display_id) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(cp.first_name || ' ' || cp.last_name, co.name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(op.first_name || ' ' || op.last_name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(mat.name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(machine_id)::uuid IS NULL OR j.machine_id = sqlc.narg(machine_id)::uuid)
  AND (sqlc.narg(customer_id)::uuid IS NULL OR j.customer_person_id = sqlc.narg(customer_id)::uuid OR j.customer_organization_id = sqlc.narg(customer_id)::uuid)
  AND (sqlc.narg(operator_id)::uuid IS NULL OR j.operator_person_id = sqlc.narg(operator_id)::uuid)
  AND (sqlc.narg(material_id)::uuid IS NULL OR u.material_id = sqlc.narg(material_id)::uuid)
  AND (sqlc.narg(outcome)::text IS NULL OR j.outcome = sqlc.narg(outcome)::text)
  AND (sqlc.narg(billing_status)::text IS NULL OR j.billing_status = sqlc.narg(billing_status)::text)
  AND (sqlc.narg(source)::text IS NULL OR j.source = sqlc.narg(source)::text)
  AND (sqlc.narg(review_state)::text IS NULL OR j.review_state = sqlc.narg(review_state)::text)
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR j.starts_at >= sqlc.narg(from_time)::timestamptz)
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR j.starts_at < sqlc.narg(to_time)::timestamptz)
ORDER BY j.starts_at DESC, j.id DESC
LIMIT sqlc.arg(page_limit) OFFSET sqlc.arg(page_offset);

-- name: CountMachineJobs :one
SELECT count(DISTINCT j.id) FROM machine_jobs j
JOIN machines m ON m.id = j.machine_id
LEFT JOIN people cp ON cp.id = j.customer_person_id
LEFT JOIN organizations co ON co.id = j.customer_organization_id
LEFT JOIN people op ON op.id = j.operator_person_id
LEFT JOIN machine_job_material_usages u ON u.machine_job_id = j.id AND u.active
LEFT JOIN materials mat ON mat.id = u.material_id
WHERE (sqlc.arg(search)::text = '' OR lower(j.display_id) LIKE '%' || lower(sqlc.arg(search)::text) || '%' OR lower(m.name) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(cp.first_name || ' ' || cp.last_name, co.name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(op.first_name || ' ' || op.last_name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%'
       OR lower(COALESCE(mat.name, '')) LIKE '%' || lower(sqlc.arg(search)::text) || '%')
  AND (sqlc.narg(machine_id)::uuid IS NULL OR j.machine_id = sqlc.narg(machine_id)::uuid)
  AND (sqlc.narg(customer_id)::uuid IS NULL OR j.customer_person_id = sqlc.narg(customer_id)::uuid OR j.customer_organization_id = sqlc.narg(customer_id)::uuid)
  AND (sqlc.narg(operator_id)::uuid IS NULL OR j.operator_person_id = sqlc.narg(operator_id)::uuid)
  AND (sqlc.narg(material_id)::uuid IS NULL OR u.material_id = sqlc.narg(material_id)::uuid)
  AND (sqlc.narg(outcome)::text IS NULL OR j.outcome = sqlc.narg(outcome)::text)
  AND (sqlc.narg(billing_status)::text IS NULL OR j.billing_status = sqlc.narg(billing_status)::text)
  AND (sqlc.narg(source)::text IS NULL OR j.source = sqlc.narg(source)::text)
  AND (sqlc.narg(review_state)::text IS NULL OR j.review_state = sqlc.narg(review_state)::text)
  AND (sqlc.narg(from_time)::timestamptz IS NULL OR j.starts_at >= sqlc.narg(from_time)::timestamptz)
  AND (sqlc.narg(to_time)::timestamptz IS NULL OR j.starts_at < sqlc.narg(to_time)::timestamptz);

-- name: ListReviewQueueIDs :many
SELECT id FROM machine_jobs WHERE review_state = 'needs_review' ORDER BY starts_at, id;

-- name: ConfirmMachineJob :one
UPDATE machine_jobs SET customer_person_id = sqlc.narg(customer_person_id), customer_organization_id = sqlc.narg(customer_organization_id),
    operator_person_id = sqlc.arg(operator_person_id), outcome = sqlc.arg(outcome), notes = sqlc.narg(notes), review_state = 'confirmed',
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND review_state = 'needs_review'
RETURNING *;

-- name: UpdateMachineJobFacts :one
UPDATE machine_jobs SET machine_id = sqlc.arg(machine_id), starts_at = sqlc.arg(starts_at), ends_at = sqlc.arg(ends_at),
    customer_person_id = sqlc.narg(customer_person_id), customer_organization_id = sqlc.narg(customer_organization_id),
    operator_person_id = sqlc.arg(operator_person_id), outcome = sqlc.arg(outcome), notes = sqlc.narg(notes),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND review_state = 'confirmed' AND billing_status <> 'billed'
RETURNING *;

-- name: BumpMachineJobVersion :one
UPDATE machine_jobs SET version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND billing_status <> 'billed'
RETURNING *;

-- name: CreatePricingSnapshot :one
INSERT INTO machine_job_pricing_snapshots (id, machine_job_id, revision, pricing_group_id, pricing_group_name, reason,
    complete, calculated_amount, captured_by_account_id)
VALUES (sqlc.arg(id), sqlc.arg(machine_job_id), sqlc.arg(revision), sqlc.narg(pricing_group_id), sqlc.arg(pricing_group_name),
    sqlc.arg(reason), sqlc.arg(complete), sqlc.narg(calculated_amount), sqlc.narg(captured_by_account_id)) RETURNING *;

-- name: InsertPricingSnapshotRule :one
INSERT INTO machine_job_pricing_snapshot_rules (id, snapshot_id, source_rule_id, kind, label, selector, unit, rate, missing)
VALUES (sqlc.arg(id), sqlc.arg(snapshot_id), sqlc.narg(source_rule_id), sqlc.arg(kind), sqlc.arg(label), sqlc.arg(selector),
    sqlc.arg(unit), sqlc.narg(rate), sqlc.arg(missing)) RETURNING *;

-- name: GetPricingSnapshot :one
SELECT * FROM machine_job_pricing_snapshots WHERE id = sqlc.arg(id);

-- name: ListPricingSnapshotRules :many
SELECT * FROM machine_job_pricing_snapshot_rules WHERE snapshot_id = sqlc.arg(snapshot_id) ORDER BY kind, label, id;

-- name: NextPricingSnapshotRevision :one
SELECT COALESCE(max(revision), 0)::integer + 1 FROM machine_job_pricing_snapshots WHERE machine_job_id = sqlc.arg(machine_job_id);

-- name: ActivatePricingSnapshot :one
UPDATE machine_jobs SET active_pricing_snapshot_id = sqlc.arg(snapshot_id), pricing_status = sqlc.arg(pricing_status),
    calculated_price = sqlc.narg(calculated_price), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: RecalculateMachineJobPrice :one
UPDATE machine_jobs SET pricing_status = sqlc.arg(pricing_status), calculated_price = sqlc.narg(calculated_price),
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND billing_status <> 'billed'
RETURNING *;

-- name: SetMachineJobPriceOverride :one
UPDATE machine_jobs SET final_price = sqlc.arg(final_price), price_override_reason = sqlc.arg(reason),
    price_overridden_by_account_id = sqlc.arg(actor_account_id), price_overridden_at = now(), version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND billing_status <> 'billed'
RETURNING *;

-- name: ClearMachineJobPriceOverride :one
UPDATE machine_jobs SET final_price = NULL, price_override_reason = NULL, price_overridden_by_account_id = NULL,
    price_overridden_at = NULL, version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version) AND billing_status <> 'billed'
RETURNING *;

-- name: UpdateMachineJobBilling :one
UPDATE machine_jobs SET billing_status = sqlc.arg(billing_status), billing_reference = sqlc.narg(billing_reference),
    final_price = CASE WHEN sqlc.arg(billing_status)::text = 'waived' THEN 0 ELSE final_price END,
    price_override_reason = CASE WHEN sqlc.arg(billing_status)::text = 'waived' THEN sqlc.narg(waiver_reason) ELSE price_override_reason END,
    price_overridden_by_account_id = CASE WHEN sqlc.arg(billing_status)::text = 'waived' THEN sqlc.arg(actor_account_id) ELSE price_overridden_by_account_id END,
    price_overridden_at = CASE WHEN sqlc.arg(billing_status)::text = 'waived' THEN now() ELSE price_overridden_at END,
    version = version + 1, updated_at = now()
WHERE id = sqlc.arg(id) AND version = sqlc.arg(expected_version)
RETURNING *;

-- name: CountOverviewJobs :one
SELECT count(*) FILTER (WHERE starts_at >= date_trunc('day', now()))::bigint AS jobs_today,
       count(*) FILTER (WHERE starts_at >= date_trunc('week', now()))::bigint AS jobs_this_week,
       count(*) FILTER (WHERE billing_status = 'unbilled' AND review_state = 'confirmed')::bigint AS unbilled_jobs,
       COALESCE(sum(COALESCE(final_price, calculated_price)) FILTER (WHERE billing_status = 'unbilled' AND review_state = 'confirmed'), 0)::numeric AS unbilled_amount,
       count(*) FILTER (WHERE review_state = 'needs_review')::bigint AS needs_review,
       count(*) FILTER (WHERE starts_at >= date_trunc('week', now()) AND outcome IN ('failed', 'partial_failure'))::bigint AS failed_or_partial_this_week
FROM machine_jobs;

-- name: ListRecentJobIDs :many
SELECT id FROM machine_jobs ORDER BY starts_at DESC, id DESC LIMIT sqlc.arg(page_limit);

-- name: ListLowStockMaterialIDs :many
SELECT m.id FROM materials m JOIN material_balances b ON b.material_id = m.id
WHERE m.active AND (b.quantity = 0 OR (m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold))
ORDER BY b.quantity = 0 DESC, b.quantity, lower(m.name), m.id LIMIT sqlc.arg(page_limit);

-- name: CountLowStockMaterials :one
SELECT count(*) FROM materials m JOIN material_balances b ON b.material_id = m.id
WHERE m.active AND (b.quantity = 0 OR (m.low_stock_threshold IS NOT NULL AND b.quantity <= m.low_stock_threshold));

-- name: OverviewDailyActivity :many
SELECT day::date AS activity_date, count(j.id)::bigint AS job_count
FROM generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') day
LEFT JOIN machine_jobs j ON j.starts_at >= day AND j.starts_at < day + interval '1 day'
GROUP BY day ORDER BY day;

-- name: StatisticMaterialUsage :many
SELECT m.category AS label, COALESCE(-sum(t.quantity_delta), 0)::numeric AS value
FROM inventory_transactions t JOIN materials m ON m.id = t.material_id
WHERE t.kind IN ('machine_job_consumption', 'manual_consumption') AND t.occurred_at >= sqlc.arg(from_time) AND t.occurred_at < sqlc.arg(to_time)
GROUP BY m.category ORDER BY m.category;

-- name: StatisticMachineRuntime :many
SELECT m.id::text AS key, m.name AS label, COALESCE(sum(EXTRACT(EPOCH FROM (j.ends_at - j.starts_at))) / 3600.0, 0)::numeric AS value
FROM machines m LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.review_state = 'confirmed' AND j.starts_at >= sqlc.arg(from_time) AND j.starts_at < sqlc.arg(to_time)
GROUP BY m.id, m.name ORDER BY value DESC, lower(m.name);

-- name: StatisticMachineJobCounts :many
SELECT m.id::text AS key, m.name AS label, count(j.id)::numeric AS value
FROM machines m LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.review_state = 'confirmed' AND j.starts_at >= sqlc.arg(from_time) AND j.starts_at < sqlc.arg(to_time)
GROUP BY m.id, m.name ORDER BY value DESC, lower(m.name);

-- name: StatisticAcquisitionCost :many
SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS label, COALESCE(-sum(inventory_value_delta) FILTER (WHERE inventory_value_delta < 0), 0)::numeric AS value
FROM inventory_transactions WHERE occurred_at >= sqlc.arg(from_time) AND occurred_at < sqlc.arg(to_time)
GROUP BY date_trunc('month', occurred_at) ORDER BY date_trunc('month', occurred_at);

-- name: StatisticCustomerCharges :many
SELECT to_char(date_trunc('month', starts_at), 'YYYY-MM') AS label, COALESCE(sum(COALESCE(final_price, calculated_price)), 0)::numeric AS value
FROM machine_jobs WHERE review_state = 'confirmed' AND starts_at >= sqlc.arg(from_time) AND starts_at < sqlc.arg(to_time)
GROUP BY date_trunc('month', starts_at) ORDER BY date_trunc('month', starts_at);

-- name: StatisticAdjustmentLoss :many
SELECT to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS label, COALESCE(-sum(quantity_delta) FILTER (WHERE quantity_delta < 0), 0)::numeric AS value
FROM inventory_transactions WHERE kind IN ('adjustment', 'disposal') AND occurred_at >= sqlc.arg(from_time) AND occurred_at < sqlc.arg(to_time)
GROUP BY date_trunc('month', occurred_at) ORDER BY date_trunc('month', occurred_at);

-- name: StatisticMachineFailureRates :many
SELECT m.id::text AS key, m.name AS label,
       COALESCE(round(100.0 * count(j.id) FILTER (WHERE j.outcome IN ('failed', 'partial_failure')) / NULLIF(count(j.id), 0), 2), 0)::numeric AS value
FROM machines m LEFT JOIN machine_jobs j ON j.machine_id = m.id AND j.review_state = 'confirmed' AND j.starts_at >= sqlc.arg(from_time) AND j.starts_at < sqlc.arg(to_time)
GROUP BY m.id, m.name ORDER BY value DESC, lower(m.name);
