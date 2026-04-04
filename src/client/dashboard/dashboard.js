import { DbConnection } from '/module_bindings/index.js';

const SPACETIMEDB_URI = window.GRIDFORGOOD_URI ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = window.GRIDFORGOOD_DB_NAME ?? 'hack';

const taskListEl = document.getElementById('task-list');
const nodeListEl = document.getElementById('node-list');
const totalTasksEl = document.getElementById('total-tasks');
const requestingHelpEl = document.getElementById('requesting-help');
const activeNodesEl = document.getElementById('active-nodes');
const ACTIVE_WINDOW_MICROS = 2_000_000n;

let conn = null;

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

function isNodeActive(node) {
	const nowMicros = BigInt(Date.now()) * 1000n;
	return nowMicros - node.lastSeenMicros <= ACTIVE_WINDOW_MICROS;
}

function formatNodeId(nodeId) {
	return nodeId ? `${nodeId.toHexString().slice(0, 12)}...` : 'unknown';
}

function getTaskLiveViewUrl(taskKey) {
	if (taskKey === 'mandelbrot') {
		return '/client/mandelbrot-dashboard/index.html';
	}
	if (taskKey === 'pin_guess') {
		return '/client/pin-dashboard/index.html';
	}
	return null;
}

function statusPill(value, positiveLabel) {
	if (value) {
		return `<span class="pill pill-on">${positiveLabel}</span>`;
	}
	return '<span class="pill pill-off">Off</span>';
}

function getTaskMetrics(task) {
	let totalChunks = 0;
	let completedChunks = 0;
	let processingChunks = 0;
	const activeNodeHex = new Set();

	if (task.taskKey === 'mandelbrot') {
		for (const chunk of conn.db.mandelbrotChunkQueue.iter()) {
			if (Number(chunk.taskId) !== Number(task.taskId)) {
				continue;
			}
			totalChunks += 1;
			if (chunk.status === 'completed') {
				completedChunks += 1;
			}
			if (chunk.status === 'processing') {
				processingChunks += 1;
			}
			if (chunk.status === 'processing' && chunk.assignedNode) {
				activeNodeHex.add(chunk.assignedNode.toHexString());
			}
		}
	}

	if (task.taskKey === 'pin_guess') {
		for (const chunk of conn.db.pinChunkQueue.iter()) {
			if (Number(chunk.taskId) !== Number(task.taskId)) {
				continue;
			}
			totalChunks += 1;
			if (chunk.status === 'completed') {
				completedChunks += 1;
			}
			if (chunk.status === 'processing') {
				processingChunks += 1;
			}
			if (chunk.status === 'processing' && chunk.assignedNode) {
				activeNodeHex.add(chunk.assignedNode.toHexString());
			}
		}
	}

	return {
		totalChunks,
		completedChunks,
		processingChunks,
		activeNodes: activeNodeHex.size,
		progress: totalChunks > 0 ? Math.floor((completedChunks / totalChunks) * 100) : 0,
	};
}

function renderTask(task) {
	const metrics = getTaskMetrics(task);
	const card = document.createElement('article');
	card.className = 'task-card';
	const liveState =
		metrics.processingChunks > 0
			? '<span class="pill pill-on">Contributing Now</span>'
			: '<span class="pill pill-off">Idle</span>';
	const liveViewUrl = getTaskLiveViewUrl(task.taskKey);
	const liveViewButton = liveViewUrl
		? `<button data-task-id="${task.taskId}" data-task-key="${task.taskKey}" data-action="open-live" class="btn btn-secondary">Open Live View</button>`
		: '';
	card.innerHTML = `
		<div class="task-head">
			<h3>${task.displayName}</h3>
			<div class="task-flags">
				${statusPill(task.isActive, 'Active')}
				${statusPill(task.requestHelp, 'Requesting Help')}
				${liveState}
			</div>
		</div>
		<div class="task-meta">
			<div><span>Task Key</span><strong>${task.taskKey}</strong></div>
			<div><span>Total Chunks</span><strong>${metrics.totalChunks}</strong></div>
			<div><span>Completed</span><strong>${metrics.completedChunks}</strong></div>
			<div><span>In Progress</span><strong>${metrics.processingChunks}</strong></div>
			<div><span>Active Nodes</span><strong>${metrics.activeNodes}</strong></div>
			<div><span>Progress</span><strong>${metrics.progress}%</strong></div>
		</div>
		<div class="task-actions">
			${liveViewButton}
			<button data-task-id="${task.taskId}" data-action="reset-task" class="btn btn-secondary">
				Reset Task
			</button>
			<button data-task-id="${task.taskId}" data-action="toggle-help" class="btn">
				${task.requestHelp ? 'Disable Help Request' : 'Request Help'}
			</button>
			<button data-task-id="${task.taskId}" data-action="toggle-active" class="btn btn-secondary">
				${task.isActive ? 'Disable Task' : 'Enable Task'}
			</button>
		</div>
	`;

	return card;
}

