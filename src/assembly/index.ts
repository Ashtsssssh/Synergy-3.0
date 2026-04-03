// Reference Mandelbrot kernel in TypeScript syntax.
// If you compile AssemblyScript separately, mirror this function in an AS source
// file and emit math.wasm into src/client/wasm.

export function computeChunkReference(
	minRe: number,
	maxRe: number,
	minIm: number,
	maxIm: number,
	width: number,
	height: number,
	maxIterations: number
): Uint8Array {
	const output = new Uint8Array(width * height * 4);
	const reStep = (maxRe - minRe) / width;
	const imStep = (maxIm - minIm) / height;

	let index = 0;
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

			if (iter >= maxIterations) {
				output[index] = 0;
				output[index + 1] = 0;
				output[index + 2] = 0;
			} else {
				const t = iter / maxIterations;
				output[index] = Math.floor(9 * (1 - t) * t * t * t * 255);
				output[index + 1] = Math.floor(15 * (1 - t) * (1 - t) * t * t * 255);
				output[index + 2] = Math.floor(8.5 * (1 - t) * (1 - t) * (1 - t) * t * 255);
			}

			output[index + 3] = 255;
			index += 4;
		}
	}

	return output;
}
