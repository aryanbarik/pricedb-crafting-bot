import child from 'node:child_process';
import path from 'node:path';
import log from '../../../lib/logger';
import { CardRenderRequest, CardRenderResult } from './cardRenderProtocol';

const RENDER_TIMEOUT_MS = 15 * 1000;
let queue = Promise.resolve();

export function renderCard(request: CardRenderRequest): Promise<Buffer | null> {
    const task = queue.then(() => renderWithRetry(request));
    queue = task.then<void>(
        () => undefined,
        () => undefined
    );
    return task;
}

async function renderWithRetry(request: CardRenderRequest): Promise<Buffer | null> {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const image = await renderOnce(request, attempt);
        if (image !== null) return image;
    }
    return null;
}

function renderOnce(request: CardRenderRequest, attempt: number): Promise<Buffer | null> {
    return new Promise(resolve => {
        const started = Date.now();
        const worker = child.fork(path.join(__dirname, 'cardRenderWorker.js'), [], {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            serialization: 'advanced'
        });
        let settled = false;
        const finish = (image: Buffer | null, reason?: string): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (worker.connected) worker.disconnect();
            if (!worker.killed) worker.kill();
            if (reason)
                log.warn(
                    `Card worker ${request.type} attempt ${attempt} failed after ${Date.now() - started}ms: ${reason}`
                );
            resolve(image);
        };
        const timeout = setTimeout(() => finish(null, 'timed out'), RENDER_TIMEOUT_MS);
        worker.once('message', (result: CardRenderResult) => {
            if (!result || result.ok !== true || typeof result.image !== 'string')
                return finish(null, result?.error ?? 'malformed response');
            try {
                finish(Buffer.from(result.image, 'base64'));
            } catch {
                finish(null, 'invalid image response');
            }
        });
        worker.once('error', err => finish(null, err.message));
        worker.once('exit', code => {
            if (!settled) finish(null, `exited with code ${String(code)}`);
        });
        worker.send(request);
    });
}