function renderNode(node) {
	const card = document.createElement('article');
	card.className = 'task-card node-card';
	const active = isNodeActive(node);
	const nodeId = node.nodeId?.toHexString?.() ?? unwrapOption(node.nodeId);
	const donatedChunks = Number(node.donatedChunks ?? 0n);
	const lastSeen = new Date(Number(node.lastSeenMicros / 1000n)).toLocaleTimeString();
	card.innerHTML = `
		<div class="task-head">
			<h3>Edge Node Stats</h3>
			<div class="task-flags">
				<span class="pill ${active ? 'pill-on' : 'pill-off'}">${active ? 'Active' : 'Idle'}</span>
			</div>
		</div>
		<div class="task-meta node-meta">
			<div class="node-identity"><span>Node ID</span><strong>${nodeId ? `${nodeId.slice(0, 24)}...` : 'unknown'}</strong></div>
			<div><span>Donated Chunks</span><strong class="node-count">${donatedChunks}</strong></div>
			<div><span>Last Seen</span><strong>${lastSeen}</strong></div>
			<div><span>Status Window</span><strong>2s</strong></div>
		</div>
	`;

	return card;
}

function render() {
	if (!conn) {
		return;
	}

	const tasks = Array.from(conn.db.task.iter()).sort((a, b) => Number(a.taskId) - Number(b.taskId));
	taskListEl.innerHTML = '';

	for (const task of tasks) {
		taskListEl.appendChild(renderTask(task));
	}

	let requestingHelp = 0;
	for (const task of tasks) {
		if (task.requestHelp) {
			requestingHelp += 1;
		}
	}

	const activeNodeHex = new Set();
	for (const chunk of conn.db.mandelbrotChunkQueue.iter()) {
		if (chunk.status === 'processing' && chunk.assignedNode) {
			activeNodeHex.add(chunk.assignedNode.toHexString());
		}
	}
	for (const chunk of conn.db.pinChunkQueue.iter()) {
		if (chunk.status === 'processing' && chunk.assignedNode) {
			activeNodeHex.add(chunk.assignedNode.toHexString());
		}
	}

	totalTasksEl.textContent = `${tasks.length}`;
	requestingHelpEl.textContent = `${requestingHelp}`;
	activeNodesEl.textContent = `${activeNodeHex.size}`;

	if (nodeListEl) {
		nodeListEl.innerHTML = '';
		const nodes = Array.from(conn.db.nodeStatus.iter()).sort((a, b) => {
			const donatedA = Number(a.donatedChunks ?? 0n);
			const donatedB = Number(b.donatedChunks ?? 0n);
			return donatedB - donatedA;
		});

		for (const node of nodes) {
			nodeListEl.appendChild(renderNode(node));
		}
	}
}

function wireActions() {
	taskListEl.addEventListener('click', event => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return;
		}

		const action = target.getAttribute('data-action');
		const taskIdRaw = target.getAttribute('data-task-id');
		if (!action || !taskIdRaw || !conn) {
			return;
		}

		const taskId = Number.parseInt(taskIdRaw, 10);
		const task = conn.db.task.taskId.find(taskId);
		if (!task) {
			return;
		}

		if (action === 'toggle-help') {
			conn.reducers.setTaskHelp({
				taskId,
				requestHelp: !task.requestHelp,
			});
		}

		if (action === 'toggle-active') {
			conn.reducers.setTaskActive({
				taskId,
				isActive: !task.isActive,
			});
		}

		if (action === 'open-live') {
			const url = getTaskLiveViewUrl(task.taskKey);
			if (url) {
				window.open(url, '_blank');
			}
		}

		if (action === 'reset-task') {
			conn.reducers.resetTask({ taskId });
		}
	});
}

DbConnection.builder()
	.withUri(SPACETIMEDB_URI)
	.withDatabaseName(DB_NAME)
	.onConnect(connection => {
		conn = connection;

		connection.db.task.onInsert(render);
		connection.db.task.onUpdate(render);
		connection.db.mandelbrotChunkQueue.onInsert(render);
		connection.db.mandelbrotChunkQueue.onUpdate(render);
		connection.db.pinChunkQueue.onInsert(render);
		connection.db.pinChunkQueue.onUpdate(render);
		connection.db.nodeStatus.onInsert(render);
		connection.db.nodeStatus.onUpdate(render);

		const subscription = connection.subscriptionBuilder();
		if (typeof subscription.subscribeToAllTables === 'function') {
			subscription.subscribeToAllTables();
		} else if (typeof subscription.subscribeToAll === 'function') {
			subscription.subscribeToAll();
		} else {
			subscription.subscribe([
				'SELECT * FROM task',
				'SELECT * FROM mandelbrot_chunk_queue',
				'SELECT * FROM pin_chunk_queue',
				'SELECT * FROM node_status',
			]);
		}

		render();
		window.setInterval(render, 1000);
	})
	.onConnectError((_ctx, err) => {
		console.error('Server dashboard connection error:', err);
	})
	.build();

wireActions();
