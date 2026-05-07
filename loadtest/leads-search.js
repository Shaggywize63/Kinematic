// k6 load test — GET /api/v1/crm/leads (with search)
//
// The search uses .or() with 4 ilike clauses across first_name, last_name,
// company, email. None of those columns currently has a trigram index, so
// large orgs may see seq scans. This test exercises both unfiltered list
// and search-with-q, plus a few common filter shapes.
//
// Usage:
//   k6 run \
//     -e BASE_URL=https://api.kinematicapp.com \
//     -e TOKEN="$KINEMATIC_JWT" \
//     loadtest/leads-search.js
//
// Targets:
//   - p95 < 500ms (unfiltered list, limit=50)
//   - p95 < 800ms (search with q=)

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { randomItem } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';

const errors = new Rate('errors');
const listLat = new Trend('list_latency_ms', true);
const searchLat = new Trend('search_latency_ms', true);

// Realistic search terms (single-word substrings of company/name/email).
const TERMS = ['acme', 'global', 'jane', 'kumar', 'tech', '@gmail', 'singh', 'india', 'corp', 'ltd'];

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m',  target: 30 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    errors: ['rate<0.01'],
    list_latency_ms: ['p(95)<500'],
    search_latency_ms: ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
  },
};

function headers() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
}

export default function () {
  group('list (unfiltered)', () => {
    const r = http.get(`${BASE}/api/v1/crm/leads?limit=50`, { headers: headers() });
    listLat.add(r.timings.duration);
    const ok = check(r, {
      '200': (res) => res.status === 200,
      'data is array': (res) => {
        try { return Array.isArray(res.json('data')); } catch { return false; }
      },
    });
    errors.add(!ok);
  });

  group('search by q', () => {
    const term = randomItem(TERMS);
    const r = http.get(`${BASE}/api/v1/crm/leads?limit=50&q=${encodeURIComponent(term)}`, { headers: headers() });
    searchLat.add(r.timings.duration);
    const ok = check(r, {
      '200': (res) => res.status === 200,
      'data is array': (res) => {
        try { return Array.isArray(res.json('data')); } catch { return false; }
      },
    });
    errors.add(!ok);
  });

  group('filter by status', () => {
    const status = randomItem(['new', 'working', 'qualified']);
    const r = http.get(`${BASE}/api/v1/crm/leads?limit=50&status=${status}`, { headers: headers() });
    const ok = check(r, { '200': (res) => res.status === 200 });
    errors.add(!ok);
  });
}
