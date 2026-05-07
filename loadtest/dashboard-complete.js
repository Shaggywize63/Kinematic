// k6 load test — GET /api/v1/crm/analytics/dashboard-complete
//
// Highest-risk endpoint after the cost↔weight toggle landed: weight mode
// joins crm_deals → crm_deal_line_items → crm_products. We want to
// confirm that:
//   1. p95 latency stays under target on a realistic org size
//   2. The weight path doesn't regress vs the rupee path (worst case ~2x)
//   3. The endpoint scales sub-linearly with concurrent users
//
// Usage:
//   k6 run \
//     -e BASE_URL=https://api.kinematicapp.com \
//     -e TOKEN="$KINEMATIC_JWT" \
//     -e CLIENT_ID=optional-uuid \
//     loadtest/dashboard-complete.js
//
// Targets:
//   - p95 < 800ms (rupee mode)
//   - p95 < 1500ms (weight mode — line-items join is heavier)
//   - error_rate < 1%

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';
const CLIENT_ID = __ENV.CLIENT_ID || '';

const errors = new Rate('errors');
const inrLatency = new Trend('inr_latency_ms', true);
const weightLatency = new Trend('weight_latency_ms', true);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 5 },   // warm up
        { duration: '1m',  target: 20 },  // realistic peak
        { duration: '1m',  target: 50 },  // stress
        { duration: '30s', target: 0 },   // cool down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    errors: ['rate<0.01'],
    inr_latency_ms: ['p(95)<800'],
    weight_latency_ms: ['p(95)<1500'],
    http_req_failed: ['rate<0.01'],
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
  group('dashboard-complete (rupee mode)', () => {
    const r = http.get(`${BASE}/api/v1/crm/analytics/dashboard-complete`, { headers: headers() });
    inrLatency.add(r.timings.duration);
    const ok = check(r, {
      '200': (res) => res.status === 200,
      'has summary': (res) => {
        try { return !!res.json('data.summary'); } catch { return false; }
      },
      'has pipelineValue': (res) => {
        try { return Array.isArray(res.json('data.pipelineValue')); } catch { return false; }
      },
    });
    errors.add(!ok);
  });

  group('dashboard-complete (weight mode)', () => {
    const r = http.get(`${BASE}/api/v1/crm/analytics/dashboard-complete?unit=weight`, { headers: headers() });
    weightLatency.add(r.timings.duration);
    const ok = check(r, {
      '200': (res) => res.status === 200,
      'has summary': (res) => {
        try { return !!res.json('data.summary'); } catch { return false; }
      },
      'unit=weight echoed': (res) => {
        try { return res.json('data.unit') === 'weight'; } catch { return false; }
      },
    });
    errors.add(!ok);
  });
}
