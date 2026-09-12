# MiniCart Ecommerce

## Structure

- `backend/` TypeScript API, PostgreSQL migrations, RabbitMQ publisher, and worker
- `frontend/` React/Vite client
- `docker-compose.yml` PostgreSQL, Redis, RabbitMQ, API, worker, publisher, and frontend

## Local development

1. Copy `.env.example` to `.env` and set the Stripe test values.
2. Start infrastructure: `docker compose up -d postgres redis rabbitmq`.
3. Run the API from `backend/`: `npm run dev` on port 3000 locally. The Docker API listens on port 4000.
4. Run the event publisher and worker from `backend/`: `npm run publisher` and `npm run worker`.
5. Run the client from `frontend/`: `npm run dev`.

Docker endpoints: frontend at `http://localhost`, API at `http://localhost:4000`, and RabbitMQ management at `http://localhost:15672`.

To demonstrate the optimistic-locking checkout invariant, prepare 20 different users with the same one-unit product in their carts, collect their access tokens, set the product stock to `1`, then run from `backend/`:

```cmd
set PRODUCT_ID=<product-uuid>
set TOKENS=<token1,token2,...,token20>
npm run test:concurrency
```

The test sends all 20 orders concurrently and exits successfully only when exactly one returns `201` and the other 19 return `409`, demonstrating zero overselling.

For product-list load testing, install k6 and run from the repository root:

```cmd
k6 run load-test.js
```

The script uses 50 virtual users for 30 seconds against `/api/products`, checks HTTP success and Redis cache headers, and requires less than 1% request failures with a 95th-percentile latency below 500 ms. Override the target with `k6 run -e BASE_URL=http://localhost:4000 load-test.js`.