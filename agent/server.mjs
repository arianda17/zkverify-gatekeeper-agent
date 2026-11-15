// Wowok Proof Gatekeeper agent — public HTTPS endpoint for zkVerify Agent Games.
// POST /agent : preflight + proof-gatekeeper tasks (HMAC-signed both ways).
// GET  / , GET /agent : health/status (200, no auth).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, prove } from './gatekeeper.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HMAC_SECRET = process.env.AGENT_GAMES_HMAC_SECRET || '';
const SEEN_FILE = path.join(__dirname, 'seen-proof-tx.json');
const CACHE_FILE = path.join(__dirname, 'task-cache.json');
const LOG_FILE = path.join(__dirname, 'agent.log');

if (!HMAC_SECRET) {
  console.error('FATAL: AGENT_GAMES_HMAC_SECRET is not set (get it from Dashboard > Agent > Rotate Secret).');
  process.exit(1);
}

function log(obj) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...obj });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
}

const seenProofTx = new Set(loadJson(SEEN_FILE, []));
const taskCache = loadJson(CACHE_FILE, {}); // task_id -> { proof_tx, response }

function hmacHex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifySignature(rawBody, header) {
  if (!header) return false;
  let sig = String(header).trim();
  if (sig.toLowerCase().startsWith('sha256=')) sig = sig.slice(7);
  const expectedHex = hmacHex(HMAC_SECRET, rawBody);
  const candidates = [sig.toLowerCase()];
  try { candidates.push(Buffer.from(sig, 'base64').toString('hex')); } catch {}
  try { candidates.push(Buffer.from(sig, 'hex').toString('hex')); } catch {}
  return candidates.some((c) => {
    try {
      const a = Buffer.from(c, 'hex');
      const b = Buffer.from(expectedHex, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  });
}

function signBody(rawBody) {
  return hmacHex(HMAC_SECRET, rawBody);
}

function sendSigned(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'x-agent-games-signature': signBody(body),
  });
  res.end(body);
}

async function handleTask(task) {
  const taskId = task.task_id;
  // Idempotency: same task_id retried -> same response.
  if (taskId && taskCache[taskId]) {
    return { ...taskCache[taskId].response, _cached: true };
  }
  const input = task.input || {};
  const proofTx = String(input.proof_tx || '');

  // PROOF_REUSED: proof reference already accepted in an earlier task.
  if (proofTx && seenProofTx.has(proofTx)) {
    const response = { decision: 'REJECT', reason_code: 'PROOF_REUSED', proof_tx: proofTx };
    if (taskId) { taskCache[taskId] = { proof_tx: proofTx, response }; saveJson(CACHE_FILE, taskCache); }
    return response;
  }

  const { decision, reason_code } = decide(input);
  const decision01 = decision === 'APPROVE' ? 1 : 0;

  let proof = null;
  let publicSignals = null;
  try {
    const r = await prove(task, decision01);
    proof = r.proof;
    publicSignals = r.publicSignals;
  } catch (e) {
    // Proof failed: still answer the decision (scores without the proof bonus).
    log({ event: 'proof_failed', task_id: taskId, error: String(e && e.message || e).slice(0, 300) });
  }

  const response = { decision, reason_code, proof_tx: proofTx };
  if (proof && publicSignals) { response.proof = proof; response.public_signals = publicSignals; }

  if (proofTx) { seenProofTx.add(proofTx); saveJson(SEEN_FILE, [...seenProofTx]); }
  if (taskId) { taskCache[taskId] = { proof_tx: proofTx, response }; saveJson(CACHE_FILE, taskCache); }
  return response;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/agent')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'wowok-gatekeeper', version: 'v1', agent: 'wowok' }));
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/agent') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);
    const started = Date.now();
    if (!verifySignature(rawBody, req.headers['x-agent-games-signature'])) {
      log({ event: 'bad_signature', path: url.pathname });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad signature' }));
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad json' }));
      return;
    }

    try {
      if (envelope.type === 'agent-games.preflight.v1') {
        sendSigned(res, 200, { ok: true, protocolVersion: 'v1' });
        log({ event: 'preflight', agent_id: envelope.agent_id || null, ms: Date.now() - started });
        return;
      }
      if (envelope.type === 'agent-games.proof-gatekeeper.v1') {
        // Fail closed well inside the 60s window.
        const response = await Promise.race([
          handleTask(envelope),
          new Promise((resolve) => setTimeout(() => resolve({
            decision: 'REJECT', reason_code: 'TIMEOUT_GUARD', proof_tx: String(envelope.input?.proof_tx || ''),
            _timeout_guard: true,
          }), 50000)),
        ]);
        const cached = response._cached; delete response._cached; delete response._timeout_guard;
        sendSigned(res, 200, response);
        log({ event: 'task', task_id: envelope.task_id || null, decision: response.decision, reason_code: response.reason_code, proof: !!response.proof, cached: !!cached, ms: Date.now() - started });
        return;
      }
      sendSigned(res, 200, { ok: false, error: 'unknown type' });
      log({ event: 'unknown_type', type: envelope.type || null });
    } catch (e) {
      log({ event: 'handler_error', error: String(e && e.message || e).slice(0, 300) });
      // Fail closed: reject rather than approve on error.
      try { sendSigned(res, 200, { decision: 'REJECT', reason_code: 'INTERNAL_ERROR', proof_tx: String(envelope?.input?.proof_tx || '') }); } catch {}
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`wowok-gatekeeper listening on ${HOST}:${PORT} (endpoint /agent)`);
  log({ event: 'startup', port: PORT });
});
