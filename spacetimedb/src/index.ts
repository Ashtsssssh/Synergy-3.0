import { SenderError, schema, table, t } from 'spacetimedb/server';

const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 960;
const DEFAULT_GRID_COLS = 40;
const DEFAULT_GRID_ROWS = 40;
const DEFAULT_MAX_ITERATIONS = 1200;
const DEFAULT_RE_MIN = -2.2;
const DEFAULT_RE_MAX = 1.2;
const DEFAULT_IM_MIN = -1.6;
const DEFAULT_IM_MAX = 1.6;

const ChunkQueue = table(
  {
    name: 'chunk_queue',
    public: true,
    indexes: [
      {
        accessor: 'chunk_queue_by_status',
        algorithm: 'btree',
        columns: ['status'],
      },
      {
        accessor: 'chunk_queue_by_assigned_node',
        algorithm: 'btree',
        columns: ['assignedNode'],
      },
    ],
  },
  {
    chunkId: t.u64().primaryKey().autoInc(),
    status: t.string(),
    assignedNode: t.identity().optional(),
    tileX: t.u32(),
    tileY: t.u32(),
    minRe: t.f64(),
    maxRe: t.f64(),
    minIm: t.f64(),
    maxIm: t.f64(),
    width: t.u32(),
    height: t.u32(),
    maxIterations: t.u32(),
    pixelData: t.string().optional(),
    updatedAtMicros: t.u64(),
  }
);

const NodeStatus = table(
  {
    name: 'node_status',
    public: true,
    indexes: [
      {
        accessor: 'node_status_by_last_seen_micros',
        algorithm: 'btree',
        columns: ['lastSeenMicros'],
      },
    ],
  },
  {
    nodeId: t.identity().primaryKey(),
    donatedChunks: t.u64(),
    lastSeenMicros: t.u64(),
  }
);

const GridConfig = table(
  {
    name: 'grid_config',
    public: true,
  },
  {
    id: t.u32().primaryKey(),
    cols: t.u32(),
    rows: t.u32(),
    maxIterations: t.u32(),
    reMin: t.f64(),
    reMax: t.f64(),
    imMin: t.f64(),
    imMax: t.f64(),
    imageWidth: t.u32(),
    imageHeight: t.u32(),
    updatedAtMicros: t.u64(),
  }
);

const spacetimedb = schema({
  chunkQueue: ChunkQueue,
  nodeStatus: NodeStatus,
  gridConfig: GridConfig,
});

export default spacetimedb;

function markNodeAlive(ctx: any): void {
  const nowMicros = ctx.timestamp.microsSinceUnixEpoch;
  const existingNode = ctx.db.nodeStatus.nodeId.find(ctx.sender);

  if (existingNode) {
    ctx.db.nodeStatus.nodeId.update({
      ...existingNode,
      lastSeenMicros: nowMicros,
    });
    return;
  }

  ctx.db.nodeStatus.insert({
    nodeId: ctx.sender,
    donatedChunks: 0n,
    lastSeenMicros: nowMicros,
  });
}

function clearChunkQueue(ctx: any): void {
  const chunkIds: bigint[] = [];
  for (const row of ctx.db.chunkQueue.iter()) {
    chunkIds.push(row.chunkId);
  }

  for (const chunkId of chunkIds) {
    ctx.db.chunkQueue.chunkId.delete(chunkId);
  }
}

function seedChunkQueue(
  ctx: any,
  config: {
    cols: number;
    rows: number;
    maxIterations: number;
    reMin: number;
    reMax: number;
    imMin: number;
    imMax: number;
  }
): void {
  clearChunkQueue(ctx);

  const tileWidth = Math.floor(IMAGE_WIDTH / config.cols);
  const tileHeight = Math.floor(IMAGE_HEIGHT / config.rows);
  const reStep = (config.reMax - config.reMin) / config.cols;
  const imStep = (config.imMax - config.imMin) / config.rows;

  for (let tileY = 0; tileY < config.rows; tileY += 1) {
    for (let tileX = 0; tileX < config.cols; tileX += 1) {
      const chunkMinRe = config.reMin + tileX * reStep;
      const chunkMaxRe = chunkMinRe + reStep;
      const chunkMaxIm = config.imMax - tileY * imStep;
      const chunkMinIm = chunkMaxIm - imStep;

      ctx.db.chunkQueue.insert({
        chunkId: 0n,
        status: 'pending',
        assignedNode: undefined,
        tileX,
        tileY,
        minRe: chunkMinRe,
        maxRe: chunkMaxRe,
        minIm: chunkMinIm,
        maxIm: chunkMaxIm,
        width: tileWidth,
        height: tileHeight,
        maxIterations: config.maxIterations,
        pixelData: undefined,
        updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
      });
    }
  }
}

