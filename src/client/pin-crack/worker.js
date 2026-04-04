let shaWasmInstance = null;

async function loadShaWasm() {
	if (shaWasmInstance) {
		return shaWasmInstance;
	}

	try {
		const wasmUrl = new URL('../wasm/sha256.wasm', import.meta.url);
		const response = await fetch(wasmUrl);
		const bytes = await response.arrayBuffer();
		const result = await WebAssembly.instantiate(bytes, {});
		shaWasmInstance = result.instance;
		return shaWasmInstance;
	} catch {
		shaWasmInstance = null;
		return null;
	}
}

function writeCString(memoryView, ptr, value) {
	for (let i = 0; i < value.length; i += 1) {
		memoryView[ptr + i] = value.charCodeAt(i);
	}
	memoryView[ptr + value.length] = 0;
}

function wasmCrackPinChunk(payload, instance) {
	const crackChunk = instance.exports.crack_chunk;
	const memory = instance.exports.memory;
	if (typeof crackChunk !== 'function' || !memory) {
		return null;
	}

	try {
		const memoryView = new Uint8Array(memory.buffer);
		const hashPtr = 4096;
		const pinLength = Number(payload.pinLength ?? 6);
		const maxCandidate = 10 ** pinLength - 1;
		writeCString(memoryView, hashPtr, payload.targetHash.toLowerCase());

		// Support both signatures: crack_chunk(start, endExclusive, hashPtr, pinLength) and without pinLength.
		let maybePin;
		try {
			maybePin = crackChunk(payload.rangeStart, payload.rangeEnd + 1, hashPtr, pinLength);
		} catch {
			maybePin = crackChunk(payload.rangeStart, payload.rangeEnd + 1, hashPtr);
		}

		if (typeof maybePin === 'number' && maybePin >= 0 && maybePin <= maxCandidate) {
			return `${maybePin}`.padStart(pinLength, '0');
		}
	} catch {
		return null;
	}

	return null;
}

function toHex(bytes) {
	return Array.from(bytes)
		.map(byte => byte.toString(16).padStart(2, '0'))
		.join('');
}

async function jsCrackPinChunk(payload) {
	const target = payload.targetHash.toLowerCase();
	const pinLength = Number(payload.pinLength ?? 6);
	for (let candidate = payload.rangeStart; candidate <= payload.rangeEnd; candidate += 1) {
		const pin = `${candidate}`.padStart(pinLength, '0');
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
		if (toHex(new Uint8Array(digest)) === target) {
			return pin;
		}
	}
	return null;
}

self.onmessage = async event => {
	const { type, payload } = event.data ?? {};
	if (type !== 'compute-pin') {
		return;
	}

	try {
		const instance = await loadShaWasm();
		const foundPin = (instance ? wasmCrackPinChunk(payload, instance) : null) ?? (await jsCrackPinChunk(payload));

		self.postMessage({
			type: 'pin-chunk-computed',
			payload: {
				chunkId: payload.chunkId,
				foundPin,
			},
		});
	} catch (error) {
		self.postMessage({
			type: 'worker-error',
			payload: {
				message: error instanceof Error ? error.message : 'Unknown worker error',
			},
		});
	}
};
