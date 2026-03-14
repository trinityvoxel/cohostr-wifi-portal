const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Process-level Error Handling ─────────────────────────────────────────────
// Prevents the server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] Uncaught exception (server still running): ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[FATAL] Unhandled promise rejection (server still running):`, reason);
});

// All property details driven by add-on config — no hardcoded properties
const PROPERTY_ID = process.env.PROPERTY_ID || 'property';
const property = {
  id: PROPERTY_ID,
  name: process.env.PROPERTY_NAME || 'Guest WiFi Portal',
  location: process.env.PROPERTY_LOCATION || '',
  listingUrl: process.env.PROPERTY_LISTING_URL || '',
  image: process.env.PROPERTY_IMAGE_URL || '',
};

const IMAGE_CACHE_PATH = '/tmp/portal-cover.jpg';
const PORT = parseInt(process.env.PORT || '80');
const UNIFI_HOST = process.env.UNIFI_HOST;
const UNIFI_USER = process.env.UNIFI_USER;
const UNIFI_PASS = process.env.UNIFI_PASS;
const UNIFI_SITE = process.env.UNIFI_SITE || 'default';
const UNIFI_API_KEY = process.env.UNIFI_API_KEY || '';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY_RAW = process.env.GOOGLE_PRIVATE_KEY || '';

// ─── Google Private Key Normalization ─────────────────────────────────────────
// Handle multiple formats: escaped newlines, base64-encoded, PKCS#1 vs PKCS#8
function normalizePrivateKey(raw) {
  if (!raw) return '';

  let key = raw;

  // Step 1: Replace literal \n sequences with actual newlines
  key = key.replace(/\\n/g, '\n');

  // Step 2: If the key looks like raw base64 (no PEM headers), wrap it
  if (!key.includes('-----BEGIN')) {
    // Try to detect if it's a base64-encoded PEM (double-encoded)
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) {
        key = decoded;
      }
    } catch (e) {
      // Not base64-encoded, try wrapping as PKCS#8
      key = `-----BEGIN PRIVATE KEY-----\n${key.trim()}\n-----END PRIVATE KEY-----`;
    }
  }

  // Step 3: Convert PKCS#1 (RSA PRIVATE KEY) to PKCS#8 format if needed
  // Node.js crypto.createSign works with both, but some versions are picky
  // We'll try both formats if signing fails

  return key.trim();
}

const GOOGLE_PRIVATE_KEY = normalizePrivateKey(GOOGLE_PRIVATE_KEY_RAW);

const DASHBOARD_WEBHOOK = process.env.DASHBOARD_WEBHOOK || 'https://app.cohostr.com/api/webhooks/wifi-portal';

console.log(`[STARTUP] CohoSTR WiFi Portal starting — ${property.name} on port ${PORT}`);
console.log(`[STARTUP] UniFi host: ${UNIFI_HOST || '(not configured)'}`);
console.log(`[STARTUP] UniFi site: ${UNIFI_SITE}`);
console.log(`[STARTUP] UniFi API key: ${UNIFI_API_KEY ? 'configured (v1 Hotspot API)' : 'not configured (will use legacy login)'}`);
console.log(`[STARTUP] Cloudflare D1: ${CF_D1_DATABASE_ID ? 'configured' : 'not configured'}`);
console.log(`[STARTUP] Google Sheets: ${GOOGLE_SHEET_ID ? 'configured' : 'not configured'}`);
console.log(`[STARTUP] Google Private Key: ${GOOGLE_PRIVATE_KEY ? `present (${GOOGLE_PRIVATE_KEY.substring(0, 30)}...)` : 'not configured'}`);
console.log(`[STARTUP] Dashboard webhook: ${DASHBOARD_WEBHOOK}`);

// ─── Safe JSON Parse Helper ───────────────────────────────────────────────────

function safeJsonParse(data, context = 'unknown') {
  if (!data || data.trim().length === 0) {
    console.warn(`[JSON] Empty response body from ${context}`);
    return {};
  }

  try {
    return JSON.parse(data);
  } catch (err) {
    // Log the first 500 chars of the response for debugging
    const preview = data.substring(0, 500);
    console.error(`[JSON] Failed to parse response from ${context}: ${err.message}`);
    console.error(`[JSON] Response preview: ${preview}`);

    // Check if it looks like XML (common UniFi redirect/error response)
    if (data.trim().startsWith('<?xml') || data.trim().startsWith('<')) {
      console.error(`[JSON] Response appears to be XML/HTML — likely a redirect page or error from the controller`);
    }

    return { _parseError: true, _rawResponse: preview, _context: context };
  }
}