function upsertGridConfig(
  ctx: any,
  config: {
    cols: number;
    rows: number;
    maxIterations: number;
    reMin: number;
    reMax: number;
    imMin: number;
    imMax: number;
  }
): void {
  const existing = ctx.db.gridConfig.id.find(1);
  const next = {
    id: 1,
    cols: config.cols,
    rows: config.rows,
    maxIterations: config.maxIterations,
    reMin: config.reMin,
    reMax: config.reMax,
    imMin: config.imMin,
    imMax: config.imMax,
    imageWidth: IMAGE_WIDTH,
    imageHeight: IMAGE_HEIGHT,
    updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
  };

  if (existing) {
    ctx.db.gridConfig.id.update(next);
    return;
  }

  ctx.db.gridConfig.insert(next);
}

export const init = spacetimedb.init(ctx => {
  let hasSeedData = false;
  for (const _row of ctx.db.chunkQueue.iter()) {
    hasSeedData = true;
    break;
  }

  if (hasSeedData) {
    return;
  }

  const defaultConfig = {
    cols: DEFAULT_GRID_COLS,
    rows: DEFAULT_GRID_ROWS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    reMin: DEFAULT_RE_MIN,
    reMax: DEFAULT_RE_MAX,
    imMin: DEFAULT_IM_MIN,
    imMax: DEFAULT_IM_MAX,
  };

  upsertGridConfig(ctx, defaultConfig);
  seedChunkQueue(ctx, defaultConfig);
});

export const onConnect = spacetimedb.clientConnected(ctx => {
  markNodeAlive(ctx);
});

export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {
  // Keep status row; dashboard decides active nodes using a last-seen window.
});

export const heartbeat = spacetimedb.reducer(ctx => {
  markNodeAlive(ctx);
});

export const request_work = spacetimedb.reducer(ctx => {
  markNodeAlive(ctx);

  for (const inFlight of ctx.db.chunkQueue.chunk_queue_by_assigned_node.filter(
    ctx.sender
  )) {
    if (inFlight.status === 'processing') {
      return;
    }
  }

  for (const chunk of ctx.db.chunkQueue.chunk_queue_by_status.filter('pending')) {
    ctx.db.chunkQueue.chunkId.update({
      ...chunk,
      status: 'processing',
      assignedNode: ctx.sender,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    return;
  }
});

export const submit_result = spacetimedb.reducer(
  {
    chunkId: t.u64(),
    pixelData: t.string(),
  },
  (ctx, { chunkId, pixelData }) => {
    markNodeAlive(ctx);

    const chunk = ctx.db.chunkQueue.chunkId.find(chunkId);
    if (!chunk) {
      throw new SenderError('Chunk does not exist.');
    }

    if (chunk.status !== 'processing') {
      throw new SenderError('Chunk is not in processing state.');
    }

    if (!chunk.assignedNode || chunk.assignedNode.toHexString() !== ctx.sender.toHexString()) {
      throw new SenderError('Chunk is assigned to another node.');
    }

    ctx.db.chunkQueue.chunkId.update({
      ...chunk,
      status: 'completed',
      pixelData,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });

    const node = ctx.db.nodeStatus.nodeId.find(ctx.sender);
    if (!node) {
      ctx.db.nodeStatus.insert({
        nodeId: ctx.sender,
        donatedChunks: 1n,
        lastSeenMicros: ctx.timestamp.microsSinceUnixEpoch,
      });
      return;
    }

    ctx.db.nodeStatus.nodeId.update({
      ...node,
      donatedChunks: node.donatedChunks + 1n,
      lastSeenMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
);

export const reset_grid = spacetimedb.reducer(
  {
    cols: t.u32(),
    rows: t.u32(),
    maxIterations: t.u32(),
    reMin: t.f64(),
    reMax: t.f64(),
    imMin: t.f64(),
    imMax: t.f64(),
  },
  (ctx, { cols, rows, maxIterations, reMin, reMax, imMin, imMax }) => {
    if (cols < 2 || rows < 2) {
      throw new SenderError('cols and rows must be >= 2');
    }

    if (cols > 200 || rows > 200) {
      throw new SenderError('cols and rows must be <= 200');
    }

    if (maxIterations < 100 || maxIterations > 10000) {
      throw new SenderError('maxIterations must be between 100 and 10000');
    }

    if (reMax <= reMin || imMax <= imMin) {
      throw new SenderError('Invalid complex plane bounds.');
    }

    const nextConfig = {
      cols,
      rows,
      maxIterations,
      reMin,
      reMax,
      imMin,
      imMax,
    };

    upsertGridConfig(ctx, nextConfig);
    seedChunkQueue(ctx, nextConfig);
  }
);
