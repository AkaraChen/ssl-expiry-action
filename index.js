// Zero-dependency SSL expiry checker for GitHub Actions.
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const { randomUUID, X509Certificate } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const DAY = 86_400_000;
const RANK = { ok: 0, warning: 1, critical: 2, error: 3 };
const ICON = { ok: '✅', warning: '🟡', critical: '🔴', error: '❌' };
const ANNOTATION = { warning: 'warning', critical: 'error', error: 'error' };

const input = (name, fallback) => process.env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;

const urls = [...new Set(input('urls', '').split(/[\s,]+/).filter(Boolean))];
const warningDays = Number(input('warning-days', '30'));
const criticalDays = Number(input('critical-days', '7'));
const timeoutMs = Number(input('timeout', '10')) * 1000;
const retries = Number(input('retries', '2'));
const failOn = input('fail-on', 'none');
const caInput = input('ca', '');

// Trust the given CA(s) on top of Node's bundled public roots. Built once and shared by all connections.
function loadCa(value) {
  try {
    const pem = value.includes('-----BEGIN') ? value : fs.readFileSync(value, 'utf8');
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certs) throw new Error('no PEM certificate found');
    // createSecureContext silently skips malformed certs, so parse each one to fail loudly instead.
    for (const cert of certs) new X509Certificate(cert);
    return tls.createSecureContext({ ca: [...tls.rootCertificates, ...certs] });
  } catch (e) {
    throw new Error(`invalid ca: ${e.message}`);
  }
}

function parse(raw) {
  const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 443 };
}

function classify(r) {
  if (r.error || r.days_left === null) r.status = 'error';
  else if (r.days_left <= criticalDays) r.status = 'critical';
  else if (r.days_left <= warningDays) r.status = 'warning';
  else r.status = 'ok';
  return r;
}

function check(url, secureContext) {
  const result = { url, host: null, port: null, status: 'error', days_left: null, expires_at: null, issuer: null, error: null };
  try {
    Object.assign(result, parse(url));
  } catch {
    return Promise.resolve({ ...result, error: 'invalid url' });
  }

  return new Promise((resolve) => {
    const socket = tls.connect({
      host: result.host,
      port: result.port,
      servername: net.isIP(result.host) ? undefined : result.host,
      secureContext,
      // Still read expired/untrusted certs; trust problems are reported via `error`.
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => done({ error: `timeout after ${timeoutMs / 1000}s` }), timeoutMs);

    function done(patch) {
      clearTimeout(timer);
      socket.destroy();
      resolve(classify({ ...result, ...patch }));
    }

    socket.on('error', (e) => done({ error: e.message }));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.valid_to) return done({ error: 'no certificate' });
      const expires = new Date(cert.valid_to);
      const authError = socket.authorized ? null : String(socket.authorizationError);
      done({
        days_left: Math.floor((expires - Date.now()) / DAY),
        expires_at: expires.toISOString(),
        issuer: cert.issuer?.O || cert.issuer?.CN || null,
        // Expiry is already covered by days_left, so it is not an error by itself.
        error: authError === 'CERT_HAS_EXPIRED' ? null : authError,
      });
    });
  });
}

// Retry only when no certificate was read (reset, timeout, DNS...). Cert problems and bad URLs are final.
async function checkWithRetry(url, secureContext) {
  let result = await check(url, secureContext);
  for (let i = 0; i < retries && result.host && result.days_left === null; i++) {
    await sleep(1000);
    result = await check(url, secureContext);
  }
  return result;
}

const label = (r) => (!r.host ? r.url : r.port === 443 ? r.host : `${r.host}:${r.port}`);
const days = (n) => `${n} day${Math.abs(n) === 1 ? '' : 's'}`;

function line(r) {
  if (r.status === 'error') return `${ICON.error} ${label(r)}: ${r.error}`;
  const when = r.days_left < 0 ? `expired ${days(-r.days_left)} ago` : `expires in ${days(r.days_left)}`;
  return `${ICON[r.status]} ${label(r)}: ${when} (${r.expires_at.slice(0, 10)})`;
}

const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return console.log(`[output] ${name}=${value}`);
  const eof = `EOF_${randomUUID()}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${eof}\n${value}\n${eof}\n`);
}

function writeSummary(results) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = results.map((r) =>
    `| ${ICON[r.status]} ${r.status} | ${label(r)} | ${r.days_left ?? '-'} | ${r.expires_at?.slice(0, 10) ?? '-'} | ${r.issuer ?? '-'} | ${r.error ?? ''} |`);
  const table = ['| Status | Host | Days left | Expires | Issuer | Error |', '|---|---|---|---|---|---|', ...rows];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### SSL certificates\n\n${table.join('\n')}\n`);
}

async function main() {
  if (!urls.length) throw new Error('input "urls" is required');
  if (!['none', 'warning', 'critical', 'error'].includes(failOn)) throw new Error(`invalid fail-on: ${failOn}`);
  if (![warningDays, criticalDays, timeoutMs, retries].every(Number.isFinite)) {
    throw new Error('warning-days, critical-days, timeout and retries must be numbers');
  }
  if (timeoutMs <= 0) throw new Error('timeout must be greater than 0');
  if (retries < 0) throw new Error('retries must not be negative');
  if (criticalDays > warningDays) throw new Error('critical-days must not be greater than warning-days');
  const secureContext = caInput ? loadCa(caInput) : undefined;

  const results = (await Promise.all(urls.map((url) => checkWithRetry(url, secureContext))))
    .sort((a, b) => RANK[b.status] - RANK[a.status] || (a.days_left ?? 0) - (b.days_left ?? 0));
  const status = results[0].status; // sorted worst-first
  const problems = results.filter((r) => r.status !== 'ok');

  for (const r of results) {
    const level = ANNOTATION[r.status];
    console.log(level ? `::${level} title=SSL certificate::${escapeData(line(r))}` : line(r));
  }

  setOutput('json', JSON.stringify(results));
  setOutput('status', status);
  setOutput('alert', String(problems.length > 0));
  setOutput('message', problems.map(line).join('\n'));
  writeSummary(results);

  if (failOn !== 'none' && RANK[status] >= RANK[failOn]) {
    console.log(`::error::worst status is "${status}" (fail-on: ${failOn})`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log(`::error::${escapeData(e.message)}`);
  process.exitCode = 1;
});
