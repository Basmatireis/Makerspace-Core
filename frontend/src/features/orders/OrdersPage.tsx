import {
  Button,
  DataTable,
  Pagination,
  Search,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Stack,
} from "@carbon/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { createOrder, listOrders } from "../../api/generated/orders/orders";
import { useCurrentUser } from "../auth/auth";
import { hasPermission, PermissionId } from "../auth/permissions";
import { PageShell } from "../../app/PageShell";
import { FullPageLoading, ErrorState } from "../../app/PageState";
import { FinancialError } from "./shared";
import { financeKeys } from "./operations";
import { formatMoney } from "./formatting";

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const client = useQueryClient();
  const page = Number(params.get("page") || 1),
    pageSize = Number(params.get("pageSize") || 25);
  const filters = {
    page,
    pageSize,
    search: params.get("search") || undefined,
    status: params.get("status") || undefined,
  };
  const query = useQuery({
    queryKey: [...financeKeys, "list", filters],
    queryFn: () => listOrders(filters),
  });
  const create = useMutation({
    mutationFn: () => createOrder({ fulfillmentMode: "immediate" }),
    onSuccess: async (o) => {
      await client.invalidateQueries({ queryKey: financeKeys });
      navigate(`/orders/${o.id}`);
    },
  });
  const [search, setSearch] = useState(params.get("search") || "");
  if (query.isPending) return <FullPageLoading label="Loading orders" />;
  if (query.isError)
    return (
      <ErrorState
        message="Orders could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  const rows = query.data.items.map((o) => ({
    id: o.id,
    reference: o.reference,
    customer: o.customerName || o.customerKind,
    status: o.status,
    settlement: o.settlementState,
    total: formatMoney(o.totalAmount),
    outstanding: formatMoney(o.outstandingAmount),
  }));
  const headers = [
    { key: "reference", header: "Order" },
    { key: "customer", header: "Customer" },
    { key: "status", header: "Lifecycle" },
    { key: "settlement", header: "Settlement" },
    { key: "total", header: "Charge" },
    { key: "outstanding", header: "Outstanding" },
  ];
  return (
    <PageShell
      title="Orders"
      description="Internal charge records. Invoices are issued externally by wiRef."
      width="wide"
      actions={
        hasPermission(user, PermissionId.orderswrite) ? (
          <>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              New draft
            </Button>
            {hasPermission(user, PermissionId.ordersfinalize) &&
              hasPermission(user, PermissionId.paymentsrecord) &&
              hasPermission(user, PermissionId.paymentsread) && (
                <Button kind="secondary" as={Link} to="/orders/counter-sale">
                  Counter sale
                </Button>
              )}
          </>
        ) : undefined
      }
    >
      <Stack gap={5}>
        <FinancialError error={create.error} />
        <div className="filter-bar">
          <Search
            labelText="Search order references"
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              const next = new URLSearchParams(params);
              next.set("search", e.currentTarget.value);
              next.set("page", "1");
              setParams(next);
            }}
          />
          <Select
            id="order-status"
            labelText="Lifecycle"
            value={filters.status || ""}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set("status", e.target.value);
              next.set("page", "1");
              setParams(next);
            }}
          >
            <SelectItem value="" text="All orders" />
            {["draft", "finalized", "cancelled", "reversed"].map((v) => (
              <SelectItem key={v} value={v} text={v} />
            ))}
          </Select>
        </div>
        <DataTable rows={rows} headers={headers}>
          {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
            <TableContainer>
              <Table {...getTableProps()} aria-label="Orders">
                <TableHead>
                  <TableRow>
                    {headers.map((h) => (
                      <TableHeader
                        {...getHeaderProps({ header: h })}
                        key={h.key}
                      >
                        {h.header}
                      </TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow {...getRowProps({ row: r })} key={r.id}>
                      {r.cells.map((c) => (
                        <TableCell key={c.id}>
                          {c.info.header === "reference" ? (
                            <Link to={`/orders/${r.id}`}>
                              {String(c.value)}
                            </Link>
                          ) : c.info.header === "status" ? (
                            <Tag>{String(c.value)}</Tag>
                          ) : (
                            String(c.value)
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DataTable>
        <Pagination
          page={page}
          pageSize={pageSize}
          pageSizes={[10, 25, 50, 100]}
          totalItems={query.data.total}
          onChange={({ page, pageSize }) => {
            const next = new URLSearchParams(params);
            next.set("page", String(page));
            next.set("pageSize", String(pageSize));
            setParams(next);
          }}
        />
      </Stack>
    </PageShell>
  );
}
