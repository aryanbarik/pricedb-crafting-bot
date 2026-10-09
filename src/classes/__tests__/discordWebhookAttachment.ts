import http from 'http';
import { AddressInfo } from 'net';
import { createCanvas } from '@napi-rs/canvas';
import { sendWebhook } from '../DiscordWebhook/utils';
import { Webhook } from '../DiscordWebhook/interfaces';

interface Captured {
    contentType: string;
    body: Buffer;
}

let server: http.Server;
let captured: Captured;
let url: string;

beforeAll(done => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c as Buffer));
        req.on('end', () => {
            captured = { contentType: req.headers['content-type'] ?? '', body: Buffer.concat(chunks) };
            res.writeHead(204).end();
        });
    });
    server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
        done();
    });
});

afterAll(done => {
    server.close(() => {
        done();
    });
});

function png(): Buffer {
    const canvas = createCanvas(4, 4);
    canvas.getContext('2d').fillRect(0, 0, 4, 4);
    return canvas.toBuffer('image/png');
}

function twoEmbedWebhook(): Webhook {
    return {
        username: 'bot',
        content: '<@!123> - Accepted trade here!',
        embeds: [
            { color: '9171753', description: 'Sent 2 keys (3 → 1/5)', image: { url: 'attachment://trade-1.png' } },
            { color: '9171753', fields: [{ name: '__Status__', value: 'ok' }] }
        ]
    };
}

describe('sendWebhook', () => {
    it('posts plain JSON when there is no attachment', async () => {
        await sendWebhook(url, twoEmbedWebhook(), 'trade-summary', 0);

        expect(captured.contentType).toContain('application/json');
        const parsed = JSON.parse(captured.body.toString()) as Webhook;
        expect(parsed.embeds).toHaveLength(2);
    });

    it('posts multipart with payload_json and files[0] when given an attachment', async () => {
        const image = png();
        await sendWebhook(url, twoEmbedWebhook(), 'trade-summary', 0, { name: 'trade-1.png', buffer: image });

        expect(captured.contentType).toMatch(/^multipart\/form-data; boundary=/);

        const raw = captured.body.toString('latin1');
        expect(raw).toContain('name="payload_json"');
        expect(raw).toContain('name="files[0]"; filename="trade-1.png"');
        expect(raw).toContain('Content-Type: image/png');

        // The embed must reference the uploaded file by name for Discord to bind them.
        const json = /name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
        const parsed = JSON.parse(json[1]) as Webhook;
        expect(parsed.embeds[0].image.url).toBe('attachment://trade-1.png');

        // ...and the actual PNG bytes must survive the round trip intact.
        expect(captured.body.includes(image)).toBe(true);
    });

    it('strips the mention on secondary URLs without choking on a description-less embed', async () => {
        const webhook = twoEmbedWebhook();

        // embeds[1] has no description; an unguarded .replace() here would throw.
        await expect(sendWebhook(url, webhook, 'trade-summary', 1)).resolves.toBeUndefined();

        const parsed = JSON.parse(captured.body.toString()) as Webhook;
        expect(parsed.content).not.toContain('<@!123>');
        expect(parsed.embeds[0].description).toBe('Sent 2 keys');
        expect(parsed.embeds[1].description).toBeUndefined();
    });

    it('rejects with the webhook attached so callers can fall back', async () => {
        await expect(
            sendWebhook('http://127.0.0.1:1/hook', twoEmbedWebhook(), 'trade-summary', 0)
        ).rejects.toMatchObject({ webhook: { username: 'bot' } });
    });
});
