import { DbConnection } from '/module_bindings/index.js';

const SPACETIMEDB_URI = window.GRIDFORGOOD_URI ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = window.GRIDFORGOOD_DB_NAME ?? 'hack';
const DONATED_KEY = 'gridforgood_donated_chunks';

const taskListEl = document.getElementById('task-list');
const donatedChunksEl = document.getElementById('donated-chunks');
const syncedDonatedChunksEl = document.getElementById('synced-donated-chunks');
const nodeIdEl = document.getElementById('node-id');
const statusEl = document.getElementById('status');
const stopButton = document.getElementById('stop-contributing');
const demoDelayEl = document.getElementById('demo-delay');
const demoDelayValueEl = document.getElementById('demo-delay-value');

const worker = new Worker(new URL('./worker.js', import.meta.url), {
	type: 'module',
});

let conn = null;
let myIdentityHex = '';
let activeTaskId = null;
let activeTaskKey = '';
let isContributing = false;
const activeChunkIds = new Set();
const DEMO_DELAY_KEY = 'gridforgood_mandelbrot_demo_delay_ms';

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

function setSyncedDonatedChunks(next) {
	if (!syncedDonatedChunksEl) {
		return;
	}
	syncedDonatedChunksEl.textContent = `${next}`;
}

function getDemoDelayMs() {
	const stored = Number.parseInt(localStorage.getItem(DEMO_DELAY_KEY) ?? '0', 10);
	if (Number.isNaN(stored)) {
		return 0;
	}
	return Math.max(0, stored);
}

function setDemoDelayMs(nextMs) {
	const clamped = Math.max(0, Number(nextMs) || 0);
	localStorage.setItem(DEMO_DELAY_KEY, `${clamped}`);
	if (demoDelayEl) {
		demoDelayEl.value = `${clamped}`;
	}
	if (demoDelayValueEl) {
		demoDelayValueEl.textContent = `${clamped}ms`;
	}
}

function updateSyncedDonationCount() {
	if (!conn || !myIdentityHex) {
		setSyncedDonatedChunks(0);
		return;
	}

	for (const row of conn.db.nodeStatus.iter()) {
		const nodeId = row.nodeId?.toHexString?.() ?? '';
		if (nodeId === myIdentityHex) {
			setSyncedDonatedChunks(Number(row.donatedChunks ?? 0n));
			return;
		}
	}

	setSyncedDonatedChunks(0);
}

function getTaskProgress(task) {
	let total = 0;
	let completed = 0;

	if (task.taskKey === 'mandelbrot') {
		for (const chunk of conn.db.mandelbrotChunkQueue.iter()) {
			if (Number(chunk.taskId) !== Number(task.taskId)) {
				continue;
			}
			total += 1;
			if (chunk.status === 'completed') {
				completed += 1;
			}
		}
	}

	if (task.taskKey === 'pin_guess') {
		for (const chunk of conn.db.pinChunkQueue.iter()) {
			if (Number(chunk.taskId) !== Number(task.taskId)) {
				continue;
			}
			total += 1;
			if (chunk.status === 'completed') {
				completed += 1;
			}
		}
	}

	return {
		total,
		completed,
		progress: total > 0 ? Math.floor((completed / total) * 100) : 0,
	};
}

function renderTaskCard(task) {
	const metrics = getTaskProgress(task);
	const isSelected = Number(task.taskId) === Number(activeTaskId);

	const card = document.createElement('article');
	card.className = `task-card${isSelected ? ' task-card-active' : ''}`;
	card.innerHTML = `
		<div class="task-head">
			<h3>${task.displayName}</h3>
			<span class="pill">${metrics.progress}%</span>
		</div>
		<div class="task-meta">
			<span>Completed ${metrics.completed}/${metrics.total}</span>
			<span>Type: ${task.taskKey}</span>
		</div>
		<div class="task-actions">
			<button class="btn" data-task-id="${task.taskId}" data-task-key="${task.taskKey}">
				${isSelected ? 'Contributing' : 'Contribute'}
			</button>
		</div>
	`;

	return card;
}

function renderTaskList() {
	if (!conn) {
		return;
	}

	const tasks = [];
	for (const task of conn.db.task.iter()) {
		if (task.requestHelp && task.isActive) {
			tasks.push(task);
		}
	}
	tasks.sort((a, b) => Number(a.taskId) - Number(b.taskId));

	taskListEl.innerHTML = '';

	if (tasks.length === 0) {
		taskListEl.innerHTML = '<p class="empty">No tasks are requesting help right now.</p>';
		activeTaskId = null;
		activeTaskKey = '';
		return;
	}

	for (const task of tasks) {
		taskListEl.appendChild(renderTaskCard(task));
	}
}

function maybeClaimWork() {
	if (!conn || !activeTaskId || !isContributing) {
		return;
	}
	try {
		conn.reducers.requestWork({ taskId: Number(activeTaskId) });
	} catch (error) {
		console.error('request_work failed:', error);
	}
}

