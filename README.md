# MiniCart

A full-stack ecommerce backend built to explore real-world engineering problems that most CRUD-style ecommerce tutorials skip: concurrency-safe inventory, idempotent payments, caching, and async order processing — with every performance and correctness claim backed by an actual test run, not an estimate.


## Features

- **Auth** — JWT access/refresh tokens, bcrypt password hashing, role-based access control
- **Product catalog** — pagination, filtering, sorting, indexed queries
- **Cart** — persisted server-side per user
- **Order placement** — transactional, with optimistic locking on inventory to prevent overselling
- **Idempotent checkout** — duplicate requests (client retries, double-clicks) never create duplicate orders
- **Payments** — Stripe integration with signature-verified webhooks (payment confirmation never trusts the client)
- **Caching** — Redis cache-aside pattern for product listings
- **Async processing** — RabbitMQ-based order events, consumed by a separate notification worker
- **Rate limiting** — Redis-backed login throttling to mitigate brute-force attempts

## Architecture

```
React client → API layer (Node/Express) → PostgreSQL (orders, inventory)
                                         → Redis (cache, rate limiting)
                                         → RabbitMQ → Notification worker
                                         → Stripe (payments, webhooks)
```

Fully containerized with Docker Compose — backend, notification worker, frontend, Postgres, Redis, and RabbitMQ all run with a single command.

## Tech stack

Node.js, Express, PostgreSQL, Redis, RabbitMQ, Stripe, React, Docker, Vitest, k6

## Verified results

Every number below comes from a real test run in this repo, not a projection — see `/test` for the scripts.

| Claim | How it was tested | Result |
|---|---|---|
| No overselling under concurrent checkout | 20 simultaneous requests against 1 unit of stock | 1 succeeded, 19 correctly rejected (409) |
| No duplicate orders from retried requests | 3 concurrent requests with the same idempotency key | Exactly 1 order created |
| Cache improves listing latency | Direct request timing, cache miss vs. hit | 37ms (DB) → 1ms (cache), ~8x faster round-trip |
| API holds up under load | k6, 50 virtual users, 30s | 470+ req/s, p95 ~14ms, 0% error rate |
| Core logic is covered by tests | Vitest suite | 9/9 tests passing (orders, catalog, webhooks) |

## Live demo

[Add your deployed URL here once live]

> Note: if hosted on a free-tier service, the first request may take 20-30s to wake the server from sleep. Subsequent requests are fast.

## Getting started (local)

```bash
git clone https://github.com/<your-username>/minicart.git
cd minicart
cp .env.example .env   # fill in DB password, JWT secret, Stripe keys
docker compose up --build
```

- Frontend: `http://localhost`
- API: `http://localhost:4000`
- RabbitMQ management UI: `http://localhost:15672`

## Running the tests

```bash
cd backend
npm test                        # unit + integration tests (Vitest)
npm run test:concurrency:all    # verifies no overselling under load
npm run test:idempotency        # verifies duplicate-request safety
k6 run load-test.js             # load test against the product listing endpoint
```

## Deployment

The project is designed to run identically in Docker Compose locally and on any container-based host. Two options work well for a low-traffic demo deployment:

**Railway** — recommended if you want the demo always warm (no cold starts). Supports Postgres, Redis, and RabbitMQ as one-click services within a single project, wired together with internal networking. Free trial credit covers light traffic; light ongoing usage typically runs a few dollars a month after that.

**Render** — recommended if you want to stay on a free tier. Free web services, free PostgreSQL (90-day expiry, renewable), and free Redis are included. RabbitMQ isn't offered natively — use an external free instance from CloudAMQP and point `RABBITMQ_URL` at it. Free web services sleep after 15 minutes of inactivity, so the first request after idle time will be slow.

Either way, the same Docker images used in `docker-compose.yml` are what get deployed — no separate build config needed beyond environment variables.

## What I'd improve next

- Move Redis cache invalidation from `KEYS`-based deletion to tagged keys per category, for correctness at scale
- Add Elasticsearch for product search instead of SQL filtering
- Add distributed tracing (OpenTelemetry) across the API and worker
- Set up CI with GitHub Actions to run the test suite on every push

## License

MIT
