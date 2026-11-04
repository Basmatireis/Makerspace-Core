import { hasPermission } from '../../../auth/permissions';
import type { HelpArticle } from '../index';

export const salesArticles: HelpArticle[] = [
  {
    id: 'sales-orders',
    area: 'sales',
    title: 'Orders',
    summary: 'From a finished job to a paid order: drafts, finalizing, corrections and the tabs of the list.',
    requires: (user) => hasPermission(user, 'orders.read'),
    relatedGuides: ['sales-tour', 'sales-order-payment'],
    load: () => import('./orders.md?raw').then((module) => module.default),
  },
  {
    id: 'sales-payments',
    area: 'sales',
    title: 'Payments and receipts',
    summary: 'Take cash and card payments, print a receipt and refund or correct a payment.',
    requires: (user) => hasPermission(user, 'payments.read'),
    relatedGuides: ['sales-order-payment', 'sales-reverse-payment'],
    load: () => import('./payments-and-receipts.md?raw').then((module) => module.default),
  },
  {
    id: 'sales-invoices',
    area: 'sales',
    title: 'Invoices through wiRef',
    summary: 'How to ask for an invoice, who approves it and what it means for payments.',
    requires: (user) => hasPermission(user, 'orders.read'),
    relatedGuides: ['sales-tour'],
    load: () => import('./invoices-wiref.md?raw').then((module) => module.default),
  },
  {
    id: 'sales-pricing',
    area: 'sales',
    title: 'Pricing groups and price lookup',
    summary: 'Why customers pay different prices and how to check what something costs.',
    requires: (user) => hasPermission(user, 'pricing.read'),
    relatedGuides: ['sales-tour'],
    load: () => import('./pricing.md?raw').then((module) => module.default),
  },
];
