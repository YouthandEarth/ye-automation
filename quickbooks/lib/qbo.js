/*
  QuickBooks Online API client (works for UK companies – it talks to the
  standard Accounting API, not the US-only connector).

  Shared by the Terminal tool (quickbooks/qb.js) and the Vercel API (api/quickbooks.js).
*/

const { loadConfig } = require('./credentials');

const DISCOVERY_URL = 'https://developer.api.intuit.com/.well-known/openid_configuration';
const FALLBACK_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
};
const MINOR_VERSION = '75';

const RECONNECT_HELP =
  'QuickBooks needs reconnecting. In the Intuit OAuth Playground get a new Refresh Token ' +
  '(Get authorization code → Get tokens) and save it with:  node quickbooks/qb.js set-token';

class QboError extends Error {
  constructor(message, { code, status, intuitTid, details } = {}) {
    super(message);
    this.code = code; this.status = status; this.intuitTid = intuitTid; this.details = details;
  }
}

async function fetchWithRetry(url, options, label, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, options);
      if ([429, 500, 502, 503, 504].includes(res.status) && i < tries) {
        await new Promise(r => setTimeout(r, 1000 * i * i));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < tries) await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
  throw new QboError(`Couldn't reach Intuit (${label}). Check the internet connection.`,
    { code: 'network', details: { message: String(lastErr) } });
}

function createClient({ log = () => {} } = {}) {
  const cfg = loadConfig();
  const base = API_BASE[cfg.environment] || API_BASE.production;
  let accessToken = null;

  async function tokenEndpoint() {
    try {
      const res = await fetchWithRetry(DISCOVERY_URL, { headers: { Accept: 'application/json' } }, 'discovery document');
      if (res.ok) return (await res.json()).token_endpoint || FALLBACK_TOKEN_URL;
    } catch (_) { /* fall through */ }
    return FALLBACK_TOKEN_URL;
  }

  async function getAccessToken() {
    if (accessToken) return accessToken;
    const saved = await cfg.store.get();
    // Reuse a still-valid access token from the shared store (saves a refresh per call on Vercel).
    if (saved.accessToken && saved.accessExpiresAt && Date.parse(saved.accessExpiresAt) - Date.now() > 120e3) {
      accessToken = saved.accessToken;
      return accessToken;
    }
    if (!saved.refreshToken) throw new QboError(`No refresh token in the "${cfg.store.name}" store. ${RECONNECT_HELP}`, { code: 'reconnect' });

    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const res = await fetchWithRetry(await tokenEndpoint(), {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refreshToken }),
    }, 'token refresh');
    const tid = res.headers.get('intuit_tid');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log('token refresh failed', { status: res.status, intuit_tid: tid, error: body.error, error_description: body.error_description });
      if (body.error === 'invalid_grant') throw new QboError(RECONNECT_HELP, { code: 'reconnect', status: res.status, intuitTid: tid });
      if (body.error === 'invalid_client') throw new QboError('Client ID or Client Secret is wrong (check the Production keys are used).', { code: 'config', status: res.status, intuitTid: tid });
      throw new QboError(`Couldn't refresh the QuickBooks login (status ${res.status}).`, { code: 'auth', status: res.status, intuitTid: tid });
    }
    accessToken = body.access_token;
    await cfg.store.set({
      refreshToken: body.refresh_token || saved.refreshToken, // Intuit rotates refresh tokens
      accessToken: cfg.store.name === 'upstash' ? body.access_token : undefined,
      accessExpiresAt: cfg.store.name === 'upstash' ? new Date(Date.now() + (body.expires_in || 3600) * 1000).toISOString() : undefined,
    });
    return accessToken;
  }

  async function request(pathAndQuery, { method = 'GET', accept = 'application/json', label = 'QuickBooks request', retry = true, headers = {} } = {}) {
    const token = await getAccessToken();
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    const url = `${base}/v3/company/${cfg.realmId}${pathAndQuery}${sep}minorversion=${MINOR_VERSION}`;
    const opts = { method, headers: { Authorization: `Bearer ${token}`, Accept: accept, ...headers } };
    // Writes (e.g. sending an invoice) are never retried, so nothing happens twice by accident.
    const res = retry ? await fetchWithRetry(url, opts, label) : await fetch(url, opts);
    const tid = res.headers.get('intuit_tid');
    if (accept !== 'application/json') {
      if (!res.ok) {
        log(`${label} failed`, { status: res.status, intuit_tid: tid });
        throw new QboError(`${label} failed (status ${res.status}).`, { status: res.status, intuitTid: tid });
      }
      return Buffer.from(await res.arrayBuffer());
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.Fault) {
      const errors = body.Fault?.Error || body.fault?.error || [];
      log(`${label} failed`, { status: res.status, intuit_tid: tid, path: pathAndQuery, errors });
      if (res.status === 401) throw new QboError(RECONNECT_HELP, { code: 'reconnect', status: 401, intuitTid: tid });
      const msg = errors.map(e => e.Message || e.message).filter(Boolean).join('; ');
      const detail = errors.map(e => e.Detail).filter(Boolean).join('; ');
      throw new QboError(`QuickBooks returned an error${msg ? `: ${msg}` : ''}${detail ? ` (${detail})` : ''} (intuit_tid ${tid || 'n/a'}).`,
        { status: res.status, intuitTid: tid, details: errors });
    }
    return body;
  }

  async function query(sql) {
    const body = await request(`/query?query=${encodeURIComponent(sql)}`, { label: 'QuickBooks query' });
    return body.QueryResponse || {};
  }

  async function queryAll(baseSql, entity, page = 1000) {
    const out = [];
    for (let start = 1; ; start += page) {
      const rows = (await query(`${baseSql} STARTPOSITION ${start} MAXRESULTS ${page}`))[entity] || [];
      out.push(...rows);
      if (rows.length < page) break;
    }
    return out;
  }

  async function companyInfo() {
    return (await request(`/companyinfo/${cfg.realmId}`, { label: 'company info' })).CompanyInfo;
  }

  async function report(name, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return request(`/reports/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`, { label: `${name} report` });
  }

  return { config: cfg, request, query, queryAll, companyInfo, report };
}

