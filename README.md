## GridForGood

Distributed browser compute MVP for a hackathon sponsor track using SpaceTimeDB.

Visitors opt in from a widget embedded on a fake news page. Their browser computes Mandelbrot chunks in a background worker and submits results to SpaceTimeDB. A live dashboard paints chunks in real time.

## Architecture

- Hub: SpaceTimeDB module in TypeScript (state + reducers + pub/sub)
- Volunteer Node: Browser page + Web Worker + optional WASM fast path
- Observer Dashboard: Canvas renderer subscribed to chunk queue updates

## Directory Structure

```text
my-project/
  spacetimedb/
    src/
      index.ts                 # Chunk queue + reducers (request_work, submit_result, heartbeat)
  src/
    main.ts                    # Tiny local dev connection check
    assembly/
      index.ts                 # AssemblyScript Mandelbrot kernel sample
    client/
      dashboard/
        index.html             # Live judge dashboard shell
        dashboard.js           # Canvas painter + metrics
      image-render/
        index.html             # Fake blog + donate compute widget
        widget.js              # Reducer calls + worker lifecycle + localStorage transparency counter
        worker.js              # Mandelbrot compute loop (WASM first, JS fallback)
      wasm/
        math.wasm              # Provided by task giver or your AS build output
    module_bindings/
      ...                      # Generated client bindings (do not edit manually)
```

## SpaceTimeDB Data Model

- `chunk_queue`
  - `chunkId` (u64 pk)
  - `status` (`pending | processing | completed`)
  - `assignedNode` (identity, optional)
  - tile placement + complex plane bounds + `pixelData`
- `node_status`
  - `nodeId` (identity pk)
  - `donatedChunks`
  - `lastSeenMicros`

## Reducers

- `request_work()`
  - Keeps node heartbeat fresh
  - Assigns one pending chunk to caller as processing
- `submit_result({ chunkId, pixelData })`
  - Verifies caller owns assigned chunk
  - Marks chunk completed and stores pixel payload
- `heartbeat()`
  - Updates node last seen for active node metric

## Local Dev Runbook

1. Start SpaceTimeDB server.

```bash
spacetime start
```

2. Publish the module locally.

```bash
spacetime publish gridforgood --clear-database -y --module-path spacetimedb
```

3. Generate bindings after schema/reducer changes.

```bash
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb
```

4. Serve `src` (not `src/client`) with any static file server.

```bash
npx serve src -l 4173
```

5. Open pages.

- Widget: `http://localhost:4173/client/image-render/index.html`
- Dashboard: `http://localhost:4173/client/dashboard/index.html`

If you serve `src/client` directly, `/module_bindings/index.js` will be unreachable and compute/dashboard logic will fail to initialize.

6. Optional: set globals before scripts for non-default target.

```html
<script>
  window.GRIDFORGOOD_URI = 'ws://localhost:3000';
  window.GRIDFORGOOD_DB_NAME = 'gridforgood';
</script>
```

## Hackathon Priority Notes

- Keep chunk payload simple: JSON string for pixel RGBA array is enough for demo speed.
- Use WASM if ready; JS fallback already works.
- Do not add auth/distributed consensus in this MVP phase.
