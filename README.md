# AgroERP — Backend CRM

PERN-stack API for the AgroERP ecosystem: **Fastify + PostgreSQL + Node.js + Redis**, with a **GraphQL** API (Mercurius) and **AWS** utilities (S3 document storage, SES email).

> **Current phase scope: User & Role Management only** (PRD §2, §4.1) — auth, user CRUD, branches, and the role permission matrix. Other modules will be added later.

> The database schema is hand-maintained in [`database.sql`](./database.sql) — the single source of truth (no ORM). It currently contains only the user-management tables.

## Stack

| Concern | Choice |
| --- | --- |
| HTTP server | Fastify 5 |
| API | GraphQL via Mercurius (`/graphql`, GraphiQL in dev) + a few REST routes |
| Database | PostgreSQL (raw SQL via `pg`) |
| Cache / sessions / queues | Redis (`ioredis`) |
| Auth | JWT (`@fastify/jwt`), bcrypt password hashing |
| Storage / email | AWS S3 + SES (`@aws-sdk/*`) |
| Security | `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit` |

## Project structure

```
Backend_CRM/
├── database.sql            # full PostgreSQL schema (source of truth)
├── package.json
├── .env.example
├── scripts/
│   ├── db-setup.js         # apply database.sql
│   └── seed.js             # seed Super Admin + demo products
└── src/
    ├── server.js           # bootstrap + graceful shutdown
    ├── app.js              # Fastify assembly (plugins, GraphQL, routes)
    ├── config/env.js       # validated env config
    ├── db/index.js         # pg pool + query/transaction helpers
    ├── plugins/            # db, redis, auth (JWT/RBAC)
    ├── graphql/            # schema, resolvers, context
    ├── routes/             # health, S3 presigned uploads
    └── utils/aws.js        # S3 + SES helpers
```

## Getting started

```bash
cd Backend_CRM
cp .env.example .env          # then fill in DATABASE_URL, JWT_SECRET, AWS_*
npm install

# Create the schema and seed a login
npm run db:setup
npm run db:seed               # admin@agroerp.example / Admin@123 (+ demo users & branches)

npm run dev                   # nodemon → http:.//localhost:4000  (GraphiQL at /graphiql)
```

> `npm run dev` uses **nodemon** (config in [`nodemon.json`](./nodemon.json)) — it watches `src/` and restarts on change.

Requires a running **PostgreSQL** and **Redis** locally (or update the URLs in `.env`).

## Key endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /graphql` | Main API (queries + mutations) |
| `GET  /graphiql` | Interactive GraphQL IDE (dev only) |
| `GET  /health` | Liveness |
| `GET  /ready` | Readiness (checks DB + Redis) |
| `POST /uploads/presign` | Presigned S3 upload URL (auth required) |

### Example: log in via GraphQL

```graphql
mutation {
  login(email: "admin@agroerp.example", password: "Admin@123") {
    accessToken
    user { id name role }
  }
}
```

Send the `accessToken` as `Authorization: Bearer <token>` on subsequent requests.

## GraphQL surface (this phase)

| Operation | Type | Notes |
| --- | --- | --- |
| `login` / `refreshToken` | mutation | JWT auth |
| `me` | query | current user |
| `users` / `user` / `userStats` | query | list (search + role filter), detail, counts |
| `branches` / `rolePermissions` | query | lookups for the matrix |
| `createUser` / `updateUser` | mutation | create & edit (SUPER_ADMIN/ADMIN) |
| `setUserActive` | mutation | activate / deactivate (can't self-deactivate) |
| `resetUserPassword` | mutation | admin password reset |
| `createBranch` | mutation | add a branch |

All write/admin operations are role-guarded and recorded in `activity_logs`.

## Notes

- AWS S3/SES utilities (`src/utils/aws.js`) and the presigned-upload routes are
  in place for later modules; Gemini, OpenWeather, Razorpay, MSG91 keys remain
  placeholders in `.env` for later PRD phases (§12).
