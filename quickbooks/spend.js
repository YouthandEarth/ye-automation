#!/usr/bin/env node
/*
  Read-only: total supplier bills by supplier for the last N months (default 6).
  Changes nothing in QuickBooks.
  Usage (from the repo folder):  node quickbooks/spend.js [months]
  Writes quickbooks/spend-by-supplier.csv and quickbooks/spend-bills.csv (git-ignored).
*/
const fs = require('fs'), path = require('path');
const { createClient } = require('./lib/qbo');

(async () => {
  const months = parseInt(process.argv[2] || '6', 10);
  const d = new Date(); d.setMonth(d.getMonth() - months);
  const since = d.toISOString().slice(0, 10);
  const qb = createClient();
  const bills = await qb.queryAll(`SELECT * FROM Bill WHERE TxnDate >= '${since}' ORDERBY TxnDate`, 'Bill', 500);

  const gbp = b => Number(b.TotalAmt || 0) * (b.CurrencyRef?.value && b.CurrencyRef.value !== 'GBP' ? Number(b.ExchangeRate || 1) : 1);
  const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const by = {};
  for (const b of bills) {
    const n = b.VendorRef?.name || 'Unknown';
    const m = (by[n] ||= { total: 0, count: 0, months: {} });
    m.total += gbp(b); m.count++;
    const k = b.TxnDate.slice(0, 7); m.months[k] = (m.months[k] || 0) + gbp(b);
  }
  const keys = [...new Set(bills.map(b => b.TxnDate.slice(0, 7)))].sort();
  const rows = Object.entries(by).sort((a, b) => b[1].total - a[1].total);
  fs.writeFileSync(path.join(__dirname, 'spend-by-supplier.csv'),
    ['Supplier,Bills,Total GBP,' + keys.join(',')].concat(rows.map(([n, v]) =>
      [q(n), v.count, v.total.toFixed(2), ...keys.map(k => (v.months[k] || 0).toFixed(2))].join(','))).join('\n'));
  fs.writeFileSync(path.join(__dirname, 'spend-bills.csv'),
    ['Date,Supplier,DocNumber,Currency,Total,GBP,Note'].concat(bills.map(b =>
      [b.TxnDate, q(b.VendorRef?.name), q(b.DocNumber), b.CurrencyRef?.value || 'GBP', b.TotalAmt, gbp(b).toFixed(2), q(b.PrivateNote)].join(','))).join('\n'));
  console.log(`\n✔ ${bills.length} bills since ${since}, ${rows.length} suppliers. Top 15:\n`);
  rows.slice(0, 15).forEach(([n, v]) => console.log(`  £${v.total.toFixed(2).padStart(10)}  ${n}`));
  console.log('\nSaved spend-by-supplier.csv and spend-bills.csv in the quickbooks folder.\n');
})().catch(e => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