// ─── Image Cache ──────────────────────────────────────────────────────────────

function downloadImage(imageUrl, dest) {
  return new Promise((resolve, reject) => {
    if (!imageUrl) {
      console.warn('[IMAGE] No image URL configured — skipping download');
      return resolve();
    }

    console.log(`[IMAGE] Downloading cover image from: ${imageUrl}`);
    const file = fs.createWriteStream(dest);
    https.get(imageUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        console.log(`[IMAGE] Following redirect to: ${res.headers.location}`);
        return downloadImage(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`Image download failed with HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); console.log('[IMAGE] Cover image cached successfully'); resolve(); });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ─── Google Sheets Sync ───────────────────────────────────────────────────────

function createGoogleJWT() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url');

  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(GOOGLE_PRIVATE_KEY, 'base64url');
    return `${header}.${payload}.${signature}`;
  } catch (err) {
    // This is where "DECODER routines::unsupported" error occurs
    // Usually means the key format is wrong
    console.error(`[GOOGLE] JWT signing failed: ${err.message}`);
    console.error(`[GOOGLE] This usually means the private key format is incorrect.`);
    console.error(`[GOOGLE] Key should be in PEM format (-----BEGIN PRIVATE KEY-----)`);
    console.error(`[GOOGLE] Make sure the key from your service account JSON is pasted correctly`);
    console.error(`[GOOGLE] In the add-on config, use the raw key value from the JSON file`);

    // Try alternate key format (PKCS#1 vs PKCS#8 conversion)
    if (GOOGLE_PRIVATE_KEY.includes('BEGIN RSA PRIVATE KEY')) {
      console.log(`[GOOGLE] Detected PKCS#1 format, trying with createPrivateKey conversion...`);
      try {
        const keyObject = crypto.createPrivateKey({
          key: GOOGLE_PRIVATE_KEY,
          format: 'pem',
        });
        const sign2 = crypto.createSign('RSA-SHA256');
        sign2.update(`${header}.${payload}`);
        const signature2 = sign2.sign(keyObject, 'base64url');
        console.log(`[GOOGLE] PKCS#1 key conversion succeeded`);
        return `${header}.${payload}.${signature2}`;
      } catch (err2) {
        console.error(`[GOOGLE] PKCS#1 conversion also failed: ${err2.message}`);
      }
    }

    throw new Error(`Google JWT signing failed — check private key format: ${err.message}`);
  }
}

async function getGoogleAccessToken() {
  const jwt = createGoogleJWT();
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const result = safeJsonParse(data, 'Google OAuth token');
        if (result.access_token) resolve(result.access_token);
        else reject(new Error(`Google token error: ${JSON.stringify(result)}`));
      });
    });
    req.on('error', (err) => {
      console.error(`[GOOGLE] OAuth request failed: ${err.message}`);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function syncToGoogleSheets(name, email, propertyName, timestamp, emailConsent = false) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.warn('[GOOGLE] Google Sheets credentials not configured — skipping sync');
    return;
  }

  try {
    console.log(`[GOOGLE] Syncing guest to Google Sheets: ${email}`);
    const token = await getGoogleAccessToken();
    const values = [[name, email, propertyName, timestamp, emailConsent ? 'Yes' : 'No', new Date().toISOString()]];
    const body = JSON.stringify({ values });
    const reqPath = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/Sheet1!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    await new Promise((resolve, reject) => {
      const options = {
        hostname: 'sheets.googleapis.com',
        port: 443,
        path: reqPath,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log(`[GOOGLE] Synced to Google Sheets: ${email}`);
            resolve();
          } else {
            console.error(`[GOOGLE] Sheets API error ${res.statusCode}: ${data}`);
            reject(new Error(`Sheets API error ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', (err) => {
        console.error(`[GOOGLE] Sheets request failed: ${err.message}`);
        reject(err);
      });
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error(`[GOOGLE] Google Sheets sync failed: ${err.message}`);
    // Don't re-throw — Google Sheets failure should never block WiFi access
  }
}

// ─── Unifi Guest Authorization ────────────────────────────────────────────────

// Parse the UniFi host into hostname and port
function getUnifiHostInfo() {
  const hostParts = (UNIFI_HOST || '').split(':');
  const hostname = hostParts[0];
  const port = hostParts[1] ? parseInt(hostParts[1]) : 443;
  return { hostname, port };
}

async function unifiRequest(reqPath, method, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const { hostname, port } = getUnifiHostInfo();

    const options = {
      hostname,
      port,
      path: reqPath,
      method,
      rejectUnauthorized: false, // Self-signed cert on local controller
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...extraHeaders,
      },
    };

    console.log(`[UNIFI] ${method} https://${hostname}:${port}${reqPath}`);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const parsedBody = safeJsonParse(data, `UniFi ${reqPath}`);

        if (parsedBody._parseError) {
          console.error(`[UNIFI] Non-JSON response from ${reqPath} (HTTP ${res.statusCode})`);
          console.error(`[UNIFI] This may indicate:`);
          console.error(`[UNIFI]   - Wrong UniFi host/port`);
          console.error(`[UNIFI]   - Controller is redirecting to a login page`);
          console.error(`[UNIFI]   - API path doesn't exist on this controller version`);
          console.error(`[UNIFI]   - Network firewall blocking the connection`);
        }

        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsedBody,
        });
      });
    });

    req.on('error', (err) => {
      console.error(`[UNIFI] Request error for ${reqPath}: ${err.message}`);
      reject(err);
    });

    // Timeout after 10 seconds to prevent hanging
    req.setTimeout(10000, () => {
      req.destroy();
      console.error(`[UNIFI] Request to ${reqPath} timed out after 10s`);
      reject(new Error(`UniFi request timed out: ${reqPath}`));
    });

    if (postData) req.write(postData);
    req.end();
  });
}

