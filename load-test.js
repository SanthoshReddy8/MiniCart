import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

export const options = {
  vus: 50,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500']
  }
};

export default function () {
  const response = http.get(`${BASE_URL}/api/products?category=electronics&page=1&limit=20`);
  check(response, {
    'status is 200': (result) => result.status === 200,
    'response is JSON': (result) => result.headers['Content-Type']?.includes('application/json'),
    'cache header is present': (result) => result.headers['X-Cache'] === 'HIT' || result.headers['X-Cache'] === 'MISS'
  });
  sleep(0.1);
}