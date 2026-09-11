# Printable documents

Cooperatives run on paper: a member asks for a statement at the counter, the board
wants a pack for its monthly meeting, a treasurer issues a receipt, and an auditor
asks for a printed loan schedule. Every one of these is generated **server-side as
a real PDF** — no CSV-then-Excel work.

## Endpoints

| Document | Route | Permission |
| --- | --- | --- |
| Member savings statement | `GET /pdf/members/:memberId/statement.pdf?from=&to=` | `reports.view` |
| Loan schedule / statement | `GET /pdf/loans/:loanId/statement.pdf` | `reports.view` |
| Board pack (monthly) | `GET /pdf/board-pack.pdf?period=YYYY-MM` | `reports.view` |
| Counter receipt | `GET /pdf/receipts/:transactionId.pdf` | `reports.view` |

All four return `application/pdf` with a filename in `Content-Disposition`; the
statement, loan schedule and receipt are `inline` (they can be opened in the
browser’s PDF viewer), the board pack is an `attachment`.

## What each document contains

**Member savings statement** — cooperative name, member number and name, account
number, the period, **opening balance**, every transaction with a running balance,
and the **closing balance**. Balances are formatted as `₦1,234,567.89` with the
sign in front of the symbol (`-₦2,500.00`), the way a ledger prints them.

**Loan statement** — principal, outstanding balance, rate, term and interest
method, then the full instalment schedule with **PAID / OVERDUE / PENDING**
derived from what has actually been paid and the due date.

**Board pack** — membership by status, total member savings and account count,
share capital, outstanding loan principal and live-loan count, **arrears ageing**
(1–30, 31–60, 61–90, over 90 days), dividends declared for the period, and the
**trial balance net** with an explicit balanced/not-balanced verdict.

**Receipt** — reference, member, account, date, the transaction and amount, the
balance after it, and a signature line.

## Where they are in the portal

| Page | Button |
| --- | --- |
| **Members** | *Statement (PDF)* on each row |
| **Loans** | *Schedule (PDF)* on each row |
| **Analytics** | *Board pack (PDF)* for the current month |

Because the API needs the session token, a plain link would not work: the portal
fetches the document as a blob (`downloadPdf` in `src/lib/api.ts`) and saves it
through a temporary object URL, so the browser treats it as a normal download.

## Implementation notes

* Rendering uses **pdfkit** — pure JavaScript, no headless browser and no system
  libraries to install on the server.
* Every document is tenant-scoped through the usual RLS setting, so a
  cross-tenant request returns **404**, exactly like any other record.
* Money formatting lives in `money()` in `src/pdf/pdf.service.ts`, with unit tests
  covering zero, negatives, strings and `NaN`.
* The integration test asserts each document is a genuine PDF: `%PDF-` magic
  bytes, at least one page object, a valid EOF marker, a sensible size and a
  filename — plus that a foreign tenant cannot print another cooperative's
  member statement.

## Verifying a document by hand

```bash
# from the server, using the live API and a staff login
TOKEN=$(curl -s -X POST https://api.169.58.196.141.nip.io/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<staff>","password":"<password>"}' | jq -r .tokens.accessToken)

curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.169.58.196.141.nip.io/api/v1/pdf/board-pack.pdf?period=2026-09" \
  -o board-pack.pdf
```
