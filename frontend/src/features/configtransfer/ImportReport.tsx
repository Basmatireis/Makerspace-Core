import {
  Accordion,
  AccordionItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import type { ConfigurationImportCounts, ConfigurationImportReport } from '../../api/generated/models';
import { actionLabels, actionOrder, totalCounts } from './helpers';
import { sectionLabel } from './sections';

function CountTags({ counts }: { counts: ConfigurationImportCounts }) {
  return (
    <span className="configuration-transfer__counts">
      {actionOrder
        .filter((action) => counts[action] > 0)
        .map((action) => (
          <Tag key={action} type={actionLabels[action].type} size="sm">
            {actionLabels[action].label}: {counts[action]}
          </Tag>
        ))}
    </span>
  );
}

export function ImportReport({ report }: { report: ConfigurationImportReport }) {
  return (
    <Stack gap={4}>
      <CountTags counts={totalCounts(report)} />
      <Accordion>
        {report.sections.map((section) => {
          const items = [...section.items].sort(
            (a, b) => actionOrder.indexOf(a.action) - actionOrder.indexOf(b.action),
          );
          const label = sectionLabel(section.section);
          return (
            <AccordionItem
              key={section.section}
              open={section.counts.conflict > 0}
              title={
                <span className="configuration-transfer__section-title">
                  <span>{label}</span>
                  <CountTags counts={section.counts} />
                </span>
              }
            >
              {items.length === 0 ? (
                <p>The file has no entries for this section.</p>
              ) : (
                <TableContainer>
                  <Table size="sm" aria-label={`${label} changes`}>
                    <TableHead>
                      <TableRow>
                        <TableHeader>Entry</TableHeader>
                        <TableHeader>Action</TableHeader>
                        <TableHeader>Details</TableHeader>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {items.map((item, index) => (
                        <TableRow key={`${item.name}-${index}`}>
                          <TableCell>{item.name}</TableCell>
                          <TableCell>
                            <Tag type={actionLabels[item.action].type} size="sm">
                              {actionLabels[item.action].label}
                            </Tag>
                          </TableCell>
                          <TableCell>{item.reason ?? ''}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </AccordionItem>
          );
        })}
      </Accordion>
    </Stack>
  );
}
