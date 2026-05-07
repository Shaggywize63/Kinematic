// k6 load test — POST /api/v1/crm/ai/chat
//
// The chatbot calls Anthropic upstream and runs a tool-use loop (up to 5
// turns). Risks under load:
//   1. Anthropic per-org rate limits — API key is shared, runaway concurrent
//      chats will start 429ing.
//   2. Tool-use loops fan into Supabase reads. If many users ask "show top
//      leads" simultaneously, the tools all hit crm_leads at once.
//   3. Latency dominated by upstream model time — typically 2-8s per turn.
//
// Targets are deliberately loose vs the analytics endpoints because most
// time is upstream model inference. Treat this as a smoke / soak test more
// than a throughput test.
//
// Usage:
//   k6 run \
//     -e BASE_URL=https://api.kinematicapp.com \
//     -e TOKEN="$KINEMATIC_JWT" \
//     -e CLIENT_ID=optional-uuid \
//     loadtest/kini-chat.js

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';
const CLIENT_ID = __ENV.CLIENT_ID || '';

const errors = new Rate('errors');
const chatLat = new Trend('chat_latency_ms', true);
const rate429 = new Rate('rate_limit_hits');

// Realistic prompts that exercise different tools — search, top leads,
// pipeline summary, draft email. Avoid mutating prompts to keep the test
// idempotent.
const PROMPTS = [
  'Show my hottest 5 leads',
  'What deals are closing this week?',
  'Summarize my open pipeline',
  'Show deals over 50000 in Indian rupees',
  'List leads from Mumbai',
  'How many activities did my team log last week?',
];

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus: 5,                  // very gentle — chats are expensive
      duration: '2m',
    },
  },
  thresholds: {
    errors: ['rate<0.05'],     // looser than analytics; upstream can flake
    chat_latency_ms: ['p(95)<15000'],  // 15s p95 — model + tool loop
    rate_limit_hits: ['rate<0.10'],
  },
};

function headers() {
  const h = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (CLIENT_ID) h['X-Client-Id'] = CLIENT_ID;
  return h;
}

export default function () {
  const prompt = randomItem(PROMPTS);
  const body = JSON.stringify({
    messages: [{ role: 'user', content: prompt }],
    system: 'You are KINI, the Kinematic CRM AI assistant. Be concise.',
    context: { module: 'crm', route: '/dashboard/crm/dashboard' },
  });

  const r = http.post(`${BASE}/api/v1/crm/ai/chat`, body, { headers: headers(), timeout: '30s' });
  chatLat.add(r.timings.duration);
  rate429.add(r.status === 429);

  const ok = check(r, {
    '2xx': (res) => res.status >= 200 && res.status < 300,
    'has data.text': (res) => {
      try { return typeof res.json('data.text') === 'string'; } catch { return false; }
    },
  });
  errors.add(!ok);

  // Spread requests — chat is expensive and we want to be a good neighbour
  // to the upstream model API.
  sleep(Math.random() * 3 + 2);
}
