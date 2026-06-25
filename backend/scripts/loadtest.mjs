// Lightweight load test for the API tier (auth + read endpoints).
//   node scripts/loadtest.mjs [concurrency] [durationSeconds]
// Defaults: 25 virtual users for 10s. Measures throughput, latency, errors, 429s.
//
// NOTE: This intentionally exercises only login + read endpoints. It does NOT
// drive /api/sessions/start or report generation, because those call the PAID
// Sarvam API (and are deliberately rate-limited). Voice-pipeline capacity must be
// planned around Sarvam's concurrency/quota separately, on PostgreSQL.
const BASE = process.env.LOADTEST_BASE || 'http://localhost:3002';
const CONCURRENCY = Number(process.argv[2] || 25);
const DURATION_MS = Number(process.argv[3] || 10) * 1000;

const ADMIN = { username: 'admin', password: process.env.ADMIN_PASSWORD || 'admin123' };

// /health is public + not rate-limited and pings the DB, so it gives a clean
// server+DB capacity reading. (Authenticated read endpoints are per-user
// rate-limited by design, which would dominate a single-token load test.)
const READ_ENDPOINTS = (process.env.LOADTEST_ENDPOINTS || '/health')
  .split(',').map(s => s.trim()).filter(Boolean);

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN),
  });
  const j = await r.json();
  if (!j.token) throw new Error('login failed: ' + JSON.stringify(j));
  return j.token;
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

(async () => {
  console.log(`Load test → ${BASE} | ${CONCURRENCY} concurrent users | ${DURATION_MS / 1000}s`);
  const token = await login();
  const H = { Authorization: `Bearer ${token}` };

  const latencies = [];
  let ok = 0, err = 0, limited = 0, total = 0;
  const endAt = Date.now() + DURATION_MS;

  async function worker() {
    while (Date.now() < endAt) {
      const url = BASE + READ_ENDPOINTS[Math.floor(Math.random() * READ_ENDPOINTS.length)];
      const t0 = performance.now();
      try {
        const res = await fetch(url, { headers: H });
        const dt = performance.now() - t0;
        latencies.push(dt);
        total++;
        if (res.status === 429) limited++;
        else if (res.ok) ok++;
        else err++;
      } catch {
        total++; err++;
      }
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (Date.now() - t0) / 1000;

  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((s, x) => s + x, 0) / (latencies.length || 1);
  console.log('\n================ RESULTS ================');
  console.log(`requests        : ${total}`);
  console.log(`throughput      : ${(total / elapsed).toFixed(0)} req/s`);
  console.log(`success (2xx)   : ${ok}`);
  console.log(`rate-limited 429: ${limited}`);
  console.log(`errors          : ${err}`);
  console.log(`error rate      : ${((err / (total || 1)) * 100).toFixed(2)}%`);
  console.log(`latency avg     : ${avg.toFixed(1)} ms`);
  console.log(`latency p50     : ${pct(latencies, 50).toFixed(1)} ms`);
  console.log(`latency p95     : ${pct(latencies, 95).toFixed(1)} ms`);
  console.log(`latency p99     : ${pct(latencies, 99).toFixed(1)} ms`);
  console.log(`latency max     : ${(latencies[latencies.length - 1] || 0).toFixed(1)} ms`);
  console.log('=========================================');
})().catch(e => { console.error('Load test failed:', e.message); process.exit(1); });
