import { DbConnection } from '/module_bindings/index.js';

const SPACETIMEDB_URI = window.GRIDFORGOOD_URI ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = window.GRIDFORGOOD_DB_NAME ?? 'hack';
const ACTIVE_WINDOW_MICROS = 2_000_000n;
const DEFAULT_PIN_TARGET_HASH = '4ed8dfd7183bd310f609b89ed2c2e20edcaf0d2aadeb8b3668ab9bb52428874b';

const activeNodesEl = document.getElementById('active-nodes');
const rangesCheckedEl = document.getElementById('ranges-checked');
const rangesInProgressEl = document.getElementById('ranges-in-progress');
const completionEl = document.getElementById('completion');
const targetHashEl = document.getElementById('target-hash');
const rangeLogEl = document.getElementById('range-log');
const activeRangeLogEl = document.getElementById('active-range-log');
const foundBannerEl = document.getElementById('found-banner');
const foundPinEl = document.getElementById('found-pin');
const foundByEl = document.getElementById('found-by');
const solveTimeEl = document.getElementById('solve-time');
const activeSolveTimeEl = document.getElementById('active-solve-time');

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

function formatElapsedSecondsFromMicros(deltaMicros) {
	const clampedMicros = deltaMicros > 0n ? deltaMicros : 0n;
	const elapsedMs = Number(clampedMicros) / 1000;
	return `${(elapsedMs / 1000).toFixed(2)}s`;
}

function updateDashboard(conn) {
	let total = 0;
	let completed = 0;
	let inProgress = 0;
	let firstWorkMicros = undefined;
	const recent = [];
	const active = [];

	for (const row of conn.db.pinChunkQueue.iter()) {
		total += 1;
		if (row.status === 'processing' || row.status === 'completed') {
			if (firstWorkMicros === undefined || row.updatedAtMicros < firstWorkMicros) {
				firstWorkMicros = row.updatedAtMicros;
			}
		}
		if (row.status === 'completed') {
			completed += 1;
			const owner = unwrapOption(row.assignedNode);
			const ownerLabel = owner ? `${owner.toHexString().slice(0, 12)}...` : 'unknown';
			const foundPin = unwrapOption(row.foundPin);
			recent.push({
				chunkId: row.chunkId,
				text: `Range ${row.rangeStart}-${row.rangeEnd} by ${ownerLabel}${foundPin ? ` FOUND ${foundPin}` : ''}`,
			});
		}
		if (row.status === 'processing') {
			inProgress += 1;
			const owner = unwrapOption(row.assignedNode);
			const ownerLabel = owner ? `${owner.toHexString().slice(0, 12)}...` : 'unknown';
			active.push({
				chunkId: row.chunkId,
				text: `Range ${row.rangeStart}-${row.rangeEnd} by ${ownerLabel}`,
			});
		}
	}

	const completion = total > 0 ? Math.floor((completed / total) * 100) : 0;
	rangesCheckedEl.textContent = `${completed}`;
	rangesInProgressEl.textContent = `${inProgress}`;
	completionEl.textContent = `${completion}%`;

	const nowMicros = BigInt(Date.now()) * 1000n;
	let activeNodes = 0;
	for (const node of conn.db.nodeStatus.iter()) {
		if (nowMicros - node.lastSeenMicros <= ACTIVE_WINDOW_MICROS) {
			activeNodes += 1;
		}
	}
	activeNodesEl.textContent = `${activeNodes}`;

	const config = conn.db.pinCrackConfig.id.find(1);
	targetHashEl.textContent = config?.targetHash ?? DEFAULT_PIN_TARGET_HASH;

	rangeLogEl.innerHTML = '';
	recent
		.sort((a, b) => Number(b.chunkId - a.chunkId))
		.slice(0, 12)
		.forEach(item => {
			const li = document.createElement('li');
			li.textContent = item.text;
			rangeLogEl.appendChild(li);
		});

	activeRangeLogEl.innerHTML = '';
	active
		.sort((a, b) => Number(b.chunkId - a.chunkId))
		.slice(0, 12)
		.forEach(item => {
			const li = document.createElement('li');
			li.textContent = item.text;
			activeRangeLogEl.appendChild(li);
		});

	const pinFound = unwrapOption(config?.pinFound);
	const foundBy = unwrapOption(config?.foundByNode);
	const nowMicrosForElapsed = BigInt(Date.now()) * 1000n;
	const endMicros = config?.foundAtMicros ?? nowMicrosForElapsed;
	const totalElapsed = config?.startedAtMicros
		? formatElapsedSecondsFromMicros(endMicros - config.startedAtMicros)
		: 'pending';
	const activeElapsed = firstWorkMicros
		? formatElapsedSecondsFromMicros(endMicros - firstWorkMicros)
		: 'pending';
	if (pinFound && foundBy && config?.foundAtMicros) {
		foundPinEl.textContent = `${pinFound}`;
		foundByEl.textContent = `${foundBy.toHexString().slice(0, 16)}...`;
		solveTimeEl.textContent = totalElapsed;
		activeSolveTimeEl.textContent = activeElapsed;
		foundBannerEl.style.display = 'block';
		foundBannerEl.textContent = `FOUND: PIN is ${pinFound} - found by ${foundBy.toHexString().slice(0, 12)}... in ${totalElapsed} total (${activeElapsed} active compute).`;
	} else if (!config || total === 0) {
		foundPinEl.textContent = 'pending';
		foundByEl.textContent = 'pending';
		solveTimeEl.textContent = 'pending';
		activeSolveTimeEl.textContent = 'pending';
		foundBannerEl.style.display = 'block';
		foundBannerEl.textContent = 'Waiting for pin task initialization. Click Reset PIN Task on a compute node once.';
	} else {
		foundPinEl.textContent = 'searching';
		foundByEl.textContent = 'searching';
		solveTimeEl.textContent = totalElapsed;
		activeSolveTimeEl.textContent = activeElapsed === 'pending' ? 'searching' : activeElapsed;
		foundBannerEl.style.display = 'none';
	}
}

DbConnection.builder()
	.withUri(SPACETIMEDB_URI)
	.withDatabaseName(DB_NAME)
	.onConnect(conn => {
		conn.db.pinChunkQueue.onInsert(() => updateDashboard(conn));
		conn.db.pinChunkQueue.onUpdate(() => updateDashboard(conn));
		conn.db.pinCrackConfig.onInsert(() => updateDashboard(conn));
		conn.db.pinCrackConfig.onUpdate(() => updateDashboard(conn));
		conn.db.nodeStatus.onInsert(() => updateDashboard(conn));
		conn.db.nodeStatus.onUpdate(() => updateDashboard(conn));

		const subscription = conn.subscriptionBuilder();
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

		updateDashboard(conn);
		window.setInterval(() => updateDashboard(conn), 1000);
	})
	.onConnectError((_ctx, err) => {
		console.error('PIN dashboard connection error:', err);
	})
	.build();
