import { DbConnection } from '/module_bindings/index.js';

const SPACETIMEDB_URI = window.GRIDFORGOOD_URI ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = window.GRIDFORGOOD_DB_NAME ?? 'hack';
const DONATED_KEY = 'gridforgood_pin_donated_chunks';
const DEFAULT_PIN_LENGTH = 6;
const DEFAULT_PIN_TARGET_HASH = '4ed8dfd7183bd310f609b89ed2c2e20edcaf0d2aadeb8b3668ab9bb52428874b';

const toggleButton = document.getElementById('toggle-compute');
const resetPinButton = document.getElementById('reset-pin');
const targetHashEl = document.getElementById('target-hash');
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
let hasAutoInitializedTask = false;
let currentPinLength = DEFAULT_PIN_LENGTH;

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

function maybeClaimPinWork() {
	if (!conn || !enabled) {
		return;
	}

	try {
		conn.reducers.requestPinWork();
	} catch {
		conn.reducers.requestPinWork({});
	}
}

function hasAnyPinChunks(connection) {
	for (const _row of connection.db.pinChunkQueue.iter()) {
		return true;
	}
	return false;
}

function ensurePinTaskInitialized(connection) {
	if (hasAutoInitializedTask) {
		return;
	}

	const config = connection.db.pinCrackConfig.id.find(1);
	const hasChunks = hasAnyPinChunks(connection);
	if (config && hasChunks) {
		targetHashEl.textContent = config.targetHash;
		hasAutoInitializedTask = true;
		return;
	}

	if (typeof connection.reducers.resetPinCrack !== 'function') {
		setStatus('reset_pin_crack reducer not available in current local publish.');
		return;
	}

	try {
		connection.reducers.resetPinCrack({
			targetHash: DEFAULT_PIN_TARGET_HASH,
		});
		targetHashEl.textContent = DEFAULT_PIN_TARGET_HASH;
		hasAutoInitializedTask = true;
		setStatus('Initialized local pin_chunk_queue with default hash.');
	} catch (error) {
		console.error('auto reset_pin_crack failed:', error);
		setStatus('Could not initialize PIN task. Check console.');
	}
}

function processPinChunkIfMine(row) {
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
	setStatus(`Cracking range ${Number(row.rangeStart)}-${Number(row.rangeEnd)}...`);
	worker.postMessage({
		type: 'compute-pin',
		payload: {
			chunkId,
			rangeStart: Number(row.rangeStart),
			rangeEnd: Number(row.rangeEnd),
			pinLength: Number(row.pinLength ?? currentPinLength),
			targetHash: row.targetHash,
		},
	});
}

worker.onmessage = event => {
	const { type, payload } = event.data ?? {};

	if (type === 'pin-chunk-computed' && conn) {
		try {
			conn.reducers.submitPinResult({
				chunkId: BigInt(payload.chunkId),
				foundPin: payload.foundPin ?? undefined,
			});
		} catch (error) {
			console.error('submit_pin_result failed:', error);
			setStatus(`submit_pin_result failed for chunk #${payload.chunkId}. Check console.`);
		}

		activeChunkIds.delete(payload.chunkId);
		setDonatedCount(getDonatedCount() + 1);

		if (payload.foundPin) {
			setStatus(`FOUND PIN ${payload.foundPin}. Result submitted.`);
		} else {
			setStatus(`Checked chunk #${payload.chunkId}. Requesting more ranges...`);
		}

		maybeClaimPinWork();
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
			window.pinConn = connection;
			myIdentityHex = connection.identity?.toHexString() ?? '';
			nodeIdEl.textContent = myIdentityHex ? `${myIdentityHex.slice(0, 12)}...` : 'unknown';

			connection.db.pinChunkQueue.onInsert((_ctx, row) => processPinChunkIfMine(row));
			connection.db.pinChunkQueue.onUpdate((_ctx, _oldRow, row) => processPinChunkIfMine(row));

			connection.db.pinCrackConfig.onInsert((_ctx, row) => {
				targetHashEl.textContent = row.targetHash;
				currentPinLength = Number(row.pinLength ?? DEFAULT_PIN_LENGTH);
			});
			connection.db.pinCrackConfig.onUpdate((_ctx, _oldRow, row) => {
				targetHashEl.textContent = row.targetHash;
				currentPinLength = Number(row.pinLength ?? DEFAULT_PIN_LENGTH);
			});

			const sweepExistingAssignments = () => {
				for (const row of connection.db.pinChunkQueue.iter()) {
					processPinChunkIfMine(row);
				}
			};

			const currentConfig = connection.db.pinCrackConfig.id.find(1);
			targetHashEl.textContent = currentConfig?.targetHash ?? DEFAULT_PIN_TARGET_HASH;
			currentPinLength = Number(currentConfig?.pinLength ?? DEFAULT_PIN_LENGTH);

			const subscription = connection.subscriptionBuilder().onApplied(() => {
				setStatus('Connected and subscribed to pin_chunk_queue.');
				ensurePinTaskInitialized(connection);
				sweepExistingAssignments();
				if (enabled) {
					maybeClaimPinWork();
				}
			});

			if (typeof subscription.subscribeToAllTables === 'function') {
				subscription.subscribeToAllTables();
			} else if (typeof subscription.subscribeToAll === 'function') {
				subscription.subscribeToAll();
			} else {
				subscription.subscribe([
					'SELECT * FROM pin_chunk_queue',
					'SELECT * FROM pin_crack_config',
					'SELECT * FROM node_status',
				]);
			}

			window.setInterval(() => {
				if (!enabled || !conn) {
					return;
				}
				sweepExistingAssignments();
				if (activeChunkIds.size === 0) {
					maybeClaimPinWork();
				}
			}, 1200);
		})
		.onDisconnect(() => {
			setStatus('Disconnected from SpaceTimeDB.');
		})
		.onConnectError((_ctx, err) => {
			console.error('PIN widget connection error:', err);
			setStatus('Failed to connect to SpaceTimeDB.');
		})
		.build();
}

toggleButton.addEventListener('click', () => {
	enabled = !enabled;
	toggleButton.textContent = enabled ? 'Disable PIN Compute' : 'Enable PIN Compute';

	if (enabled) {
		setStatus('PIN compute enabled. Requesting ranges...');
		maybeClaimPinWork();
	} else {
		setStatus('PIN compute paused.');
	}
});

resetPinButton.addEventListener('click', () => {
	if (!conn) {
		setStatus('Cannot reset PIN task: not connected yet.');
		return;
	}

	if (typeof conn.reducers.resetPinCrack !== 'function') {
		setStatus('reset_pin_crack is not available in current backend publish.');
		return;
	}

	try {
		conn.reducers.resetPinCrack({
			targetHash: DEFAULT_PIN_TARGET_HASH,
		});
		activeChunkIds.clear();
		targetHashEl.textContent = DEFAULT_PIN_TARGET_HASH;
		setStatus('PIN task reset submitted with default hash.');
	} catch (error) {
		console.error('reset_pin_crack failed:', error);
		setStatus('reset_pin_crack failed. Check console.');
	}
});

setDonatedCount(getDonatedCount());
targetHashEl.textContent = DEFAULT_PIN_TARGET_HASH;
startHeartbeat();
connect();
