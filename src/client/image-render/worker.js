let wasmInstance = null;
let wasmLoadPromise = null;
const textEncoder = new TextEncoder();

function sleep(ms) {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

async function loadWasm() {
	if (wasmInstance) {
		return wasmInstance;
	}
	if (wasmLoadPromise) {
		return wasmLoadPromise;
	}

	wasmLoadPromise = (async () => {
		try {
			const wasmUrl = new URL('../wasm/math.wasm', import.meta.url);
			const response = await fetch(wasmUrl);
			const bytes = await response.arrayBuffer();
			const result = await WebAssembly.instantiate(bytes, {});
			wasmInstance = result.instance;
			return wasmInstance;
		} catch {
			wasmInstance = null;
			return null;
		} finally {
			wasmLoadPromise = null;
		}
	})();

	return wasmLoadPromise;
}

function palette(iteration, maxIterations) {
	if (iteration >= maxIterations) {
		return [0, 0, 0, 255];
	}

	const t = iteration / maxIterations;
	const r = Math.floor(9 * (1 - t) * t * t * t * 255);
	const g = Math.floor(15 * (1 - t) * (1 - t) * t * t * 255);
	const b = Math.floor(8.5 * (1 - t) * (1 - t) * (1 - t) * t * 255);
	return [r, g, b, 255];
}

function jsComputeMandelbrot(payload) {
	const { minRe, maxRe, minIm, maxIm, width, height, maxIterations } = payload;
	const pixels = new Array(width * height * 4);
	const reStep = (maxRe - minRe) / width;
	const imStep = (maxIm - minIm) / height;

	let writeIndex = 0;
	for (let y = 0; y < height; y += 1) {
		const cIm = maxIm - y * imStep;
		for (let x = 0; x < width; x += 1) {
			const cRe = minRe + x * reStep;

			let zRe = 0;
			let zIm = 0;
			let iter = 0;

			while (zRe * zRe + zIm * zIm <= 4 && iter < maxIterations) {
				const nextRe = zRe * zRe - zIm * zIm + cRe;
				zIm = 2 * zRe * zIm + cIm;
				zRe = nextRe;
				iter += 1;
			}

			const [r, g, b, a] = palette(iter, maxIterations);
			pixels[writeIndex] = r;
			pixels[writeIndex + 1] = g;
			pixels[writeIndex + 2] = b;
			pixels[writeIndex + 3] = a;
			writeIndex += 4;
		}
	}

	return pixels;
}

function wasmComputeMandelbrot(payload, instance) {
	const computeChunk = instance.exports.compute_chunk || instance.exports.computeChunk;
	if (typeof computeChunk !== 'function') {
		return null;
	}

	try {
		const result = computeChunk(
			payload.minRe,
			payload.maxRe,
			payload.minIm,
			payload.maxIm,
			payload.width,
			payload.height,
			payload.maxIterations
		);

		if (Array.isArray(result)) {
			return result;
		}
		if (result instanceof Uint8Array || result instanceof Uint8ClampedArray) {
			return Array.from(result);
		}
	} catch {
		return null;
	}

	return null;
}

function formatPin(value, length) {
	return `${value}`.padStart(length, '0');
}

async function sha256Hex(input) {
	const hashBuffer = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
	const bytes = new Uint8Array(hashBuffer);
	let out = '';
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, '0');
	}
	return out;
}

async function computePinChunk(payload) {
	const targetHash = payload.targetHash.trim().toLowerCase();
	for (let n = payload.rangeStart; n <= payload.rangeEnd; n += 1) {
		const candidate = formatPin(n, payload.pinLength);
		const hash = await sha256Hex(candidate);
		if (hash === targetHash) {
			return candidate;
		}
	}
	return undefined;
}

self.onmessage = async event => {
	const { type, payload } = event.data ?? {};
	if (type !== 'compute') {
		return;
	}

	try {
		if (payload.taskKey === 'mandelbrot') {
			const instance = await loadWasm();
			const wasmPixels = instance ? wasmComputeMandelbrot(payload, instance) : null;
			const pixels = wasmPixels ?? jsComputeMandelbrot(payload);
			const delayMs = Math.max(0, Number(payload.demoDelayMs ?? 0));
			if (delayMs > 0) {
				await sleep(delayMs);
			}

			self.postMessage({
				type: 'chunk-computed',
				payload: {
					taskKey: 'mandelbrot',
					taskId: payload.taskId,
					chunkId: payload.chunkId,
					pixels,
				},
			});
			return;
		}

		if (payload.taskKey === 'pin_guess') {
			const foundPin = await computePinChunk(payload);
			self.postMessage({
				type: 'chunk-computed',
				payload: {
					taskKey: 'pin_guess',
					taskId: payload.taskId,
					chunkId: payload.chunkId,
					foundPin,
				},
			});
			return;
		}

		throw new Error(`Unsupported taskKey: ${payload.taskKey}`);
	} catch (error) {
		self.postMessage({
			type: 'worker-error',
			payload: {
				chunkId: payload?.chunkId,
				message: error instanceof Error ? error.message : 'Unknown worker error',
			},
		});
	}
};