// ─── Strategy 1: Official v1 External Hotspot API (Cloud Gateway Ultra / UDM) ─
// Uses API key from Network > Control Plane > Integrations
// This is the recommended approach for Cloud Gateway Ultra
async function authorizeGuestV1Api(mac, minutes = 480) {
  console.log(`[UNIFI-V1] Using official v1 Hotspot API with API key`);

  const apiKeyHeader = { 'X-API-KEY': UNIFI_API_KEY };

  // Step 1: Get sites
  console.log(`[UNIFI-V1] Step 1: Fetching sites...`);
  const sitesRes = await unifiRequest(
    '/proxy/network/integration/v1/sites',
    'GET',
    null,
    apiKeyHeader
  );

  if (sitesRes.status !== 200 || sitesRes.body._parseError) {
    console.error(`[UNIFI-V1] Failed to get sites — HTTP ${sitesRes.status}`);
    return false;
  }

  // The response is an array of sites, or { data: [...] }
  const sites = Array.isArray(sitesRes.body) ? sitesRes.body : (sitesRes.body.data || []);
  if (sites.length === 0) {
    console.error(`[UNIFI-V1] No sites found in API response`);
    return false;
  }

  const siteId = sites[0].id || sites[0]._id || sites[0].siteId;
  console.log(`[UNIFI-V1] Using site: ${siteId} (${sites[0].name || 'default'})`);

  // Step 2: Find the client by MAC address to get the clientId
  console.log(`[UNIFI-V1] Step 2: Looking up client MAC=${mac}...`);
  const normalizedMac = mac.toLowerCase().replace(/-/g, ':');
  const clientsRes = await unifiRequest(
    `/proxy/network/integration/v1/sites/${siteId}/clients?macAddress=${encodeURIComponent(normalizedMac)}`,
    'GET',
    null,
    apiKeyHeader
  );

  if (clientsRes.status !== 200 || clientsRes.body._parseError) {
    console.error(`[UNIFI-V1] Failed to look up client — HTTP ${clientsRes.status}`);
    console.error(`[UNIFI-V1] Response: ${JSON.stringify(clientsRes.body)}`);
    return false;
  }

  const clients = Array.isArray(clientsRes.body) ? clientsRes.body : (clientsRes.body.data || []);

  // Try to find the client matching this MAC
  let client = clients.find(c =>
    (c.macAddress || c.mac || '').toLowerCase().replace(/-/g, ':') === normalizedMac
  );

  // If filtered endpoint returned a single client object, use that
  if (!client && !Array.isArray(clientsRes.body) && clientsRes.body.id) {
    client = clientsRes.body;
  }

  if (!client) {
    console.error(`[UNIFI-V1] Client with MAC=${mac} not found. ${clients.length} clients returned.`);
    console.error(`[UNIFI-V1] The device may not have fully connected yet, or MAC format mismatch.`);
    // Log first few clients for debugging
    if (clients.length > 0) {
      console.log(`[UNIFI-V1] Sample clients: ${JSON.stringify(clients.slice(0, 3))}`);
    }
    return false;
  }

  const clientId = client.id || client._id || client.clientId;
  console.log(`[UNIFI-V1] Found client: id=${clientId}, name=${client.name || 'unknown'}, authorized=${client.access?.authorized || false}`);

  // Step 3: Authorize the client
  console.log(`[UNIFI-V1] Step 3: Authorizing client for ${minutes} minutes...`);
  const authRes = await unifiRequest(
    `/proxy/network/integration/v1/sites/${siteId}/clients/${clientId}/actions`,
    'POST',
    {
      action: 'AUTHORIZE_GUEST_ACCESS',
      timeLimitMinutes: minutes,
    },
    apiKeyHeader
  );

  console.log(`[UNIFI-V1] Auth response: HTTP ${authRes.status} — ${JSON.stringify(authRes.body)}`);

  if (authRes.status >= 200 && authRes.status < 300) {
    console.log(`[UNIFI-V1] ✓ Authorized guest via v1 API: ${mac} for ${minutes} min`);
    return true;
  }

  console.error(`[UNIFI-V1] Authorization failed — HTTP ${authRes.status}`);
  return false;
}

