import { DbConnection } from '/module_bindings/index.js';

const SPACETIMEDB_URI = window.GRIDFORGOOD_URI ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = window.GRIDFORGOOD_DB_NAME ?? 'hack';
const DONATED_KEY = 'gridforgood_donated_chunks';

const RESET_GRID_DEFAULTS = {
	cols: 40,
	rows: 40,
	maxIterations: 500,
	reMin: -2.0,
	reMax: 1.0,
	imMin: -1.2,
	imMax: 1.2,
};

const toggleButton = document.getElementById('toggle-compute');
const resetGridButton = document.getElementById('reset-grid');
const donatedChunksEl = document.getElementById('donated-chunks');
const nodeIdEl = document.getElementById('node-id');
const statusEl = document.getElementById('status');

const worker = new Worker(new URL('./worker.js', import.meta.url), {
	type: 'module',
});

let enabled = false;
let conn = null;
let myIdentityHex = '';
const activeChunkIds = new Set();

function unwrapOption(value) {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === 'object' && 'tag' in value) {
		if (value.tag === 'some' || value.tag === 'Some') {
			return value.value;
		}
		return undefined;
	}

	if (typeof value === 'object' && 'some' in value) {
		return value.some;
	}

	return value;
}

function getDonatedCount() {
	const value = Number.parseInt(localStorage.getItem(DONATED_KEY) ?? '0', 10);
	return Number.isNaN(value) ? 0 : value;
}

function setDonatedCount(next) {
	localStorage.setItem(DONATED_KEY, `${next}`);
	donatedChunksEl.textContent = `${next}`;
}

function setStatus(message) {
	statusEl.textContent = message;
}

function maybeClaimWork() {
	if (!conn || !enabled) {
		return;
	}
	try {
		conn.reducers.requestWork();
	} catch {
		conn.reducers.requestWork({});
	}
}

function processChunkIfMine(row) {
	if (!enabled || !conn) {
		return;
	}

	const assignedNode = unwrapOption(row.assignedNode);
	if (!assignedNode) {
		return;
	}

	const assignedToMe = assignedNode.toHexString() === myIdentityHex;
	if (!assignedToMe || row.status !== 'processing') {
		return;
	}

	const chunkId = row.chunkId.toString();
	if (activeChunkIds.has(chunkId)) {
		return;
	}

	activeChunkIds.add(chunkId);
	setStatus(`Computing chunk #${chunkId} in background worker...`);
	worker.postMessage({
		type: 'compute',
		payload: {
			chunkId,
			minRe: row.minRe,
			maxRe: row.maxRe,
			minIm: row.minIm,
			maxIm: row.maxIm,
			width: Number(row.width),
			height: Number(row.height),
			maxIterations: Number(row.maxIterations),
		},
	});
}

worker.onmessage = event => {
	const { type, payload } = event.data ?? {};

	if (type === 'chunk-computed' && conn) {
		try {
			const pixelData = JSON.stringify(payload.pixels);
			conn.reducers.submitResult({
				chunkId: BigInt(payload.chunkId),
				pixelData,
			});
		} catch (error) {
			console.error('submit_result failed:', error);
			setStatus(`submit_result failed for chunk #${payload.chunkId}. Check console.`);
		}

		activeChunkIds.delete(payload.chunkId);
		const nextDonated = getDonatedCount() + 1;
		setDonatedCount(nextDonated);
		setStatus(`Submitted chunk #${payload.chunkId}. Requesting more work...`);
		maybeClaimWork();
		return;
	}

	if (type === 'worker-error') {
		console.error('Worker error:', payload.message);
		setStatus('Worker error. See console for details.');
	}
};

function startHeartbeat() {
	window.setInterval(() => {
		if (enabled && conn) {
			conn.reducers.heartbeat({});
		}
	}, 4000);
}

function connect() {
	DbConnection.builder()
		.withUri(SPACETIMEDB_URI)
		.withDatabaseName(DB_NAME)
		.onConnect(connection => {
			conn = connection;
			window.gridConn = connection;
			myIdentityHex = connection.identity?.toHexString() ?? '';
			nodeIdEl.textContent = myIdentityHex ? `${myIdentityHex.slice(0, 12)}...` : 'unknown';

			connection.db.chunkQueue.onInsert((_ctx, row) => processChunkIfMine(row));
			connection.db.chunkQueue.onUpdate((_ctx, _oldRow, row) => processChunkIfMine(row));

			const sweepExistingAssignments = () => {
				for (const row of connection.db.chunkQueue.iter()) {
					processChunkIfMine(row);
				}
			};

			const subscription = connection.subscriptionBuilder().onApplied(() => {
					setStatus('Connected and subscribed. Ready to donate compute.');
					sweepExistingAssignments();
					if (enabled) {
						maybeClaimWork();
					}
				});

			if (typeof subscription.subscribeToAllTables === 'function') {
				subscription.subscribeToAllTables();
			} else if (typeof subscription.subscribeToAll === 'function') {
				subscription.subscribeToAll();
			} else {
				subscription.subscribe(['SELECT * FROM chunk_queue', 'SELECT * FROM node_status']);
			}

			window.setInterval(() => {
				if (!enabled || !conn) {
					return;
				}
				sweepExistingAssignments();
				if (activeChunkIds.size === 0) {
					maybeClaimWork();
				}
			}, 1500);
		})
		.onDisconnect(() => {
			setStatus('Disconnected from SpaceTimeDB.');
		})
		.onConnectError((_ctx, err) => {
			console.error('Widget connection error:', err);
			setStatus('Failed to connect to SpaceTimeDB.');
		})
		.build();
}

toggleButton.addEventListener('click', () => {
	enabled = !enabled;
	toggleButton.textContent = enabled
		? 'Disable Donate Compute'
		: 'Enable Donate Compute';

	if (enabled) {
		setStatus('Donate Compute enabled. Requesting work...');
		maybeClaimWork();
	} else {
		setStatus('Donate Compute paused.');
	}
});

resetGridButton.addEventListener('click', () => {
	if (!conn) {
		setStatus('Cannot reset grid: not connected yet.');
		return;
	}

	try {
		conn.reducers.resetGrid(RESET_GRID_DEFAULTS);
		setStatus('reset_grid submitted.');
	} catch (error) {
		console.error('reset_grid failed:', error);
		setStatus('reset_grid failed. Check console.');
	}
});

setDonatedCount(getDonatedCount());
startHeartbeat();
connect();
