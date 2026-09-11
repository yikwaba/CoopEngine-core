# Board pack — PDF and Excel

The month-end pack a committee sees exists in two forms, from the same data:

| Form | Endpoint | Use |
|---|---|---|
| **PDF** | `GET /reports/board-pack.pdf?period=YYYY-MM` | printing, circulating, signing |
| **Excel** | `GET /reports/board-pack.xlsx?period=YYYY-MM` | treasurers who pivot, chart, or add their own notes |

The workbook has one sheet per view — **Summary, Membership, Savings, Shares, Loans,
Arrears, Dividends, Trial Balance** — with live numeric cells (not a picture of
numbers), a bold header row, and a trial-balance total that must foot.

Both are gated on `reports.view` and scoped to the caller's cooperative.

```bash
# as a signed-in staff user
curl -H "Authorization: Bearer <token>" -o board-pack.xlsx \
  "https://<api-host>/api/v1/reports/board-pack.xlsx?period=2026-09"
```
