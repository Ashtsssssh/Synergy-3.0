import { SenderError, schema, table, t } from 'spacetimedb/server';

const IMAGE_WIDTH = 960;
const IMAGE_HEIGHT = 960;

const MANDELBROT_TASK_ID = 1;
const PIN_TASK_ID = 2;

const DEFAULT_GRID_COLS = 40;
const DEFAULT_GRID_ROWS = 40;
const DEFAULT_MAX_ITERATIONS = 1200;
const DEFAULT_RE_MIN = -2.2;
const DEFAULT_RE_MAX = 1.2;
const DEFAULT_IM_MIN = -1.6;
const DEFAULT_IM_MAX = 1.6;

const DEFAULT_PIN_LENGTH = 6;
const DEFAULT_PIN_TOTAL_CANDIDATES = 1000000;
const DEFAULT_PIN_CHUNK_SIZE = 10000;
const MAX_INFLIGHT_CHUNKS_PER_NODE = 4;

const Task = table(
  {
    name: 'task',
    public: true,
    indexes: [
      {
        accessor: 'task_by_request_help',
        algorithm: 'btree',
        columns: ['requestHelp'],
      },
      {
        accessor: 'task_by_active',
        algorithm: 'btree',
        columns: ['isActive'],
      },
    ],
  },
  {
    taskId: t.u32().primaryKey(),
    taskKey: t.string(),
    displayName: t.string(),
    isActive: t.bool(),
    requestHelp: t.bool(),
    updatedAtMicros: t.u64(),
  }
);

