Core records what was paid. It does not handle the money itself: the cash goes into the cash box, and the card terminal confirms card payments. You write down what happened.

## Taking a payment

Open the order and choose **Finalize and take payment** on a draft, or **Record payment** on a finalized order with an open amount. A window asks how the customer pays:

- **Cash.** Enter the amount. If you type what the customer handed over, Core shows the change.
- **Card.** Enter the terminal or provider and the transaction reference from the terminal slip. Each reference can be used once.
- **Split.** Use this when one customer pays with cash and card together. Add as many payments as you need; **Fill remaining** completes the last one.
- **Invoice.** No payment now; see _Invoices through wiRef_.

The window shows how much is covered. A partial payment is fine: the rest stays outstanding and you can record it later. The time defaults to now; use **Change time** if the payment happened earlier.

You need permission to record payments and to read them. Without it the order page shows the total but offers no payment button.

## Receipts

Once an order has received money, **Print receipt** appears on the order page. It opens a receipt you can print or save for the customer. If an order has several payments, you can print the receipt of a single payment from the payment's page.

## The Payments page

**Payments** lists every payment. The **Cashbook** tab shows each payment with its method, the order and the customer, and the takings per method for the period you pick. The **Cash register** tab appears if you may see cash movements; counting and moving cash is covered elsewhere.

## Refund or correct

A payment is never edited or deleted. If money went back to the customer, or an entry was a mistake, open the payment and choose **Refund or correct**. You pick what happened:

- **Refund:** you gave the money back.
- **Recorded by mistake:** the entry should never have been made.
- **Correction from wiRef:** an accounting correction for an invoice payment.

Give a short reason without personal data. Core adds a new line that undoes the payment. Both lines stay on the record, and the order's open amount grows by the refunded sum. This needs the permission to reverse payments.

The demo _Refund or correct a payment_ walks through it with sample data.
