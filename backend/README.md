# MiniCart API

Auth and product catalog service: signup/login, short-lived JWT access tokens, rotated refresh tokens, roles, Redis rate limits, and cached product listings.

## Run locally

1. Start dependencies: `docker compose up -d`
2. Apply the schemas: `psql "$DATABASE_URL" -f sql/001_auth.sql`, `psql "$DATABASE_URL" -f sql/002_catalog.sql`, `psql "$DATABASE_URL" -f sql/003_cart.sql`, `psql "$DATABASE_URL" -f sql/004_orders.sql`, `psql "$DATABASE_URL" -f sql/005_search.sql`, `psql "$DATABASE_URL" -f sql/006_payments.sql`, and `psql "$DATABASE_URL" -f sql/007_processed_webhook_events.sql` (or run them from your database client). With Docker Compose, the local fallback is `postgres://minicart:minicart@localhost:5432/minicart`.
	You can apply all migrations in order with `npm run migrate`.
3. Copy `.env.example` to `.env` and set the required database, Redis, JWT, and Stripe test-mode values.
4. Start the API: `npm run dev`

Routes include `GET /products` with cursor pagination and filters (`q`, `categoryId`, `minPrice`, `maxPrice`, `sort`, `limit`, `cursor`), plus admin-only category/product writes. Use `sort=relevance` with `q` for ranked results.

The complete versioned API is also available under `/api`:

- Auth: `POST /api/auth/signup`, `/login`, `/refresh`, `/logout`
- Products: `GET /api/products`, `GET /api/products/:id`, admin `POST`, `PUT`, and `DELETE /api/products`
- Cart: `GET /api/cart`, `POST /api/cart/items`, `PATCH` and `DELETE /api/cart/items/:productId`
- Orders: `POST /api/orders` with `Idempotency-Key`, `GET /api/orders`, `GET /api/orders/:id`
- Payments: `POST /api/payments/create-intent`, `POST /api/payments/webhook`

Product listing accepts both the original cursor form and `page` plus `limit` compatibility parameters. Cursor pagination remains the preferred form for large catalogs.

Product listings use cursor pagination because offset pagination must scan and discard increasingly many rows as the offset grows, degrading on large tables. Cursors use the selected sort value plus product ID as a stable tie-breaker.

The catalog has composite and supporting indexes, including `(category_id, price, id)` for category and price filtering. In a production resume, report the measured before/after query plan numbers rather than inventing them: `added composite index on (category_id, price) cutting query time from Xms to Yms`.

Product search uses PostgreSQL full-text search with a stored English `tsvector` and GIN index. This avoids `LIKE '%query%'`, which generally cannot use a normal B-tree index and degrades toward a table scan as the catalog grows. Search terms use `websearch_to_tsquery`, and `sort=relevance` uses `ts_rank`.

Listing responses are cached in Redis for 300 seconds (five minutes). Cache keys hash the complete filter object, including category, price range, search, pagination, and sort. Product creation and price/stock updates increment the catalog cache version, immediately invalidating older listing keys.

Cart routes are authenticated and server-side: `GET /cart`, `POST /cart/items/:productId`, `PATCH /cart/items/:productId`, `DELETE /cart/items/:productId`, and `POST /cart/checkout/validate`. Add/update operations lock the product row and validate available stock. Checkout validation locks the current product rows again, because inventory may change after an item was added.

Order placement is `POST /orders` with an `Idempotency-Key` header. It creates the order, deducts inventory, writes order items, clears the cart, and stores the replay response in one PostgreSQL transaction. Inventory uses optimistic locking: `UPDATE products SET stock_quantity = stock_quantity - quantity, version = version + 1 WHERE id = $id AND version = $version AND stock_quantity >= quantity`. A failed update returns `409` without creating an order. Repeating the same key replays the original response; reusing it with a different request is rejected.

Order statuses are `pending -> paid -> shipped -> delivered`, with cancellation allowed from `pending` or `paid`. Admin transitions use `PATCH /admin/orders/:id/status`.

Stripe test-mode payments use `POST /orders/:id/payment-session` to create a server-side Checkout Session. The backend does not trust a browser success callback: Stripe sends `payment_intent.succeeded` to `POST /payments/stripe/webhook`, where the raw payload signature is verified with `STRIPE_WEBHOOK_SECRET` before the order moves from `pending` to `paid`. Webhook event IDs are stored to make duplicate deliveries idempotent.

For local testing, run `stripe listen --forward-to localhost:3000/payments/stripe/webhook` and copy the emitted `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.

Successful orders write an `order.created` event to a PostgreSQL outbox in the same transaction. Run `npm run publisher` to forward durable outbox messages to RabbitMQ, then run `npm run worker` to consume them for confirmation-email and analytics side effects. The publisher uses broker confirms and marks an event only after RabbitMQ acknowledges it, so a crash can cause a duplicate but not a lost event; consumers should therefore remain idempotent.

Background process configuration is intentionally scoped: `npm run worker` needs RabbitMQ settings, while `npm run publisher` needs RabbitMQ and `DATABASE_URL`. The API needs the full `.env` configuration. Do not commit `.env`; use `.env.example` as the template.

Refresh tokens are returned to the client for this first API slice. A browser client should move them to an `HttpOnly`, `Secure`, `SameSite` cookie before production use.