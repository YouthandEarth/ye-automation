/*
  Where the QuickBooks settings and tokens live.

  Settings (QB_CLIENT_ID, QB_CLIENT_SECRET, QB_REALM_ID, QB_ENVIRONMENT, ...)
  are read in this order:
    1. environment variables        (Vercel, or exported in Terminal)
    2. macOS Keychain               (service "youthandearth-quickbooks", one item per key)
    3. quickbooks/quickbooks.env    (optional local fallback, git-ignored)

  The refresh token changes from time to time (Intuit rotates it), so it needs a
  store that can be written back to. Three stores are supported:

    keychain  – Mac only. Token kept in the Keychain item QB_REFRESH_TOKEN.
    upstash   – Shared Redis (Vercel Marketplace "Upstash for Redis"). Needed as
                soon as the script runs anywhere other than one Mac, so the Mac
                and Vercel always use the same, latest token.
    env       – Read-only QB_REFRESH_TOKEN env var. Works until Intuit rotates
                the token; only for quick tests.

  QB_TOKEN_STORE picks the store. If unset: upstash when KV_REST_API_URL (or
  UPSTASH_REDIS_REST_URL) is set, keychain on a Mac, env otherwise.
*/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KEYCHAIN_SERVICE = 'youthandearth-quickbooks';
const ENV_FILE = path.join(__dirname, '..', 'quickbooks.env');
const IS_MAC = process.platform === 'darwin';

let fileEnv = null;
function readEnvFile() {
  if (fileEnv) return fileEnv;
  fileEnv = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) fileEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return fileEnv;
}

function keychainGet(key) {
  if (!IS_MAC) return '';
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', key, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return ''; }
}

function keychainSet(key, value) {
  execFileSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', key, '-w', value],
    { stdio: 'ignore' });
}

function setting(key) {
  return process.env[key] || keychainGet(key) || readEnvFile()[key] || '';
}

class ConfigError extends Error {}

// ---------- token stores ----------
function keychainStore() {
  return {
    name: 'keychain',
    async get() { return { refreshToken: keychainGet('QB_REFRESH_TOKEN') }; },
    async set(t) { if (t.refreshToken) keychainSet('QB_REFRESH_TOKEN', t.refreshToken); },
  };
}

function envStore() {
  let warned = false;
  return {
    name: 'env',
    async get() { return { refreshToken: setting('QB_REFRESH_TOKEN') }; },
    async set(t) {
      if (t.refreshToken && t.refreshToken !== setting('QB_REFRESH_TOKEN') && !warned) {
        warned = true;
        console.warn('⚠ Intuit issued a new refresh token but QB_TOKEN_STORE=env cannot save it. ' +
          'Set up the shared Upstash store (see quickbooks/README.md) before relying on this.');
      }
    },
  };
}

function upstashStore(realmId) {
  const url = setting('KV_REST_API_URL') || setting('UPSTASH_REDIS_REST_URL');
  const token = setting('KV_REST_API_TOKEN') || setting('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) throw new ConfigError('QB_TOKEN_STORE=upstash but KV_REST_API_URL / KV_REST_API_TOKEN are not set.');
  const key = `qbo:${realmId}:tokens`;
  async function cmd(args) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`Token store error: ${body.error || res.status}`);
    return body.result;
  }
  return {
    name: 'upstash',
    async get() {
      const raw = await cmd(['GET', key]);
      return raw ? JSON.parse(raw) : {};
    },
    async set(t) {
      const current = await this.get();
      await cmd(['SET', key, JSON.stringify({ ...current, ...t, updatedAt: new Date().toISOString() })]);
    },
  };
}

function loadConfig() {
  const cfg = {
    clientId: setting('QB_CLIENT_ID'),
    clientSecret: setting('QB_CLIENT_SECRET'),
    realmId: setting('QB_REALM_ID'),
    environment: (setting('QB_ENVIRONMENT') || 'production').toLowerCase(),
  };
  for (const [k, v] of [['QB_CLIENT_ID', cfg.clientId], ['QB_CLIENT_SECRET', cfg.clientSecret], ['QB_REALM_ID', cfg.realmId]]) {
    if (!v) throw new ConfigError(`${k} is missing (set it as an environment variable or in the Keychain service "${KEYCHAIN_SERVICE}").`);
  }
  let storeName = setting('QB_TOKEN_STORE').toLowerCase();
  if (!storeName) {
    if (setting('KV_REST_API_URL') || setting('UPSTASH_REDIS_REST_URL')) storeName = 'upstash';
    else storeName = IS_MAC ? 'keychain' : 'env';
  }
  if (storeName === 'keychain' && !IS_MAC) throw new ConfigError('QB_TOKEN_STORE=keychain only works on a Mac.');
  cfg.store = storeName === 'upstash' ? upstashStore(cfg.realmId)
    : storeName === 'keychain' ? keychainStore()
    : envStore();
  return cfg;
}

module.exports = { loadConfig, setting, keychainGet, keychainSet, ConfigError, KEYCHAIN_SERVICE, IS_MAC };
