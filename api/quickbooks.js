/*
  Vercel serverless endpoint – READ-ONLY access to QuickBooks Online.

  GET /api/quickbooks?report=<name>[&...]
    health                     Company name + which token store is in use
    payables                   Unpaid supplier bills
    invoices                   Unpaid customer invoices
    overdue                    Overdue customer invoices
    paid&days=30               Supplier payments in the last N days
    pnl&start=YYYY-MM-DD&end=YYYY-MM-DD   Profit and Loss report
    balance-sheet&date=YYYY-MM-DD         Balance Sheet report
    query&q=SELECT ...         Any read-only QuickBooks query

  Every request needs the header  Authorization: Bearer <QB_API_KEY>
  (or x-api-key: <QB_API_KEY>). Nothing here can change data in QuickBooks.

  Environment variables (Vercel → Project → Settings → Environment Variables):
    QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID, QB_ENVIRONMENT (production)
    KV_REST_API_URL, KV_REST_API_TOKEN   (added automatically by the Upstash for Redis integration)
    QB_API_KEY                           (any long random string; callers must send it)
*/

const crypto = require('crypto');
const { createClient, QboError, unpaidBills, unpaidInvoices, supplierPayments } = require('../quickbooks/lib/qbo');
const { ConfigError } = require('../quickbooks/lib/credentials');

function authorised(req) {
  const expected = process.env.QB_API_KEY || '';
  if (expected.length < 16) return false; // refuse to run unprotected
  const h = req.headers.authorization || '';
  const given = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-api-key'] || '');
  const a = Buffer.from(String(given)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  if (!authorised(req)) return res.status(401).json({ error: 'Unauthorised (set QB_API_KEY and send it as a Bearer token)' });

  const q = req.query || {};
  const report = String(q.report || 'health');
  const log = (context, details) => console.error(`[quickbooks] ${context}`, JSON.stringify(details));

  try {
    const qb = createClient({ log });
    let data;
    switch (report) {
      case 'health': {
        const c = await qb.companyInfo();
        data = { company: c.CompanyName, country: c.Country, tokenStore: qb.config.store.name };
        break;
      }
      case 'payables': data = { bills: await unpaidBills(qb) }; break;
      case 'invoices': data = { invoices: await unpaidInvoices(qb) }; break;
      case 'overdue': data = { invoices: await unpaidInvoices(qb, { overdueOnly: true }) }; break;
      case 'paid': data = await supplierPayments(qb, Math.min(parseInt(q.days || '30', 10) || 30, 366)); break;
      case 'pnl': {
        const params = {};
        if (isDate(q.start)) params.start_date = q.start;
        if (isDate(q.end)) params.end_date = q.end;
        if (!params.start_date) params.date_macro = 'This Fiscal Year-to-date';
        data = await qb.report('ProfitAndLoss', params);
        break;
      }
      case 'balance-sheet': {
        const params = isDate(q.date) ? { end_date: q.date } : { date_macro: 'Today' };
        data = await qb.report('BalanceSheet', params);
        break;
      }
      case 'query': {
        const sql = String(q.q || '').trim();
        if (!/^select\s/i.test(sql)) return res.status(400).json({ error: 'Only SELECT queries are allowed.' });
        data = await qb.query(sql);
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown report "${report}". Try health, payables, invoices, overdue, paid, pnl, balance-sheet, query.` });
    }
    return res.status(200).json({ report, generatedAt: new Date().toISOString(), ...data });
  } catch (err) {
    if (err instanceof ConfigError) return res.status(500).json({ error: err.message, code: 'config' });
    if (err instanceof QboError) return res.status(err.code === 'reconnect' ? 503 : 502).json({ error: err.message, code: err.code, intuit_tid: err.intuitTid });
    console.error('[quickbooks] unexpected', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
};
