const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveProperty(input) {
  const s = (input || '').toLowerCase().trim();
  if (s.includes('river') || s === '1') return 'riverbend';
  if (s.includes('comal') || s === '2') return 'comal';
  if (s.includes('heron') || s.includes('blue') || s === '3') return 'heron';
  return s; // fallback — use as-is
}
const PROPERTY_ID = resolveProperty(process.env.PROPERTY || 'riverbend');
const IMAGE_CACHE_PATH = '/tmp/portal-cover.jpg';
const PORT = parseInt(process.env.PORT || '8099');
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

const PROPERTIES = {
  riverbend: {
    name: 'Riverbend Hideaway',
    location: 'San Marcos, TX',
    listingUrl: 'https://www.cohostr.com/listings/297530',
    image: 'https://hostaway-platform.s3.us-west-2.amazonaws.com/listing/87999-297530-DcPs67WuOwB5o7P5GqtCvFN32E8cRhwrrp8RMIlPoa8-68efd79c87e31',
  },
  comal: {
    name: 'Comal Condo',
    location: 'New Braunfels, TX',
    listingUrl: 'https://www.cohostr.com/listings/241046',
    image: 'https://hostaway-platform.s3.us-west-2.amazonaws.com/listing/87999-241046-nr9U-nZVh83g37snneUlW5bKYE7V0ZP04BoVUjoR-dA-65ca4f6e12ff7',
  },
  heron: {
    name: "Blue Heron's Nest",
    location: 'New Braunfels, TX',
    listingUrl: 'https://www.cohostr.com/listings/385190',
    image: 'https://hostaway-platform.s3.us-west-2.amazonaws.com/listing/87999-385190-hgo2AzCyWTfjOfdfaD6w3FQDjsyegKXKzUdTkHhcTck-680d42b65d55e',
  },
};

const property = PROPERTIES[PROPERTY_ID];
if (!property) {
  console.error(`Unknown property: ${PROPERTY_ID}`);
  process.exit(1);
}

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

async function syncToGoogleSheets(name, email, propertyName, timestamp) {
  if (!GOOGLE_SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.warn('Google Sheets credentials not configured — skipping sync');
    return;
  }

  try {
    const token = await getGoogleAccessToken();
    const values = [[name, email, propertyName, timestamp, new Date().toISOString()]];
    const body = JSON.stringify({ values });
    const path = `/v4/spreadsheets/${GOOGLE_SHEET_ID}/values/Sheet1!A:E:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

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

async function storeInD1(name, email, mac) {
  if (!CF_ACCOUNT_ID || !CF_D1_DATABASE_ID || !CF_API_TOKEN) {
    console.warn('Cloudflare credentials not configured — skipping D1 sync');
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    const sql = `INSERT INTO guests (name, email, property_id, property_name, submitted_at) VALUES (?, ?, ?, ?, ?)`;
    const params = [name, email, PROPERTY_ID, property.name, timestamp];

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
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      padding: 40px;
      max-width: 440px;
      width: 100%;
    }
    h1 { font-size: 24px; color: #1a1a1a; margin-bottom: 4px; }
    .loc { color: #888; font-size: 14px; margin-bottom: 28px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
    input {
      width: 100%; padding: 11px 14px;
      border: 1.5px solid #ddd; border-radius: 7px;
      font-size: 15px; margin-bottom: 16px;
      transition: border-color 0.2s;
    }
    input:focus { outline: none; border-color: #0070f3; }
    button {
      width: 100%; padding: 13px;
      background: #0070f3; color: white;
      border: none; border-radius: 7px;
      font-size: 16px; font-weight: 600;
      cursor: pointer; transition: background 0.2s;
    }
    button:hover { background: #005fd1; }
    .msg { margin-top: 14px; font-size: 14px; text-align: center; display: none; }
    .msg.success { color: #16a34a; }
    .msg.error { color: #dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${property.name}</h1>
    <div class="loc">${property.location}</div>

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
    </form>
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

        if (!name || !email) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<p>Name and email are required. <a href="/">Go back</a></p>');
          return;
        }

        console.log(`New guest: ${name} <${email}> mac=${mac}`);

        // Store in D1 + Google Sheets (non-blocking)
        const timestamp = new Date().toISOString();
        storeInD1(name, email, mac).catch(console.error);
        syncToGoogleSheets(name, email, property.name, timestamp).catch(console.error);

        // Authorize guest in Unifi
        if (mac) {
          await authorizeGuest(mac);
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
    <div class="check">✅</div>
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
