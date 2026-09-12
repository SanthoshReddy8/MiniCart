const axios = require('axios');

const API_URL = process.env.API_URL || 'http://localhost:4000';
const PRODUCT_ID = process.env.PRODUCT_ID;
const TOKENS = (process.env.TOKENS || '').split(',').map((token) => token.trim()).filter(Boolean);
const REQUEST_COUNT = Number(process.env.REQUEST_COUNT || 20);

if (!PRODUCT_ID || TOKENS.length !== REQUEST_COUNT) {
  console.error(`Usage: PRODUCT_ID=<uuid> TOKENS=<token1,token2,...,token${REQUEST_COUNT}> npm run test:concurrency`);
  process.exit(1);
}

async function placeOrder(token, index, runId) {
  try {
    const response = await axios.post(`${API_URL}/api/orders`, {}, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': `concurrency-${runId}-${index}`
      },
      validateStatus: () => true
    });
    return { status: response.status, data: response.data };
  } catch (error) {
    return { status: error.response?.status ?? 0, data: error.response?.data ?? { error: error.message } };
  }
}

async function testConcurrentCheckout() {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const results = await Promise.all(TOKENS.map((token, index) => placeOrder(token, index, runId)));
  const succeeded = results.filter((result) => result.status === 201).length;
  const conflicted = results.filter((result) => result.status === 409).length;
  const other = results.filter((result) => result.status !== 201 && result.status !== 409);

  console.log(`Requests: ${results.length}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Conflicted (409): ${conflicted}`);
  if (other.length) console.log(`Unexpected statuses: ${other.map((result) => result.status).join(', ')}`);
  console.log(`Expected: exactly 1 succeeded and ${REQUEST_COUNT - 1} conflicted`);

  if (succeeded !== 1 || conflicted !== REQUEST_COUNT - 1 || other.length !== 0) {
    console.error('FAIL: concurrency invariant was not satisfied; inspect the response details above.');
    process.exitCode = 1;
    return;
  }
  console.log('PASS: one unit of stock produced exactly one order and zero overselling.');
}

testConcurrentCheckout().catch((error) => {
  console.error('Concurrency test failed:', error);
  process.exitCode = 1;
});