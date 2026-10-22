# Sitegeist Landing Page

Email signup landing page with backend storage and Three.js orb animation.

## Quick Start

```bash
npm install
npm run dev          # Backend on :3000, Frontend on :8080
npm run build        # Build for production
npm run deploy       # Deploy to production server
```

## Project Structure

```
site/
├── src/
│   ├── backend/
│   │   ├── server.ts          # Express server with signup endpoint
│   │   └── storage.ts         # FileStore for email storage
│   ├── frontend/
│   │   ├── index.html         # Landing page with orb animation
│   │   ├── main.ts            # Form handling & rotating taglines
│   │   └── OrbAnimation.ts    # Three.js orb animation
│   └── shared/
│       └── types.ts           # Shared TypeScript types
├── infra/
│   ├── docker-compose.yml     # Production Docker setup
│   └── vite.config.ts         # Vite configuration
└── data/
    └── signups.json           # Email signups (created at runtime)
```

## Development

```bash
./run.sh dev
```

Starts backend API (`:3000`) and Vite dev server (`:8080`) with hot reload.

## Production

```bash
./run.sh build      # Build frontend + backend
./run.sh prod       # Start Docker containers locally
./run.sh stop       # Stop containers
./run.sh logs       # View logs
```

## Deployment

```bash
./run.sh deploy
```

Builds, syncs to `slayer.marioslab.io:/home/badlogic/sitegeist.ai`, restarts services via Docker, and streams logs.

Additional commands:
- `./run.sh sync` - Sync files without restart
- `./run.sh logs-remote` - Stream remote logs

## API Pattern

Uses type-safe API pattern with auto-generated client/server code:
- **`src/shared/api.ts`** - API interface and route definitions (single source of truth)
- **`src/frontend/api-client.ts`** - Auto-generated client (creates typed fetch calls)
- **`src/backend/api-server.ts`** - Auto-generated Express routes
- **`src/backend/handlers.ts`** - Business logic implementing the API interface

Adding a new endpoint only requires:
1. Add method to `Api` interface in `api.ts`
2. Add route definition to `apiRoutes` map
3. Implement handler in `handlers.ts`

Client/server code is automatically generated from these definitions.

## Tech Stack

- **Frontend:** Vite, TypeScript, Tailwind CSS v4, Three.js
- **Backend:** Express, TypeScript, CORS, FileStore (JSON-based storage)
- **Deployment:** Docker, rsync
