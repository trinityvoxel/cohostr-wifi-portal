const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const DASHBOARD_WEBHOOK = process.env.DASHBOARD_WEBHOOK || 'https://app.cohostr.com/api/webhooks/wifi-portal';

console.log(`CohoSTR WiFi Portal starting — ${property.name} on port ${PORT}`);

// ─── Image Cache ──────────────────────────────────────────────────────────────

function downloadImage(imageUrl, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(imageUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadImage(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
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

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(GOOGLE_PRIVATE_KEY, 'base64url');
  return `${header}.${payload}.${signature}`;
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
        const result = JSON.parse(data);
        if (result.access_token) resolve(result.access_token);
        else reject(new Error(`Token error: ${JSON.stringify(result)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function syncToGoogleSheets(name, email, propertyName, timestamp, emailConsent = false) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.warn('Google Sheets credentials not configured — skipping sync');
    return;
  }

  try {
    const token = await getGoogleAccessToken();
    const values = [[name, email, propertyName, timestamp, emailConsent ? 'Yes' : 'No', new Date().toISOString()]];
    const body = JSON.stringify({ values });
    const path = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/Sheet1!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    await new Promise((resolve, reject) => {
      const options = {
        hostname: 'sheets.googleapis.com',
        port: 443,
        path,
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
            console.log(`Synced to Google Sheets: ${email}`);
            resolve();
          } else {
            reject(new Error(`Sheets API error ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('Google Sheets sync failed:', err.message);
  }
}

// ─── Unifi Guest Authorization ────────────────────────────────────────────────

async function unifiRequest(path, method, body, cookies, csrfToken) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : '';
    const options = {
      hostname: UNIFI_HOST,
      port: 443,
      path,
      method,
      rejectUnauthorized: false, // Self-signed cert on local controller
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...(cookies ? { Cookie: cookies } : {}),
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: JSON.parse(data || '{}'),
        });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function authorizeGuest(mac, minutes = 480) {
  try {
    // UniFi OS login (Cloud Gateway Ultra, UDM, UDM Pro)
    const loginRes = await unifiRequest('/api/auth/login', 'POST', {
      username: UNIFI_USER,
      password: UNIFI_PASS,
    });

    if (loginRes.status !== 200) {
      throw new Error(`Unifi login failed — HTTP ${loginRes.status}`);
    }

    const setCookies = loginRes.headers['set-cookie'] || [];
    const cookies = setCookies.map(c => c.split(';')[0]).join('; ');
    const csrfToken = loginRes.headers['x-csrf-token'] || '';

    // Authorize the guest via UniFi OS proxy path
    const authRes = await unifiRequest(
      `/proxy/network/api/s/${UNIFI_SITE}/cmd/stamgr`,
      'POST',
      { cmd: 'authorize-guest', mac, minutes },
      cookies,
      csrfToken
    );

    console.log(`Unifi auth response: HTTP ${authRes.status} — ${JSON.stringify(authRes.body)}`);

    if (authRes.status !== 200) {
      throw new Error(`Guest authorization failed — HTTP ${authRes.status}`);
    }

    if (authRes.body?.meta?.rc !== 'ok') {
      throw new Error(`Unifi rejected authorization: ${JSON.stringify(authRes.body?.meta)}`);
    }

    console.log(`Authorized guest: ${mac} for ${minutes} min`);
    return true;
  } catch (err) {
    console.error('Unifi authorization failed:', err.message);
    return false;
  }
}

// ─── Cloudflare D1 Storage ────────────────────────────────────────────────────

async function storeInD1(name, email, mac, emailConsent = false) {
  if (!CF_ACCOUNT_ID || !CF_D1_DATABASE_ID || !CF_API_TOKEN) {
    console.warn('Cloudflare credentials not configured — skipping D1 sync');
    return;
  }

  try {
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
          const result = JSON.parse(data);
          if (result.success) {
            console.log(`Stored guest in D1: ${email}`);
            resolve(result);
          } else {
            reject(new Error(JSON.stringify(result.errors)));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.error('D1 storage failed:', err.message);
  }
}

// ─── Dashboard Webhook ────────────────────────────────────────────────────────

async function notifyDashboard(name, email, mac, emailConsent) {
  try {
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
          try {
            const result = JSON.parse(data);
            console.log(`Dashboard webhook response: ${JSON.stringify(result)}`);
            resolve(result);
          } catch {
            console.warn('Dashboard returned non-JSON response');
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error('Dashboard webhook failed:', err.message);
        resolve(null); // Don't reject — WiFi auth should still work
      });

      // 5 second timeout so guests aren't waiting forever
      req.setTimeout(5000, () => {
        req.destroy();
        console.warn('Dashboard webhook timed out');
        resolve(null);
      });

      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.error('Dashboard notify error:', err.message);
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
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const query = parsed.query;

  // Serve cached cover image
  if (req.method === 'GET' && path === '/cover.jpg') {
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
  if (req.method === 'GET' && (path === '/' || path === '/guest' || path.startsWith('/guest/'))) {
    console.log(`Portal request — full URL: ${req.url}`);
    console.log(`Query params: ${JSON.stringify(query)}`);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(renderPortal(query));
    return;
  }

  // Handle form submission
  if (req.method === 'POST' && path === '/submit') {
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

        console.log(`New guest: ${name} <${email}> mac=${mac}`);

        // Store in D1 + Google Sheets (non-blocking)
        const timestamp = new Date().toISOString();
        storeInD1(name, email, mac, emailConsent).catch(console.error);
        syncToGoogleSheets(name, email, property.name, timestamp, emailConsent).catch(console.error);

        // Notify dashboard + get dynamic WiFi duration based on checkout date
        const dashResult = await notifyDashboard(name, email, mac, emailConsent);
        const wifiMinutes = dashResult?.wifiMinutes || 480;

        // Authorize guest in Unifi with checkout-aware duration
        if (mac) {
          await authorizeGuest(mac, wifiMinutes);
        }

        // Return HTML success page — no external redirects that could cert-error
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
        console.error('Submit error:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<p>Server error. Please try again. <a href="/">Go back</a></p>');
      }
    });
    return;
  }

  // Health check
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, property: property.name }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Download cover image at startup then start server
console.log(`Downloading cover image for ${property.name}...`);
downloadImage(property.image, IMAGE_CACHE_PATH)
  .then(() => console.log('Cover image cached successfully'))
  .catch(err => console.warn('Cover image download failed (will retry on next restart):', err.message))
  .finally(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Portal running at http://0.0.0.0:${PORT} — ${property.name}`);
    });
  });