function processMandelbrotChunkIfMine(row) {
	if (!conn || !isContributing || Number(row.taskId) !== Number(activeTaskId) || activeTaskKey !== 'mandelbrot') {
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
	setStatus(`Computing Mandelbrot chunk #${chunkId}...`);
	const demoDelayMs = getDemoDelayMs();
	worker.postMessage({
		type: 'compute',
		payload: {
			taskKey: 'mandelbrot',
			taskId: Number(row.taskId),
			chunkId,
			demoDelayMs,
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

function processPinChunkIfMine(row) {
	if (!conn || !isContributing || Number(row.taskId) !== Number(activeTaskId) || activeTaskKey !== 'pin_guess') {
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
	setStatus(`Computing PIN chunk #${chunkId}...`);
	worker.postMessage({
		type: 'compute',
		payload: {
			taskKey: 'pin_guess',
			taskId: Number(row.taskId),
			chunkId,
			rangeStart: Number(row.rangeStart),
			rangeEnd: Number(row.rangeEnd),
			pinLength: Number(row.pinLength),
			targetHash: row.targetHash,
		},
	});
}

worker.onmessage = event => {
	const { type, payload } = event.data ?? {};

	if (type === 'chunk-computed' && conn) {
		try {
			let resultData;
			if (payload.taskKey === 'mandelbrot') {
				resultData = JSON.stringify(payload.pixels);
			}
			if (payload.taskKey === 'pin_guess') {
				resultData = payload.foundPin;
			}

			conn.reducers.submitResult({
				taskId: Number(payload.taskId),
				chunkId: BigInt(payload.chunkId),
				resultData,
			});
		} catch (error) {
			console.error('submit_result failed:', error);
			setStatus(`submit_result failed for chunk #${payload.chunkId}.`);
		}

		activeChunkIds.delete(payload.chunkId.toString());
		setDonatedCount(getDonatedCount() + 1);
		if (payload.taskKey === 'pin_guess' && payload.foundPin) {
			setStatus(`PIN found: ${payload.foundPin}.`);
		} else {
			setStatus(`Submitted chunk #${payload.chunkId}. Requesting more work...`);
		}
		maybeClaimWork();
		return;
	}

	if (type === 'worker-error') {
		console.error('Worker error:', payload.message);
		if (payload?.chunkId) {
			activeChunkIds.delete(payload.chunkId.toString());
		}
		setStatus('Worker error. See console for details.');
		maybeClaimWork();
	}
};

function startHeartbeat() {
	window.setInterval(() => {
		if (conn && activeTaskId && isContributing) {
			conn.reducers.heartbeat({});
		}
	}, 4000);
}

function wireNodeStatusUpdates() {
	if (!conn) {
		return;
	}

	conn.db.nodeStatus.onInsert(updateSyncedDonationCount);
	conn.db.nodeStatus.onUpdate(updateSyncedDonationCount);
	updateSyncedDonationCount();
}

function wireTaskAction() {
	taskListEl.addEventListener('click', event => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return;
		}

		const taskIdRaw = target.getAttribute('data-task-id');
		const taskKey = target.getAttribute('data-task-key');
		if (!taskIdRaw || !taskKey) {
			return;
		}

		activeTaskId = Number.parseInt(taskIdRaw, 10);
		activeTaskKey = taskKey;
		isContributing = true;
		activeChunkIds.clear();
		if (stopButton) {
			stopButton.disabled = false;
		}
		setStatus(`Contributing to ${taskKey}. Requesting work...`);
		renderTaskList();
		maybeClaimWork();
	});
}

function wireStopAction() {
	if (!stopButton) {
		return;
	}

	stopButton.addEventListener('click', () => {
		isContributing = false;
		activeTaskId = null;
		activeTaskKey = '';
		activeChunkIds.clear();
		stopButton.disabled = true;
		setStatus('Contribution stopped. Pick a task to contribute again.');
		renderTaskList();
	});
}

function wireDemoDelayControl() {
	if (!demoDelayEl) {
		return;
	}

	setDemoDelayMs(getDemoDelayMs());

	demoDelayEl.addEventListener('input', event => {
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) {
			return;
		}
		setDemoDelayMs(Number.parseInt(target.value, 10));
	});
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

			connection.db.task.onInsert(renderTaskList);
			connection.db.task.onUpdate(renderTaskList);
			connection.db.mandelbrotChunkQueue.onInsert((_ctx, row) => {
				processMandelbrotChunkIfMine(row);
				renderTaskList();
			});
			connection.db.mandelbrotChunkQueue.onUpdate((_ctx, _oldRow, row) => {
				processMandelbrotChunkIfMine(row);
				renderTaskList();
			});
			connection.db.pinChunkQueue.onInsert((_ctx, row) => {
				processPinChunkIfMine(row);
				renderTaskList();
			});
			connection.db.pinChunkQueue.onUpdate((_ctx, _oldRow, row) => {
				processPinChunkIfMine(row);
				renderTaskList();
			});

			const subscription = connection.subscriptionBuilder().onApplied(() => {
				setStatus('Connected. Pick a task to contribute.');
				updateSyncedDonationCount();
				renderTaskList();
			});

			if (typeof subscription.subscribeToAllTables === 'function') {
				subscription.subscribeToAllTables();
			} else if (typeof subscription.subscribeToAll === 'function') {
				subscription.subscribeToAll();
			} else {
				subscription.subscribe([
					'SELECT * FROM task',
					'SELECT * FROM mandelbrot_chunk_queue',
					'SELECT * FROM pin_chunk_queue',
				]);
			}

			wireNodeStatusUpdates();

			window.setInterval(() => {
				if (!conn || !activeTaskId || !isContributing) {
					return;
				}
				maybeClaimWork();
			}, 1500);
		})
		.onDisconnect(() => {
			setStatus('Disconnected from SpaceTimeDB.');
		})
		.onConnectError((_ctx, err) => {
			console.error('Edge dashboard connection error:', err);
			setStatus('Failed to connect to SpaceTimeDB.');
		})
		.build();
}

setDonatedCount(getDonatedCount());
wireTaskAction();
wireStopAction();
wireDemoDelayControl();
startHeartbeat();
connect();