const MandelbrotChunkQueue = table(
  {
    name: 'mandelbrot_chunk_queue',
    public: true,
    indexes: [
      {
        accessor: 'mandelbrot_chunk_queue_by_task_id',
        algorithm: 'btree',
        columns: ['taskId'],
      },
      {
        accessor: 'mandelbrot_chunk_queue_by_status',
        algorithm: 'btree',
        columns: ['status'],
      },
      {
        accessor: 'mandelbrot_chunk_queue_by_assigned_node',
        algorithm: 'btree',
        columns: ['assignedNode'],
      },
    ],
  },
  {
    chunkId: t.u64().primaryKey().autoInc(),
    taskId: t.u32(),
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

const PinChunkQueue = table(
  {
    name: 'pin_chunk_queue',
    public: true,
    indexes: [
      {
        accessor: 'pin_chunk_queue_by_task_id',
        algorithm: 'btree',
        columns: ['taskId'],
      },
      {
        accessor: 'pin_chunk_queue_by_status',
        algorithm: 'btree',
        columns: ['status'],
      },
      {
        accessor: 'pin_chunk_queue_by_assigned_node',
        algorithm: 'btree',
        columns: ['assignedNode'],
      },
    ],
  },
  {
    chunkId: t.u64().primaryKey().autoInc(),
    taskId: t.u32(),
    status: t.string(),
    assignedNode: t.identity().optional(),
    rangeStart: t.u32(),
    rangeEnd: t.u32(),
    pinLength: t.u32(),
    targetHash: t.string(),
    foundPin: t.string().optional(),
    updatedAtMicros: t.u64(),
  }
);

const GridConfig = table(
  {
    name: 'grid_config',
    public: true,
  },
  {
    id: t.u32().primaryKey(),
    taskId: t.u32(),
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

const PinCrackConfig = table(
  {
    name: 'pin_crack_config',
    public: true,
  },
  {
    id: t.u32().primaryKey(),
    taskId: t.u32(),
    pinLength: t.u32(),
    targetHash: t.string(),
    totalCandidates: t.u32(),
    chunkSize: t.u32(),
    pinFound: t.string().optional(),
    foundByNode: t.identity().optional(),
    startedAtMicros: t.u64(),
    foundAtMicros: t.u64().optional(),
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

const spacetimedb = schema({
  task: Task,
  mandelbrotChunkQueue: MandelbrotChunkQueue,
  pinChunkQueue: PinChunkQueue,
  gridConfig: GridConfig,
  pinCrackConfig: PinCrackConfig,
  nodeStatus: NodeStatus,
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

function incrementDonatedCount(ctx: any): void {
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

function upsertTask(
  ctx: any,
  taskId: number,
  taskKey: string,
  displayName: string,
  isActive: boolean,
  requestHelp: boolean
): void {
  const existing = ctx.db.task.taskId.find(taskId);
  const next = {
    taskId,
    taskKey,
    displayName,
    isActive,
    requestHelp,
    updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
  };

  if (existing) {
    ctx.db.task.taskId.update(next);
    return;
  }

  ctx.db.task.insert(next);
}

function getTaskOrThrow(ctx: any, taskId: number): any {
  const task = ctx.db.task.taskId.find(taskId);
  if (!task) {
    throw new SenderError('Task does not exist.');
  }
  return task;
}

function clearMandelbrotChunks(ctx: any): void {
  const chunkIds: bigint[] = [];
  for (const row of ctx.db.mandelbrotChunkQueue.iter()) {
    chunkIds.push(row.chunkId);
  }

  for (const chunkId of chunkIds) {
    ctx.db.mandelbrotChunkQueue.chunkId.delete(chunkId);
  }
}

function clearPinChunks(ctx: any): void {
  const chunkIds: bigint[] = [];
  for (const row of ctx.db.pinChunkQueue.iter()) {
    chunkIds.push(row.chunkId);
  }

  for (const chunkId of chunkIds) {
    ctx.db.pinChunkQueue.chunkId.delete(chunkId);
  }
}

function seedMandelbrotChunks(
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
  clearMandelbrotChunks(ctx);

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

      ctx.db.mandelbrotChunkQueue.insert({
        chunkId: 0n,
        taskId: MANDELBROT_TASK_ID,
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

function seedPinChunks(
  ctx: any,
  config: {
    targetHash: string;
    totalCandidates: number;
    chunkSize: number;
    pinLength: number;
  }
): void {
  clearPinChunks(ctx);

  for (
    let rangeStart = 0;
    rangeStart < config.totalCandidates;
    rangeStart += config.chunkSize
  ) {
    const rangeEnd = Math.min(
      config.totalCandidates - 1,
      rangeStart + config.chunkSize - 1
    );

    ctx.db.pinChunkQueue.insert({
      chunkId: 0n,
      taskId: PIN_TASK_ID,
      status: 'pending',
      assignedNode: undefined,
      rangeStart,
      rangeEnd,
      pinLength: config.pinLength,
      targetHash: config.targetHash,
      foundPin: undefined,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
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
    taskId: MANDELBROT_TASK_ID,
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

function upsertPinConfig(
  ctx: any,
  config: {
    targetHash: string;
    totalCandidates: number;
    chunkSize: number;
    pinLength: number;
  }
): void {
  const existing = ctx.db.pinCrackConfig.id.find(1);
  const next = {
    id: 1,
    taskId: PIN_TASK_ID,
    pinLength: config.pinLength,
    targetHash: config.targetHash,
    totalCandidates: config.totalCandidates,
    chunkSize: config.chunkSize,
    pinFound: undefined,
    foundByNode: undefined,
    startedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    foundAtMicros: undefined,
    updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
  };

  if (existing) {
    ctx.db.pinCrackConfig.id.update(next);
    return;
  }

  ctx.db.pinCrackConfig.insert(next);
}

function assignMandelbrotChunk(ctx: any): void {
  let inFlightCount = 0;
  for (const inFlight of ctx.db.mandelbrotChunkQueue.mandelbrot_chunk_queue_by_assigned_node.filter(
    ctx.sender
  )) {
    if (inFlight.status === 'processing') {
      inFlightCount += 1;
      if (inFlightCount >= MAX_INFLIGHT_CHUNKS_PER_NODE) {
        return;
      }
    }
  }

  for (const chunk of ctx.db.mandelbrotChunkQueue.mandelbrot_chunk_queue_by_status.filter('pending')) {
    ctx.db.mandelbrotChunkQueue.chunkId.update({
      ...chunk,
      status: 'processing',
      assignedNode: ctx.sender,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    return;
  }
}

function assignPinChunk(ctx: any): void {
  const pinConfig = ctx.db.pinCrackConfig.id.find(1);
  if (pinConfig?.pinFound) {
    return;
  }

  let inFlightCount = 0;
  for (const inFlight of ctx.db.pinChunkQueue.pin_chunk_queue_by_assigned_node.filter(
    ctx.sender
  )) {
    if (inFlight.status === 'processing') {
      inFlightCount += 1;
      if (inFlightCount >= MAX_INFLIGHT_CHUNKS_PER_NODE) {
        return;
      }
    }
  }

  for (const chunk of ctx.db.pinChunkQueue.pin_chunk_queue_by_status.filter('pending')) {
    ctx.db.pinChunkQueue.chunkId.update({
      ...chunk,
      status: 'processing',
      assignedNode: ctx.sender,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
    return;
  }
}

function resetMandelbrotTaskToPending(ctx: any): void {
  for (const chunk of ctx.db.mandelbrotChunkQueue.iter()) {
    ctx.db.mandelbrotChunkQueue.chunkId.update({
      ...chunk,
      status: 'pending',
      assignedNode: undefined,
      pixelData: undefined,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
}

function resetPinTaskToPending(ctx: any): void {
  for (const chunk of ctx.db.pinChunkQueue.iter()) {
    ctx.db.pinChunkQueue.chunkId.update({
      ...chunk,
      status: 'pending',
      assignedNode: undefined,
      foundPin: undefined,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
  }

  const pinConfig = ctx.db.pinCrackConfig.id.find(1);
  if (pinConfig) {
    ctx.db.pinCrackConfig.id.update({
      ...pinConfig,
      pinFound: undefined,
      foundByNode: undefined,
      foundAtMicros: undefined,
      startedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
}

export const init = spacetimedb.init(ctx => {
  upsertTask(
    ctx,
    MANDELBROT_TASK_ID,
    'mandelbrot',
    'Mandelbrot Rendering',
    true,
    true
  );
  upsertTask(
    ctx,
    PIN_TASK_ID,
    'pin_guess',
    'PIN Guessing',
    true,
    true
  );

  const defaultGrid = {
    cols: DEFAULT_GRID_COLS,
    rows: DEFAULT_GRID_ROWS,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    reMin: DEFAULT_RE_MIN,
    reMax: DEFAULT_RE_MAX,
    imMin: DEFAULT_IM_MIN,
    imMax: DEFAULT_IM_MAX,
  };

  upsertGridConfig(ctx, defaultGrid);

  let hasMandelbrotChunks = false;
  for (const _row of ctx.db.mandelbrotChunkQueue.iter()) {
    hasMandelbrotChunks = true;
    break;
  }
  if (!hasMandelbrotChunks) {
    seedMandelbrotChunks(ctx, defaultGrid);
  }

  const defaultPinConfig = {
    targetHash:
      '4ed8dfd7183bd310f609b89ed2c2e20edcaf0d2aadeb8b3668ab9bb52428874b',
    totalCandidates: DEFAULT_PIN_TOTAL_CANDIDATES,
    chunkSize: DEFAULT_PIN_CHUNK_SIZE,
    pinLength: DEFAULT_PIN_LENGTH,
  };

  upsertPinConfig(ctx, defaultPinConfig);

  let hasPinChunks = false;
  for (const _row of ctx.db.pinChunkQueue.iter()) {
    hasPinChunks = true;
    break;
  }
  if (!hasPinChunks) {
    seedPinChunks(ctx, defaultPinConfig);
  }
});

export const onConnect = spacetimedb.clientConnected(_ctx => {
  // Passive observers should not count as active compute nodes.
});

export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {
  // Keep status row; dashboard decides active nodes using a last-seen window.
});

export const heartbeat = spacetimedb.reducer(ctx => {
  markNodeAlive(ctx);
});

export const set_task_help = spacetimedb.reducer(
  {
    taskId: t.u32(),
    requestHelp: t.bool(),
  },
  (ctx, { taskId, requestHelp }) => {
    const task = getTaskOrThrow(ctx, taskId);
    ctx.db.task.taskId.update({
      ...task,
      requestHelp,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
);

export const set_task_active = spacetimedb.reducer(
  {
    taskId: t.u32(),
    isActive: t.bool(),
  },
  (ctx, { taskId, isActive }) => {
    const task = getTaskOrThrow(ctx, taskId);
    ctx.db.task.taskId.update({
      ...task,
      isActive,
      updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
    });
  }
);

export const reset_task = spacetimedb.reducer(
  {
    taskId: t.u32(),
  },
  (ctx, { taskId }) => {
    const task = getTaskOrThrow(ctx, taskId);

    if (task.taskKey === 'mandelbrot') {
      resetMandelbrotTaskToPending(ctx);
      return;
    }

    if (task.taskKey === 'pin_guess') {
      resetPinTaskToPending(ctx);
      return;
    }

    throw new SenderError('Unsupported task type.');
  }
);

export const request_work = spacetimedb.reducer(
  {
    taskId: t.u32(),
  },
  (ctx, { taskId }) => {
    markNodeAlive(ctx);

    const task = getTaskOrThrow(ctx, taskId);
    if (!task.isActive || !task.requestHelp) {
      return;
    }

    if (task.taskKey === 'mandelbrot') {
      assignMandelbrotChunk(ctx);
      return;
    }

    if (task.taskKey === 'pin_guess') {
      assignPinChunk(ctx);
      return;
    }

    throw new SenderError('Unsupported task type.');
  }
);

export const submit_result = spacetimedb.reducer(
  {
    taskId: t.u32(),
    chunkId: t.u64(),
    resultData: t.string().optional(),
  },
  (ctx, { taskId, chunkId, resultData }) => {
    markNodeAlive(ctx);

    const task = getTaskOrThrow(ctx, taskId);

    if (task.taskKey === 'mandelbrot') {
      if (!resultData) {
        throw new SenderError('Mandelbrot resultData is required.');
      }

      const chunk = ctx.db.mandelbrotChunkQueue.chunkId.find(chunkId);
      if (!chunk) {
        throw new SenderError('Chunk does not exist.');
      }
      if (chunk.status !== 'processing') {
        throw new SenderError('Chunk is not in processing state.');
      }
      if (!chunk.assignedNode || chunk.assignedNode.toHexString() !== ctx.sender.toHexString()) {
        throw new SenderError('Chunk is assigned to another node.');
      }

      ctx.db.mandelbrotChunkQueue.chunkId.update({
        ...chunk,
        status: 'completed',
        pixelData: resultData,
        updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
      });
      incrementDonatedCount(ctx);
      return;
    }

    if (task.taskKey === 'pin_guess') {
      const chunk = ctx.db.pinChunkQueue.chunkId.find(chunkId);
      if (!chunk) {
        throw new SenderError('PIN chunk does not exist.');
      }
      if (chunk.status !== 'processing') {
        throw new SenderError('PIN chunk is not in processing state.');
      }
      if (!chunk.assignedNode || chunk.assignedNode.toHexString() !== ctx.sender.toHexString()) {
        throw new SenderError('PIN chunk is assigned to another node.');
      }

      const foundPin = resultData;
      ctx.db.pinChunkQueue.chunkId.update({
        ...chunk,
        status: 'completed',
        foundPin,
        updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
      });

      const pinConfig = ctx.db.pinCrackConfig.id.find(1);
      if (pinConfig && foundPin && !pinConfig.pinFound) {
        ctx.db.pinCrackConfig.id.update({
          ...pinConfig,
          pinFound: foundPin,
          foundByNode: ctx.sender,
          foundAtMicros: ctx.timestamp.microsSinceUnixEpoch,
          updatedAtMicros: ctx.timestamp.microsSinceUnixEpoch,
        });
      }

      incrementDonatedCount(ctx);
      return;
    }

    throw new SenderError('Unsupported task type.');
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
    seedMandelbrotChunks(ctx, nextConfig);
  }
);

export const reset_pin_crack = spacetimedb.reducer(
  {
    targetHash: t.string(),
  },
  (ctx, { targetHash }) => {
    const normalizedHash = targetHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedHash)) {
      throw new SenderError('targetHash must be a 64-char hex SHA-256 value.');
    }

    const nextConfig = {
      targetHash: normalizedHash,
      totalCandidates: DEFAULT_PIN_TOTAL_CANDIDATES,
      chunkSize: DEFAULT_PIN_CHUNK_SIZE,
      pinLength: DEFAULT_PIN_LENGTH,
    };

    upsertPinConfig(ctx, nextConfig);
    seedPinChunks(ctx, nextConfig);
  }
);
