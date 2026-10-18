#!/usr/bin/env node
/*
  Youth & Earth – QuickBooks Online helper (Terminal)

  Usage (from the repo folder):
    node quickbooks/qb.js test                 Check the connection (shows company name + token store)
    node quickbooks/qb.js unpaid               List unpaid supplier bills
    node quickbooks/qb.js paid [days]          Supplier payments made in the last N days (default 30)
    node quickbooks/qb.js vendor "Name"        Bills and payment status for one supplier
    node quickbooks/qb.js query "SELECT ..."   Run a read-only QuickBooks query (prints JSON)
    node quickbooks/qb.js invoices             Unpaid customer invoices (and whether emailed)
    node quickbooks/qb.js overdue              Overdue customer invoices
    node quickbooks/qb.js invoice WS1423       Details for one invoice
    node quickbooks/qb.js pdf <Id> <out.pdf>   Download an invoice PDF (by QuickBooks Id)
    node quickbooks/qb.js send WS1423 [email]  Email an invoice via QuickBooks (asks you to type YES)
    node quickbooks/qb.js export               Save unpaid supplier bills to quickbooks/payables.json
    node quickbooks/qb.js set-token            Paste a new refresh token (after reconnecting in the OAuth Playground)

  Settings come from environment variables, then the macOS Keychain
  (service "youthandearth-quickbooks"). See quickbooks/README.md.
  Errors (with Intuit's intuit_tid for support) are written to quickbooks/qb-errors.log.
*/

const fs = require('fs');
const path = require('path');
const { createClient, QboError, esc, unpaidBills, unpaidInvoices, supplierPayments } = require('./lib/qbo');
const { loadConfig, ConfigError } = require('./lib/credentials');

const DIR = __dirname;
const LOG_FILE = path.join(DIR, 'qb-errors.log');