// ─── Strategy 2: Legacy session-based API (UniFi OS — Cloud Gateway, UDM) ────
// Uses /api/auth/login + /proxy/network/api/s/{site}/cmd/stamgr
async function authorizeGuestLegacyUnifiOS(mac, minutes = 480) {
  console.log(`[UNIFI-LEGACY] Trying UniFi OS login (/api/auth/login)...`);

  const loginRes = await unifiRequest('/api/auth/login', 'POST', {
    username: UNIFI_USER,
    password: UNIFI_PASS,
  });

  if (loginRes.body._parseError || loginRes.status === 404) {
    console.warn(`[UNIFI-LEGACY] /api/auth/login returned ${loginRes.status} — not a UniFi OS endpoint`);
    return null; // Signal to try next strategy
  }

  if (loginRes.status !== 200) {
    console.error(`[UNIFI-LEGACY] Login failed — HTTP ${loginRes.status}: ${JSON.stringify(loginRes.body)}`);
    console.error(`[UNIFI-LEGACY] If using a UI.com cloud account, create a local-only admin user instead.`);
    console.error(`[UNIFI-LEGACY] Cloud accounts with MFA cannot be used for API access.`);
    return false;
  }

  const setCookies = loginRes.headers['set-cookie'] || [];
  const cookies = setCookies.map(c => c.split(';')[0]).join('; ');
  const csrfToken = loginRes.headers['x-csrf-token'] || '';
  console.log(`[UNIFI-LEGACY] Login OK, ${setCookies.length} cookies, CSRF: ${csrfToken ? 'yes' : 'no'}`);

  // Authorize guest via proxy path
  const authRes = await unifiRequest(
    `/proxy/network/api/s/${UNIFI_SITE}/cmd/stamgr`,
    'POST',
    { cmd: 'authorize-guest', mac, minutes },
    {
      ...(cookies ? { Cookie: cookies } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    }
  );

  console.log(`[UNIFI-LEGACY] Auth response: HTTP ${authRes.status} — ${JSON.stringify(authRes.body)}`);

  if (authRes.body._parseError) {
    console.error(`[UNIFI-LEGACY] Non-JSON auth response — proxy path may not exist`);
    return false;
  }

  if (authRes.status !== 200) {
    console.error(`[UNIFI-LEGACY] Guest auth failed — HTTP ${authRes.status}`);
    return false;
  }

  console.log(`[UNIFI-LEGACY] ✓ Authorized guest: ${mac} for ${minutes} min`);
  return true;
}

// ─── Strategy 3: Classic controller API (older UniFi software controllers) ────
// Uses /api/login + /api/s/{site}/cmd/stamgr (no /proxy/network prefix)
async function authorizeGuestClassicController(mac, minutes = 480) {
  console.log(`[UNIFI-CLASSIC] Trying classic controller login (/api/login)...`);

  const loginRes = await unifiRequest('/api/login', 'POST', {
    username: UNIFI_USER,
    password: UNIFI_PASS,
  });

  if (loginRes.body._parseError || loginRes.status === 404) {
    console.warn(`[UNIFI-CLASSIC] /api/login returned ${loginRes.status} — not a classic controller`);
    return null;
  }

  if (loginRes.status !== 200) {
    console.error(`[UNIFI-CLASSIC] Login failed — HTTP ${loginRes.status}`);
    return false;
  }

  const setCookies = loginRes.headers['set-cookie'] || [];
  const cookies = setCookies.map(c => c.split(';')[0]).join('; ');
  console.log(`[UNIFI-CLASSIC] Login OK, ${setCookies.length} cookies`);

  const authRes = await unifiRequest(
    `/api/s/${UNIFI_SITE}/cmd/stamgr`,
    'POST',
    { cmd: 'authorize-guest', mac, minutes },
    cookies ? { Cookie: cookies } : {}
  );

  console.log(`[UNIFI-CLASSIC] Auth response: HTTP ${authRes.status} — ${JSON.stringify(authRes.body)}`);

  if (authRes.status !== 200 || authRes.body._parseError) {
    console.error(`[UNIFI-CLASSIC] Guest auth failed — HTTP ${authRes.status}`);
    return false;
  }

  console.log(`[UNIFI-CLASSIC] ✓ Authorized guest: ${mac} for ${minutes} min`);
  return true;
}

// ─── Main Authorization Entrypoint (auto-detects correct strategy) ────────────
async function authorizeGuest(mac, minutes = 480) {
  if (!UNIFI_HOST) {
    console.error('[UNIFI] UniFi host not configured — cannot authorize guest');
    return false;
  }

  // Need either API key or username+password
  if (!UNIFI_API_KEY && (!UNIFI_USER || !UNIFI_PASS)) {
    console.error('[UNIFI] No UniFi API key or credentials configured — cannot authorize guest');
    console.error('[UNIFI] Configure unifi_api_key (recommended for Cloud Gateway Ultra)');
    console.error('[UNIFI] Or configure unifi_user + unifi_pass for legacy login');
    return false;
  }

  try {
    console.log(`[UNIFI] Attempting to authorize guest MAC=${mac} for ${minutes} minutes`);
    console.log(`[UNIFI] Controller: ${UNIFI_HOST}`);

    // Strategy 1: If API key is configured, use the official v1 Hotspot API
    // This is the recommended method for Cloud Gateway Ultra
    if (UNIFI_API_KEY) {
      console.log(`[UNIFI] API key configured — using v1 External Hotspot API (recommended)`);
      const result = await authorizeGuestV1Api(mac, minutes);
      if (result) return true;
      console.warn(`[UNIFI] v1 API failed — will try legacy methods if credentials are available`);
    }

    // Strategy 2: Try UniFi OS login (/api/auth/login) — Cloud Gateways & UDM
    if (UNIFI_USER && UNIFI_PASS) {
      console.log(`[UNIFI] Trying UniFi OS session-based login...`);
      const legacyResult = await authorizeGuestLegacyUnifiOS(mac, minutes);
      if (legacyResult === true) return true;
      if (legacyResult === false) {
        // Login worked but auth failed — don't try classic
        console.error(`[UNIFI] UniFi OS login succeeded but guest authorization failed`);
        return false;
      }

      // legacyResult === null means /api/auth/login returned 404 → try classic
      console.log(`[UNIFI] UniFi OS endpoint not found — trying classic controller...`);
      const classicResult = await authorizeGuestClassicController(mac, minutes);
      if (classicResult === true) return true;
      if (classicResult === false) return false;
    }

    // All strategies exhausted
    console.error(`[UNIFI] ✗ All authorization strategies failed for MAC=${mac}`);
    console.error(`[UNIFI] Troubleshooting for Cloud Gateway Ultra:`);
    console.error(`[UNIFI]   1. RECOMMENDED: Generate an API key in UniFi Network → Settings → Control Plane → Integrations`);
    console.error(`[UNIFI]      Then set unifi_api_key in the add-on config`);
    console.error(`[UNIFI]   2. Ensure the controller is reachable at https://${UNIFI_HOST}`);
    console.error(`[UNIFI]   3. For legacy login: create a LOCAL admin user (not a UI.com cloud account)`);
    console.error(`[UNIFI]   4. Check that the Hotspot/Captive Portal is enabled on the guest SSID`);
    return false;
  } catch (err) {
    console.error(`[UNIFI] Authorization failed with error: ${err.message}`);
    console.error(`[UNIFI] Stack: ${err.stack}`);
    return false;
  }
}

// ─── Cloudflare D1 Storage ────────────────────────────────────────────────────

async function storeInD1(name, email, mac, emailConsent = false) {
  if (!CF_ACCOUNT_ID || !CF_D1_DATABASE_ID || !CF_API_TOKEN) {
    console.warn('[D1] Cloudflare credentials not configured — skipping D1 sync');
    return;
  }

  try {
    console.log(`[D1] Storing guest in D1: ${email}`);
    const timestamp = new Date().toISOString();
    const sql = `INSERT INTO guests (name, email, property_id, property_name, submitted_at, email_consent) VALUES (?, ?, ?, ?, ?, ?)`;
    const params = [name, email, PROPERTY_ID, property.name, timestamp, emailConsent ? 1 : 0];

    const body = JSON.stringify({ sql, params });

    await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.cloudflare.com',
        port: 443,
        path: `/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CF_API_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const result = safeJsonParse(data, 'Cloudflare D1');
          if (result.success) {
            console.log(`[D1] ✓ Stored guest in D1: ${email}`);
            resolve(result);
          } else {
            console.error(`[D1] D1 API error: ${JSON.stringify(result)}`);
            reject(new Error(JSON.stringify(result.errors || result)));
          }
        });
      });

      req.on('error', (err) => {
        console.error(`[D1] Request failed: ${err.message}`);
        reject(err);
      });

      // Timeout after 10 seconds
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('D1 request timed out'));
      });

      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error(`[D1] D1 storage failed: ${err.message}`);
    // Don't re-throw — D1 failure should never block WiFi access
  }
}

// ─── Dashboard Webhook ────────────────────────────────────────────────────────

async function notifyDashboard(name, email, mac, emailConsent) {
  try {
    console.log(`[WEBHOOK] Notifying dashboard: ${DASHBOARD_WEBHOOK}`);
    const payload = JSON.stringify({
      propertyId: PROPERTY_ID,
      propertyName: property.name,
      name,
      email,
      mac,
      emailConsent,
      timestamp: new Date().toISOString(),
    });

    const webhookUrl = new URL(DASHBOARD_WEBHOOK);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: webhookUrl.hostname,
        port: 443,
        path: webhookUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const result = safeJsonParse(data, 'Dashboard webhook');
          console.log(`[WEBHOOK] Dashboard response (HTTP ${res.statusCode}): ${JSON.stringify(result)}`);
          resolve(result);
        });
      });

      req.on('error', (err) => {
        console.error(`[WEBHOOK] Dashboard webhook failed: ${err.message}`);
        resolve(null); // Don't reject — WiFi auth should still work
      });

      // 5 second timeout so guests aren't waiting forever
      req.setTimeout(5000, () => {
        req.destroy();
        console.warn('[WEBHOOK] Dashboard webhook timed out after 5s');
        resolve(null);
      });

      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.error(`[WEBHOOK] Dashboard notify error: ${err.message}`);
    return null;
  }
}

// ─── Portal HTML ──────────────────────────────────────────────────────────────

function renderPortal(query) {
  const mac = query.id || query.mac || ''; // Unifi passes client MAC as 'id'
  const redirect = query.url || query.redirect || property.listingUrl;
  const ap = query.ap || '';
  const ssid = query.ssid || '';

  return `<!DOCTYPE html>
<html>
<head>
  <title>${property.name} - WiFi Portal</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)),
                  url('/cover.jpg') center/cover no-repeat;
    }
    .card {
      background: white;
      border-radius: 14px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.45);
      overflow: hidden;
      max-width: 420px;
      width: 100%;
    }
    .card-header {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      padding: 20px 24px 18px;
      text-align: center;
    }
    .h-eyebrow {
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.14em; color: rgba(255,255,255,0.6); margin-bottom: 4px;
    }
    .h-name { font-size: 20px; font-weight: 800; color: #fff; margin-bottom: 3px; }
    .h-loc  { font-size: 12px; color: rgba(255,255,255,0.55); margin-bottom: 7px; }
    .h-cta  { font-size: 12.5px; color: rgba(255,255,255,0.85); }
    .h-cta a { color: #fff; font-weight: 700; text-decoration: underline; }
    .form-body { padding: 26px 30px 30px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
    input[type=text], input[type=email] {
      width: 100%; padding: 11px 14px;
      border: 1.5px solid #e5e7eb; border-radius: 8px;
      font-size: 15px; margin-bottom: 14px;
      font-family: inherit; transition: border-color 0.2s;
    }
    input[type=text]:focus, input[type=email]:focus { outline: none; border-color: #2563eb; }
    button {
      width: 100%; padding: 14px;
      background: #2563eb; color: white;
      border: none; border-radius: 8px;
      font-size: 16px; font-weight: 700;
      cursor: pointer; transition: background 0.2s;
      letter-spacing: 0.01em;
    }
    button:hover { background: #1d4ed8; }
    .book-direct {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 12px 14px;
      background: #f0fdf4;
      border: 1.5px solid #bbf7d0;
      border-radius: 8px;
      margin-top: 14px;
    }
    .book-direct .ico { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
    .book-direct p { font-size: 13px; color: #166534; line-height: 1.45; }
    .book-direct a { color: #15803d; font-weight: 700; text-decoration: none; }
    .consent-row {
      display: flex; align-items: center; gap: 10px; margin-top: 14px;
    }
    .consent-row input[type=checkbox] {
      width: 17px; height: 17px; margin: 0;
      accent-color: #2563eb; cursor: pointer; flex-shrink: 0;
    }
    .consent-row label {
      margin: 0; font-weight: 400; font-size: 13px; color: #6b7280; cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="h-eyebrow">Welcome to</div>
      <div class="h-name">${property.name}</div>
      <div class="h-loc">${property.location}</div>
      <div class="h-cta">Book direct at <a href="https://www.cohostr.com">CohoSTR.com</a> &amp; skip the fees</div>
    </div>
    <div class="form-body">
      <form method="POST" action="/submit">
        <input type="hidden" name="mac" value="${mac}">
        <input type="hidden" name="redirect" value="${redirect}">
        <input type="hidden" name="ap" value="${ap}">
        <input type="hidden" name="ssid" value="${ssid}">

        <label for="name">Your Name</label>
        <input id="name" name="name" type="text" placeholder="Jane Smith" required autocomplete="name">

        <label for="email">Email Address</label>
        <input id="email" name="email" type="email" placeholder="jane@example.com" required autocomplete="email">

        <button type="submit">Connect to WiFi</button>

        <div class="book-direct">
          <span class="ico">\uD83C\uDFE1</span>
          <p>Skip the OTA fees — <a href="https://www.cohostr.com"><strong>book direct at CohoSTR.com</strong></a> and save on your next stay.</p>
        </div>

        <div class="consent-row">
          <input type="checkbox" id="email_consent" name="email_consent" value="yes" checked>
          <label for="email_consent">Send me discounts on future stays</label>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const reqPath = parsed.pathname;
    const query = parsed.query;

    // Serve cached cover image
    if (req.method === 'GET' && reqPath === '/cover.jpg') {
      if (fs.existsSync(IMAGE_CACHE_PATH)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(IMAGE_CACHE_PATH).pipe(res);
      } else {
        res.writeHead(404);
        res.end('Image not yet cached');
      }
      return;
    }

    // Serve portal page
    if (req.method === 'GET' && (reqPath === '/' || reqPath === '/guest' || reqPath.startsWith('/guest/'))) {
      console.log(`[PORTAL] Portal request — full URL: ${req.url}`);
      console.log(`[PORTAL] Query params: ${JSON.stringify(query)}`);
      console.log(`[PORTAL] Client IP: ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(renderPortal(query));
      return;
    }

    // Handle form submission
    if (req.method === 'POST' && reqPath === '/submit') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        try {
          // Parse URL-encoded form data
          const params = new URLSearchParams(body);
          const name = params.get('name') || '';
          const email = params.get('email') || '';
          const mac = params.get('mac') || '';
          const redirect = params.get('redirect') || '';
          const emailConsent = params.get('email_consent') === 'yes';

          if (!name || !email) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<p>Name and email are required. <a href="/">Go back</a></p>');
            return;
          }

          console.log(`[SUBMIT] New guest: ${name} <${email}> mac=${mac} consent=${emailConsent}`);

          // Store in D1 + Google Sheets (non-blocking, failures won't affect WiFi)
          const timestamp = new Date().toISOString();
          storeInD1(name, email, mac, emailConsent).catch(err => {
            console.error(`[SUBMIT] D1 background error: ${err.message}`);
          });
          syncToGoogleSheets(name, email, property.name, timestamp, emailConsent).catch(err => {
            console.error(`[SUBMIT] Google Sheets background error: ${err.message}`);
          });

          // Notify dashboard + get dynamic WiFi duration based on checkout date
          let wifiMinutes = 480; // Default 8 hours
          try {
            const dashResult = await notifyDashboard(name, email, mac, emailConsent);
            if (dashResult?.wifiMinutes) {
              wifiMinutes = dashResult.wifiMinutes;
              console.log(`[SUBMIT] Dashboard returned wifiMinutes=${wifiMinutes}`);
            }
          } catch (err) {
            console.error(`[SUBMIT] Dashboard notification failed: ${err.message}`);
            // Continue with default minutes
          }

          // Authorize guest in Unifi with checkout-aware duration
          let unifiSuccess = false;
          if (mac) {
            unifiSuccess = await authorizeGuest(mac, wifiMinutes);
            console.log(`[SUBMIT] UniFi authorization result: ${unifiSuccess ? 'SUCCESS' : 'FAILED'}`);
          } else {
            console.warn(`[SUBMIT] No MAC address provided — skipping UniFi authorization`);
          }

          // Always show success page to the guest
          // Even if UniFi auth failed, the guest data is captured and
          // they may still get internet via other means (fallback VLAN, etc.)
          console.log(`[SUBMIT] ✓ Guest submission complete: ${name} <${email}> unifi=${unifiSuccess}`);

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connected!</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh; display: flex; align-items: center;
      justify-content: center; background: #f0fdf4; padding: 20px;
    }
    .card {
      background: white; border-radius: 12px; padding: 40px;
      max-width: 440px; width: 100%; text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
    }
    .check { font-size: 56px; margin-bottom: 16px; }
    h1 { font-size: 24px; color: #16a34a; margin-bottom: 8px; }
    p { color: #555; font-size: 15px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">\u2705</div>
    <h1>You're connected!</h1>
    <p>Welcome to ${property.name}.<br>You can now close this window and browse normally.</p>
  </div>
</body>
</html>`);
        } catch (err) {
          console.error(`[SUBMIT] Critical error during form submission: ${err.message}`);
          console.error(`[SUBMIT] Stack: ${err.stack}`);
          // Still try to send a response if headers haven't been sent
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<p>Something went wrong, but your information was received. Please try closing this window — WiFi should be active. <a href="/">Try again</a></p>');
          }
        }
      });
      return;
    }

    // Health check
    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        property: property.name,
        propertyId: PROPERTY_ID,
        unifiHost: UNIFI_HOST || 'not configured',
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      }));
      return;
    }

    // Debug endpoint (useful for troubleshooting)
    if (req.method === 'GET' && reqPath === '/debug') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        property,
        config: {
          unifiHost: UNIFI_HOST || 'not set',
          unifiSite: UNIFI_SITE,
          unifiApiKey: UNIFI_API_KEY ? '(set — v1 Hotspot API)' : 'not set',
          unifiUser: UNIFI_USER ? '(set)' : 'not set',
          unifiPass: UNIFI_PASS ? '(set)' : 'not set',
          cfAccountId: CF_ACCOUNT_ID ? '(set)' : 'not set',
          cfD1DatabaseId: CF_D1_DATABASE_ID ? '(set)' : 'not set',
          cfApiToken: CF_API_TOKEN ? '(set)' : 'not set',
          googleSheetId: GOOGLE_SHEET_ID || 'not set',
          googleClientEmail: GOOGLE_CLIENT_EMAIL || 'not set',
          googlePrivateKey: GOOGLE_PRIVATE_KEY ? `(set, starts with: ${GOOGLE_PRIVATE_KEY.substring(0, 27)}...)` : 'not set',
          dashboardWebhook: DASHBOARD_WEBHOOK,
        },
        uptime: process.uptime(),
        nodeVersion: process.version,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      }, null, 2));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error(`[SERVER] Request handler error: ${err.message}`);
    console.error(`[SERVER] Stack: ${err.stack}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<p>Internal server error. <a href="/">Go back</a></p>');
    }
  }
});

// Handle server-level errors
server.on('error', (err) => {
  console.error(`[SERVER] Server error: ${err.message}`);
});

// Download cover image at startup then start server
console.log(`[STARTUP] Downloading cover image for ${property.name}...`);
downloadImage(property.image, IMAGE_CACHE_PATH)
  .then(() => console.log('[STARTUP] Cover image cached successfully'))
  .catch(err => console.warn(`[STARTUP] Cover image download failed (will retry on next restart): ${err.message}`))
  .finally(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[STARTUP] ✓ Portal running at http://0.0.0.0:${PORT} — ${property.name}`);
      console.log(`[STARTUP] Health check: http://0.0.0.0:${PORT}/health`);
      console.log(`[STARTUP] Debug info: http://0.0.0.0:${PORT}/debug`);
    });
  });