// ---------- shared helpers ----------
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const today = () => new Date().toISOString().slice(0, 10);

async function unpaidBills(qb) {
  const t = today();
  const bills = await qb.queryAll("SELECT * FROM Bill WHERE Balance > '0' ORDERBY DueDate", 'Bill');
  return bills.map(b => {
    const cur = b.CurrencyRef?.value || 'GBP';
    const rate = Number(b.ExchangeRate || 1);
    const due = b.DueDate || b.TxnDate;
    return {
      id: b.Id,
      supplier: b.VendorRef?.name || '',
      billNo: b.DocNumber || '',
      billDate: b.TxnDate,
      dueDate: due,
      currency: cur,
      total: Number(b.TotalAmt || 0),
      owed: Number(b.Balance || 0),
      owedGBP: Math.round(Number(b.Balance || 0) * (cur === 'GBP' ? 1 : rate) * 100) / 100,
      overdue: due < t,
    };
  });
}

async function unpaidInvoices(qb, { overdueOnly = false } = {}) {
  const t = today();
  const where = overdueOnly ? `Balance > '0' AND DueDate < '${t}'` : `Balance > '0'`;
  const invs = await qb.queryAll(`SELECT * FROM Invoice WHERE ${where} ORDERBY DueDate`, 'Invoice');
  return invs.map(i => ({
    id: i.Id,
    invoiceNo: i.DocNumber || i.Id,
    customer: i.CustomerRef?.name || '',
    date: i.TxnDate,
    dueDate: i.DueDate || '',
    currency: i.CurrencyRef?.value || 'GBP',
    total: Number(i.TotalAmt || 0),
    owed: Number(i.Balance || 0),
    emailTo: i.BillEmail?.Address || '',
    emailStatus: i.EmailStatus || 'NotSet',
    lastSent: i.DeliveryInfo?.DeliveryTime ? i.DeliveryInfo.DeliveryTime.slice(0, 10) : '',
    overdue: (i.DueDate || '9999') < t,
  }));
}

async function supplierPayments(qb, days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const pays = await qb.queryAll(`SELECT * FROM BillPayment WHERE TxnDate >= '${since}' ORDERBY TxnDate DESC`, 'BillPayment');
  return {
    since,
    payments: pays.map(p => ({
      id: p.Id, date: p.TxnDate, supplier: p.VendorRef?.name || '',
      currency: p.CurrencyRef?.value || 'GBP', amount: Number(p.TotalAmt || 0),
      payType: p.PayType || '', ref: p.DocNumber || '',
    })),
  };
}

module.exports = { createClient, QboError, RECONNECT_HELP, esc, today, unpaidBills, unpaidInvoices, supplierPayments };