function logError(context, details) {
  const entry = `[${new Date().toISOString()}] ${context}\n${JSON.stringify(details, null, 2)}\n\n`;
  try { fs.appendFileSync(LOG_FILE, entry, { mode: 0o600 }); } catch (_) { /* ignore */ }
}

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const money = (n, cur) => `${cur ? cur + ' ' : ''}${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
function table(rows, cols) {
  if (!rows.length) { console.log('  (none)'); return; }
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.get(r) ?? '').length)));
  const line = vals => '  ' + vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(line(cols.map(c => c.label)));
  console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
  rows.forEach(r => console.log(line(cols.map(c => c.get(r)))));
}

function ask(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, a => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const sentInfo = i => {
  if (i.emailStatus === 'EmailSent') return `Sent ${i.lastSent}`.trim();
  if (i.emailStatus === 'NeedToSend') return 'Marked to send';
  return 'Not sent';
};

async function main() {
  const [cmd = 'test', ...args] = process.argv.slice(2);

  if (cmd === 'set-token') {
    if (!process.stdin.isTTY) fail('Run this yourself in Terminal so you can paste the token.');
    const cfg = loadConfig();
    const tok = await ask(`Paste the new Refresh Token (saved to the "${cfg.store.name}" store): `, { hidden: true });
    if (tok.length < 20) fail('That does not look like a refresh token. Nothing was saved.');
    await cfg.store.set({ refreshToken: tok, accessToken: null, accessExpiresAt: null });
    console.log(`\n✔ Saved. Now run:  node quickbooks/qb.js test\n`);
    return;
  }

  const qb = createClient({ log: logError });

  if (cmd === 'test') {
    const c = await qb.companyInfo();
    console.log(`\n✔ Connected to QuickBooks: ${c.CompanyName} (${c.Country || 'country n/a'}) – token store: ${qb.config.store.name}\n`);
    return;
  }

  if (cmd === 'unpaid') {
    const bills = await unpaidBills(qb);
    console.log(`\nUnpaid supplier bills: ${bills.length}\n`);
    table(bills, [
      { label: 'Supplier', get: b => b.supplier },
      { label: 'Bill no.', get: b => b.billNo },
      { label: 'Bill date', get: b => b.billDate },
      { label: 'Due', get: b => b.dueDate },
      { label: 'Total', get: b => money(b.total, b.currency) },
      { label: 'Still owed', get: b => money(b.owed, b.currency) },
    ]);
    console.log('');
    return;
  }

  if (cmd === 'paid') {
    const { since, payments } = await supplierPayments(qb, parseInt(args[0] || '30', 10));
    console.log(`\nSupplier payments since ${since}: ${payments.length}\n`);
    table(payments, [
      { label: 'Date', get: p => p.date },
      { label: 'Supplier', get: p => p.supplier },
      { label: 'Amount', get: p => money(p.amount, p.currency) },
      { label: 'Paid by', get: p => p.payType },
      { label: 'Ref', get: p => p.ref },
    ]);
    console.log('');
    return;
  }

  if (cmd === 'vendor') {
    const name = args.join(' ').trim();
    if (!name) fail('Give a supplier name, e.g.  node quickbooks/qb.js vendor "Anthropic"');
    const vendors = await qb.queryAll(`SELECT * FROM Vendor WHERE DisplayName LIKE '%${esc(name)}%'`, 'Vendor');
    if (!vendors.length) fail(`No supplier found matching "${name}".`);
    for (const v of vendors) {
      const bills = await qb.queryAll(`SELECT * FROM Bill WHERE VendorRef = '${v.Id}' ORDERBY TxnDate DESC`, 'Bill');
      console.log(`\n${v.DisplayName}: ${bills.length} bill(s), balance owed ${money(v.Balance, v.CurrencyRef?.value)}\n`);
      table(bills, [
        { label: 'Bill date', get: b => b.TxnDate },
        { label: 'Bill no.', get: b => b.DocNumber || '' },
        { label: 'Total', get: b => money(b.TotalAmt, b.CurrencyRef?.value) },
        { label: 'Still owed', get: b => money(b.Balance, b.CurrencyRef?.value) },
        { label: 'Status', get: b => (Number(b.Balance) === 0 ? 'PAID' : Number(b.Balance) < Number(b.TotalAmt) ? 'PART-PAID' : 'UNPAID') },
      ]);
    }
    console.log('');
    return;
  }

  if (cmd === 'query') {
    const sql = args.join(' ').trim();
    if (!/^select\s/i.test(sql)) fail('Only SELECT queries are allowed.');
    console.log(JSON.stringify(await qb.query(sql), null, 2));
    return;
  }

  if (cmd === 'export') {
    const rows = await unpaidBills(qb);
    const out = { generatedAt: new Date().toISOString(), source: 'QuickBooks Online – unpaid supplier bills (Bill.Balance > 0)', bills: rows };
    const file = path.join(DIR, 'payables.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
    const total = rows.reduce((s, r) => s + r.owedGBP, 0);
    console.log(`\n✔ Exported ${rows.length} unpaid bills (≈ £${total.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) to ${file}\n`);
    return;
  }

  if (cmd === 'pdf') {
    const [invoiceId, outFile] = args;
    if (!invoiceId || !outFile) fail('Usage: node quickbooks/qb.js pdf <InvoiceId> <output.pdf>');
    const buf = await qb.request(`/invoice/${encodeURIComponent(invoiceId)}/pdf`, { accept: 'application/pdf', label: `invoice ${invoiceId} pdf` });
    fs.writeFileSync(outFile, buf, { mode: 0o600 });
    console.log(`Saved ${outFile}`);
    return;
  }

  async function findInvoice(docNumber) {
    const list = (await qb.query(`SELECT * FROM Invoice WHERE DocNumber = '${esc(docNumber)}'`)).Invoice || [];
    if (!list.length) fail(`No invoice found with number "${docNumber}".`);
    if (list.length > 1) fail(`More than one invoice has number "${docNumber}" (ids: ${list.map(i => i.Id).join(', ')}).`);
    return list[0];
  }
  const rawSentInfo = i => sentInfo({
    emailStatus: i.EmailStatus,
    lastSent: i.DeliveryInfo?.DeliveryTime ? i.DeliveryInfo.DeliveryTime.slice(0, 10) : '',
  });

  if (cmd === 'overdue' || cmd === 'invoices') {
    const invs = await unpaidInvoices(qb, { overdueOnly: cmd === 'overdue' });
    console.log(`\n${cmd === 'overdue' ? 'Overdue' : 'Unpaid'} customer invoices: ${invs.length}\n`);
    table(invs, [
      { label: 'Invoice', get: i => i.invoiceNo },
      { label: 'Customer', get: i => i.customer },
      { label: 'Due', get: i => i.dueDate },
      { label: 'Owed', get: i => money(i.owed, i.currency) },
      { label: 'Email to', get: i => i.emailTo || '(none)' },
      { label: 'Emailed', get: sentInfo },
    ]);
    console.log('');
    return;
  }

  if (cmd === 'invoice') {
    const num = args[0];
    if (!num) fail('Usage: node quickbooks/qb.js invoice <InvoiceNumber>   e.g. node quickbooks/qb.js invoice WS1423');
    const i = await findInvoice(num);
    console.log(`\nInvoice ${i.DocNumber}  (id ${i.Id})`);
    console.log(`  Customer:   ${i.CustomerRef?.name}`);
    console.log(`  Date / due: ${i.TxnDate} / ${i.DueDate || 'n/a'}`);
    console.log(`  Total:      ${money(i.TotalAmt, i.CurrencyRef?.value)}`);
    console.log(`  Still owed: ${money(i.Balance, i.CurrencyRef?.value)}`);
    console.log(`  Email to:   ${i.BillEmail?.Address || '(none on invoice)'}${i.BillEmailCc?.Address ? `  cc ${i.BillEmailCc.Address}` : ''}`);
    console.log(`  Emailed:    ${rawSentInfo(i)}\n`);
    return;
  }

  if (cmd === 'send') {
    const [num, overrideEmail] = args;
    if (!num) fail('Usage: node quickbooks/qb.js send <InvoiceNumber> [email]   e.g. node quickbooks/qb.js send WS1423');
    if (overrideEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(overrideEmail)) fail(`"${overrideEmail}" doesn't look like an email address.`);
    const i = await findInvoice(num);
    const to = overrideEmail || i.BillEmail?.Address;
    if (!to) fail(`Invoice ${num} has no customer email. Add one in QuickBooks, or run: node quickbooks/qb.js send ${num} name@example.com`);
    if (Number(i.Balance) === 0) console.log(`\n⚠ Note: invoice ${num} is already fully PAID.`);

    console.log(`\nAbout to email invoice ${i.DocNumber} from QuickBooks:`);
    console.log(`  Customer:   ${i.CustomerRef?.name}`);
    console.log(`  Still owed: ${money(i.Balance, i.CurrencyRef?.value)} (due ${i.DueDate || 'n/a'})`);
    console.log(`  Send to:    ${to}${i.BillEmailCc?.Address && !overrideEmail ? `  cc ${i.BillEmailCc.Address}` : ''}`);
    console.log(`  Last sent:  ${rawSentInfo(i)}`);
    if (!process.stdin.isTTY) fail('Sending needs you to confirm in Terminal. Run this command yourself in Terminal.');
    if ((await ask('\nType YES to send, anything else to cancel: ')) !== 'YES') { console.log('Cancelled. Nothing was sent.\n'); return; }

    let p = `/invoice/${encodeURIComponent(i.Id)}/send`;
    if (overrideEmail) p += `?sendTo=${encodeURIComponent(overrideEmail)}`;
    try {
      await qb.request(p, { method: 'POST', retry: false, label: 'invoice send', headers: { 'Content-Type': 'application/octet-stream' } });
    } catch (e) {
      fail(`QuickBooks didn't send it: ${e.message} Check QuickBooks before retrying.`);
    }
    console.log(`\n✔ Invoice ${i.DocNumber} emailed to ${to} via QuickBooks.\n`);
    return;
  }

  fail(`Unknown command "${cmd}". Try: test, unpaid, paid, vendor, query, pdf, invoices, overdue, invoice, send, export, set-token`);
}

if (typeof fetch !== 'function') fail('This needs Node.js 18 or newer. Install it from https://nodejs.org');
main().catch(err => {
  if (err instanceof ConfigError) fail(err.message);
  if (err instanceof QboError) fail(`${err.message}${err.code === 'reconnect' ? '' : ' Details saved in quickbooks/qb-errors.log.'}`);
  logError('unexpected error', { message: String(err), stack: err?.stack });
  fail(`Unexpected error: ${err.message}. Details saved in quickbooks/qb-errors.log.`);
});
