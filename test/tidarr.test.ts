import { instancesOf } from './helpers/instances.ts';
import { describe, expect, it, vi } from 'vitest';
import type * as z from 'zod/v4';
import { ConfigSchema, type AnyServiceConfig, type KeyedServiceConfig } from '../src/config/schema.ts';
import { WriteAudit } from '../src/core/audit.ts';
import { ConfirmTokens } from '../src/core/confirm.ts';
import { ServiceError } from '../src/core/errors.ts';
import { permissionSourceFrom } from '../src/core/permissions.ts';
import { buildAdapters } from '../src/services/registry.ts';
import { parseTidalUrl, TidarrAdapter, tidalUrl } from '../src/services/tidarr.ts';
import type { LibraryLoader } from '../src/tools/library.ts';
import { registerManageMusic } from '../src/tools/manageMusic.ts';
import { registerPauseDownloads } from '../src/tools/pauseDownloads.ts';
import { registerRemoveQueueItem } from '../src/tools/removeQueueItem.ts';
import { buildGetQueue } from '../src/tools/getQueue.ts';
import { buildStackHealth } from '../src/tools/stackHealth.ts';
import type { WriteContext, WriteToolResult } from '../src/tools/write.ts';
import { jsonResponse } from './helpers/serve.ts';

/**
 * Not recorded fixtures: shaped from Tidarr's own route handlers
 * (`api/src/routes/processing.ts` and `sync.ts`, 1.2.8) and its types, since
 * there is no capture of a live instance yet. `npm run capture` now knows the
 * three Tidarr reads, so these can be replaced by real ones.
 */

const KEY = 'tidarr-secret-key-0123456789abcdef0123456789abcdef0123456789abcd';

const config = (perms: { safe_write: boolean; destructive: boolean } = { safe_write: true, destructive: true }): KeyedServiceConfig => ({
    url: 'http://192.0.2.20:8484',
    api_key: KEY,
    timeout_ms: 10_000,
    permissions: perms
});

/** The ServiceError a promise rejects with; fails the test if it resolves. */
async function failure(promise: Promise<unknown>): Promise<ServiceError> {
    try {
        await promise;
    } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        return err as ServiceError;
    }
    throw new Error('expected a rejection');
}

type Seen = { method: string; path: string; search: string; apiKey: string | null; body?: unknown };

type Row = Record<string, unknown>;

const QUEUE: Row[] = [
    { id: '251082404', type: 'album', title: 'Album One', artist: 'Artist A', quality: 'max', status: 'download', url: 'u', loading: true, error: false },
    { id: '111', type: 'track', title: 'Done', artist: 'Artist B', quality: 'high', status: 'finished', url: 'u', loading: false, error: false },
    { id: '222', type: 'album', title: 'Broken', artist: 'Artist C', quality: 'high', status: 'error', errorStage: 'post_processing', url: 'u', loading: false, error: true },
    { id: '333', type: 'album', title: 'Never Arrived', artist: 'Artist D', quality: 'low', status: 'error', errorStage: 'download', url: 'u', loading: false, error: true }
];

const SYNC: Row[] = [
    { id: '0b7f1c2e-1111-2222-3333-444455556666', title: 'Morning', url: 'u', type: 'playlist', quality: 'high', lastUpdate: '2026-10-01T03:00:00Z' },
    { id: '0b7f1c2e-aaaa-bbbb-cccc-ddddeeeeffff', title: 'Paused one', url: 'u', type: 'playlist', quality: 'max', paused: true }
];

/** A fake Tidarr that answers the adapter's allowlist and records every request. */
function fakeTidarr(opts: { failWith?: number; paused?: boolean } = {}) {
    const seen: Seen[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        seen.push({
            method,
            path: url.pathname,
            search: url.search,
            apiKey: headers.get('x-api-key'),
            ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {})
        });
        if (opts.failWith !== undefined) return jsonResponse({ error: true, message: `upstream said ${KEY}` }, opts.failWith);

        const route = `${method} ${url.pathname}`;
        switch (route) {
            case 'GET /api/queue/status':
                return jsonResponse({ isPaused: opts.paused ?? false, batchCount: 0, batchResumeAt: null });
            case 'GET /api/queue/list':
                return jsonResponse({ total: QUEUE.length, offset: 0, limit: null, queue: QUEUE });
            case 'GET /api/sync/list':
                return jsonResponse(SYNC);
            // Tidarr's `res.sendStatus` answers with a plain-text reason, not JSON.
            case 'POST /api/save':
            case 'POST /api/sync/save':
                return new Response('Created', { status: 201 });
            case 'POST /api/sync/trigger':
                return new Response('Accepted', { status: 202 });
            case 'POST /api/queue/pause':
            case 'POST /api/queue/resume':
            case 'POST /api/retry-post-processing':
            case 'DELETE /api/remove':
            case 'DELETE /api/sync/remove':
                return new Response(null, { status: 204 });
            default:
                return jsonResponse({ error: 'not found' }, 404);
        }
    }) as unknown as typeof fetch;
    return { seen, impl };
}

type Call = (args: Record<string, unknown>) => Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent: WriteToolResult;
}>;

function harness(opts: { perms?: { safe_write: boolean; destructive: boolean }; paused?: boolean } = {}) {
    const { seen, impl } = fakeTidarr(opts.paused === undefined ? {} : { paused: opts.paused });
    const cfg = config(opts.perms);
    const adapters = [new TidarrAdapter(cfg, impl)];
    const calls: Record<string, Call> = {};
    const server = {
        registerTool(name: string, spec: { inputSchema: z.ZodObject }, handler: Call) {
            calls[name] = args => handler(spec.inputSchema.parse(args) as Record<string, unknown>);
        }
    };
    const audit = WriteAudit.ephemeral();
    const context: WriteContext = {
        permissions: permissionSourceFrom(instancesOf({ tidarr: cfg as unknown as AnyServiceConfig })),
        confirm: new ConfirmTokens(),
        audit,
        library: { invalidate: vi.fn() } as unknown as LibraryLoader
    };
    registerManageMusic(server as never, context, adapters);
    registerPauseDownloads(server as never, context, adapters);
    registerRemoveQueueItem(server as never, context, adapters);

    const call = (tool: string, args: Record<string, unknown>) => {
        const fn = calls[tool];
        if (fn === undefined) throw new Error(`${tool} not registered`);
        return fn(args);
    };
    const confirmed = async (tool: string, args: Record<string, unknown>) => {
        const preview = await call(tool, args);
        return call(tool, { ...args, confirm: preview.structuredContent.confirm_token });
    };
    const writes = () => seen.filter(s => s.method !== 'GET');
    return { call, confirmed, seen, writes, audit, adapters };
}

/** Every path the adapter is allowed to reach. Anything else is a bug. */
const ALLOWED = new Set([
    'GET /api/queue/status',
    'GET /api/queue/list',
    'GET /api/sync/list',
    'POST /api/save',
    'POST /api/queue/pause',
    'POST /api/queue/resume',
    'POST /api/retry-post-processing',
    'POST /api/sync/save',
    'POST /api/sync/trigger',
    'DELETE /api/remove',
    'DELETE /api/sync/remove'
]);

/** The paths that leak a secret or act in bulk. Asserted absent by name, so a
 *  future widening of ALLOWED cannot quietly admit one of them. */
const FORBIDDEN = [
    '/api/settings',
    '/api/api-key',
    '/api/api-key/regenerate',
    '/api/token',
    '/api/tiddl/config',
    '/api/remove-all',
    '/api/remove-finished',
    '/api/retry-failed',
    '/api/history/list',
    '/api/sync/remove-all',
    '/api/stream/sign',
    '/api/stream/play'
];

describe('TidarrAdapter reads', () => {
    it('merges into get_queue without finished items, with Tidarr statuses in get_queue words', async () => {
        const { impl } = fakeTidarr();
        const result = await buildGetQueue([new TidarrAdapter(config(), impl)], { detail: 'full', limit: 50 });

        expect(result.items.map(i => i.id).sort()).toEqual(['222', '251082404', '333']);
        const downloading = result.items.find(i => i.id === '251082404')!;
        expect(downloading).toMatchObject({ service: 'tidarr', status: 'downloading', protocol: 'tidal', mediaType: 'album', quality: 'max' });
        // Catalogue text is third-party, so it is fenced like a release name.
        expect(downloading.title).toContain('Artist A — Album One');
        expect(downloading.title).not.toBe('Artist A — Album One');
    });

    it('says which failures a post-processing retry can rescue', async () => {
        const { impl } = fakeTidarr();
        const items = await new TidarrAdapter(config(), impl).getQueue();

        expect(items.find(i => i.id === '222')).toMatchObject({ status: 'failed' });
        expect(items.find(i => i.id === '222')?.statusMessages?.[0]).toMatch(/without downloading again/);
        expect(items.find(i => i.id === '333')?.statusMessages?.[0]).toMatch(/only helps if some tracks were already saved/);
    });

    it('sends the key as X-Api-Key on every request and never in the query string', async () => {
        const h = harness();
        await h.adapters[0]!.getQueue();
        await h.adapters[0]!.readSyncList();
        await h.confirmed('manage_music', { action: 'add', url: 'https://tidal.com/album/42' });
        await h.confirmed('pause_downloads', { service: 'tidarr', action: 'pause' });

        expect(h.seen.length).toBeGreaterThan(4);
        for (const request of h.seen) {
            expect(request.apiKey).toBe(KEY);
            expect(request.search).toBe('');
        }
    });

    it('reports a reachable Tidarr without a version, since the only one sits beside the Tidal tokens', async () => {
        const { impl, seen } = fakeTidarr();
        const diagnosis = await new TidarrAdapter(config(), impl).testConnection();

        expect(diagnosis).toMatchObject({ ok: true, service: 'tidarr' });
        expect(diagnosis.version).toBeUndefined();
        expect(seen.map(s => s.path)).toEqual(['/api/queue/status']);
    });

    it('lists its queue state and synced playlists in stack_health at full, and only there', async () => {
        const { impl } = fakeTidarr({ paused: true });
        const adapter = new TidarrAdapter(config(), impl);

        const full = await buildStackHealth([adapter], { detail: 'full', limit: 50 });
        expect(full.musicSync).toEqual([
            expect.objectContaining({ service: 'tidarr', paused: true, playlists: expect.arrayContaining([expect.objectContaining({ id: SYNC[0]!.id, quality: 'high' })]) })
        ]);
        expect(full.musicSync?.[0]?.playlists.find(p => p.id === SYNC[1]!.id)?.paused).toBe(true);

        const standard = await buildStackHealth([adapter], { detail: 'standard', limit: 50 });
        expect(standard.musicSync).toBeUndefined();
    });
});

describe('TidarrAdapter errors never carry a secret', () => {
    const cases: [number, string][] = [
        [401, 'AuthFailed'],
        [403, 'AuthFailed'],
        [404, 'NotFound'],
        [429, 'RateLimited'],
        [500, 'UpstreamError'],
        [503, 'UpstreamError']
    ];

    for (const [status, kind] of cases) {
        it(`maps HTTP ${status} to ${kind}, without the key or the response body`, async () => {
            const { impl } = fakeTidarr({ failWith: status });
            const err = await failure(new TidarrAdapter(config(), impl).getQueue());

            expect(err).toBeInstanceOf(ServiceError);
            expect(err.kind).toBe(kind);
            const text = `${err.message} ${err.detail} ${err.remedy ?? ''}`;
            expect(text).not.toContain(KEY);
            expect(text).not.toContain('upstream said');
        });
    }

    it('maps a timeout to Timeout, naming the host and nothing else', async () => {
        const impl = (async () => {
            throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
        }) as unknown as typeof fetch;
        const err = await failure(new TidarrAdapter(config(), impl).getQueue());

        expect(err.kind).toBe('Timeout');
        expect(`${err.message} ${err.remedy ?? ''}`).not.toContain(KEY);
    });

    it('maps a payload that is not a queue to UpstreamError', async () => {
        const impl = (async () => jsonResponse({ unexpected: true })) as unknown as typeof fetch;
        const err = await failure(new TidarrAdapter(config(), impl).getQueue());

        expect(err.kind).toBe('UpstreamError');
    });
});

describe('parseTidalUrl', () => {
    it.each([
        ['https://tidal.com/album/251082404', 'album', '251082404'],
        ['https://tidal.com/browse/album/251082404', 'album', '251082404'],
        ['https://listen.tidal.com/album/251082404', 'album', '251082404'],
        ['https://www.tidal.com/track/77610756/u', 'track', '77610756'],
        ['https://tidal.com/browse/track/77610756?u', 'track', '77610756'],
        ['https://tidal.com/album/1/track/77610756', 'track', '77610756'],
        ['https://tidal.com/playlist/0B7F1C2E-1111-2222-3333-444455556666', 'playlist', '0b7f1c2e-1111-2222-3333-444455556666'],
        ['https://tidal.com/mix/0123456789abcdef0123456789abcd', 'mix', '0123456789abcdef0123456789abcd'],
        ['https://tidal.com/video/123', 'video', '123']
    ])('reads %s as a %s', (raw, type, id) => {
        expect(parseTidalUrl(raw)).toEqual({ type, id });
    });

    it.each([
        ['not a url'],
        ['ftp://tidal.com/album/1'],
        ['https://evil.example/album/1'],
        ['https://tidal.com.evil.example/album/1'],
        ['https://tidal.com@evil.example/album/1'],
        ['https://user:pass@tidal.com/album/1'],
        ['https://tidal.com:8443/album/1'],
        ['https://tidal.com/album/abc'],
        ['https://tidal.com/album/1/../../api/remove-all'],
        ['https://tidal.com/playlist/not-a-uuid'],
        ['https://tidal.com/favorite_tracks/1'],
        ['https://tidal.com/album']
    ])('refuses %s', raw => {
        expect(() => parseTidalUrl(raw)).toThrow(ServiceError);
    });

    it('rebuilds a canonical listen.tidal.com address rather than forwarding the input', () => {
        expect(tidalUrl(parseTidalUrl('http://www.tidal.com/browse/album/5/u?utm=x'))).toBe('https://listen.tidal.com/album/5');
    });
});

describe('manage_music add', () => {
    it('previews, then posts one canonical item to /api/save once confirmed', async () => {
        const h = harness();
        const preview = await h.call('manage_music', { action: 'add', url: 'https://tidal.com/browse/album/42?u', quality: 'max' });

        expect(preview.structuredContent.applied).toBe(false);
        expect(preview.structuredContent.tier).toBe('safe');
        expect(h.writes()).toEqual([]);

        const applied = await h.call('manage_music', {
            action: 'add',
            url: 'https://tidal.com/browse/album/42?u',
            quality: 'max',
            confirm: preview.structuredContent.confirm_token
        });
        expect(applied.structuredContent.applied).toBe(true);
        expect(h.writes()).toEqual([
            expect.objectContaining({
                method: 'POST',
                path: '/api/save',
                body: { item: { id: '42', url: 'https://listen.tidal.com/album/42', type: 'album', status: 'queue_download', quality: 'max' } }
            })
        ]);
    });

    it('leaves quality to Tidarr when none is given', async () => {
        const h = harness();
        await h.confirmed('manage_music', { action: 'add', url: 'https://tidal.com/track/9' });

        expect((h.writes()[0]?.body as { item: Row }).item).not.toHaveProperty('quality');
    });

    it('refuses an artist link, which would queue a whole discography', async () => {
        const h = harness();
        await expect(h.call('manage_music', { action: 'add', url: 'https://tidal.com/artist/3566315' })).rejects.toThrow(/discography/);
        expect(h.writes()).toEqual([]);
    });

    it('refuses a link to any host but Tidal', async () => {
        const h = harness();
        await expect(h.call('manage_music', { action: 'add', url: 'https://evil.example/album/1' })).rejects.toThrow(/not a Tidal host/);
        expect(h.writes()).toEqual([]);
    });

    it('refuses a quality Tidarr does not have', async () => {
        const h = harness();
        // The input schema refuses it before any plan runs.
        expect(() => h.call('manage_music', { action: 'add', url: 'https://tidal.com/album/1', quality: 'lossless' })).toThrow(/quality/);
    });

    it('is a no-op for an item still in progress, and warns before re-downloading a finished one', async () => {
        const h = harness();
        const inProgress = await h.call('manage_music', { action: 'add', url: 'https://tidal.com/album/251082404' });
        expect(inProgress.structuredContent.noop).toBe(true);

        const finished = await h.call('manage_music', { action: 'add', url: 'https://tidal.com/track/111' });
        expect(finished.structuredContent.noop).toBe(false);
        expect(finished.structuredContent.effects.join(' ')).toMatch(/second time/);
    });

    it('says when the queue is paused', async () => {
        const h = harness({ paused: true });
        const preview = await h.call('manage_music', { action: 'add', url: 'https://tidal.com/album/42' });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/paused/);
    });

    it('is refused when safe writes are off, and never reaches Tidarr', async () => {
        const h = harness({ perms: { safe_write: false, destructive: false } });
        await expect(h.call('manage_music', { action: 'add', url: 'https://tidal.com/album/42' })).rejects.toThrow(/safe_write/);
        expect(h.writes()).toEqual([]);
        expect(h.audit.recent(1)[0]).toMatchObject({ outcome: 'denied', tool: 'manage_music', service: 'tidarr' });
    });

    it('audits what it did, and never the key', async () => {
        const h = harness();
        await h.confirmed('manage_music', { action: 'add', url: 'https://tidal.com/album/42', quality: 'high' });

        const rows = h.audit.recent(10);
        expect(rows[0]).toMatchObject({ outcome: 'applied', tool: 'manage_music', service: 'tidarr', tier: 'safe', target: 'tidarr:album/42' });
        expect(JSON.stringify(rows)).not.toContain(KEY);
    });
});

describe('manage_music retry', () => {
    it('retries one failed item by id', async () => {
        const h = harness();
        const result = await h.confirmed('manage_music', { action: 'retry', id: '222' });

        expect(result.structuredContent.applied).toBe(true);
        expect(h.writes()).toEqual([expect.objectContaining({ method: 'POST', path: '/api/retry-post-processing', body: { id: '222' } })]);
    });

    it('refuses an item that has not failed, rather than letting Tidarr answer a bare 500', async () => {
        const h = harness();
        await expect(h.call('manage_music', { action: 'retry', id: '251082404' })).rejects.toThrow(/only a failed item/);
        expect(h.writes()).toEqual([]);
    });

    it('refuses an id that is not in the queue', async () => {
        const h = harness();
        await expect(h.call('manage_music', { action: 'retry', id: '999' })).rejects.toThrow(/get_queue/);
    });
});

describe('manage_music sync', () => {
    const playlist = 'https://tidal.com/playlist/11111111-2222-3333-4444-555555555555';

    it('adds a playlist with the quality it was given', async () => {
        const h = harness();
        await h.confirmed('manage_music', { action: 'sync_add', url: playlist, quality: 'high', title: 'Road trip' });

        expect(h.writes()).toEqual([
            expect.objectContaining({
                method: 'POST',
                path: '/api/sync/save',
                body: {
                    item: {
                        id: '11111111-2222-3333-4444-555555555555',
                        title: 'Road trip',
                        url: 'https://listen.tidal.com/playlist/11111111-2222-3333-4444-555555555555',
                        type: 'playlist',
                        quality: 'high'
                    }
                }
            })
        ]);
    });

    it('needs a quality, since Tidarr applies no default to synced playlists', async () => {
        const h = harness();
        await expect(h.call('manage_music', { action: 'sync_add', url: playlist })).rejects.toThrow(/quality/);
    });

    it('syncs playlists only', async () => {
        const h = harness();
        await expect(h.call('manage_music', { action: 'sync_add', url: 'https://tidal.com/album/1', quality: 'high' })).rejects.toThrow(
            /only a playlist/
        );
    });

    it('is a no-op for a playlist already synced', async () => {
        const h = harness();
        const result = await h.call('manage_music', { action: 'sync_add', url: `https://tidal.com/playlist/${SYNC[0]!.id as string}`, quality: 'high' });
        expect(result.structuredContent.noop).toBe(true);
    });

    it('removes one playlist at destructive tier', async () => {
        const h = harness();
        const preview = await h.call('manage_music', { action: 'sync_remove', id: SYNC[0]!.id });
        expect(preview.structuredContent.tier).toBe('destructive');

        await h.confirmed('manage_music', { action: 'sync_remove', id: SYNC[0]!.id });
        expect(h.writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/sync/remove', body: { id: SYNC[0]!.id } })]);
    });

    it('refuses to remove with only safe writes granted', async () => {
        const h = harness({ perms: { safe_write: true, destructive: false } });
        await expect(h.call('manage_music', { action: 'sync_remove', id: SYNC[0]!.id })).rejects.toThrow(/destructive/);
        expect(h.writes()).toEqual([]);
    });

    it('names the synced ids when asked to remove one that is not there', async () => {
        const h = harness();
        await expect(h.call('manage_music', { action: 'sync_remove', id: 'nope' })).rejects.toThrow(ServiceError);
        const err = await failure(h.call('manage_music', { action: 'sync_remove', id: 'nope' }));
        expect(err.remedy).toContain(SYNC[0]!.id as string);
    });

    it('runs the sync now, naming only the unpaused playlists', async () => {
        const h = harness();
        const preview = await h.call('manage_music', { action: 'sync_now' });
        expect(preview.structuredContent.summary).toMatch(/1 synced playlist/);

        await h.confirmed('manage_music', { action: 'sync_now' });
        expect(h.writes()).toEqual([expect.objectContaining({ method: 'POST', path: '/api/sync/trigger' })]);
    });
});

describe('Tidarr through the shared tools', () => {
    it('remove_queue_item deletes one item, and says partial data always goes', async () => {
        const h = harness();
        const preview = await h.call('remove_queue_item', { service: 'tidarr', id: '251082404', remove_from_client: false });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/always deletes partial data/);

        await h.confirmed('remove_queue_item', { service: 'tidarr', id: '251082404', remove_from_client: false });
        expect(h.writes()).toEqual([expect.objectContaining({ method: 'DELETE', path: '/api/remove', body: { id: '251082404' } })]);
    });

    it('pause_downloads pauses the whole queue and warns the current download starts over', async () => {
        const h = harness();
        const preview = await h.call('pause_downloads', { service: 'tidarr', action: 'pause' });
        expect(preview.structuredContent.effects.join(' ')).toMatch(/starts over/);

        await h.confirmed('pause_downloads', { service: 'tidarr', action: 'pause' });
        expect(h.writes()).toEqual([expect.objectContaining({ method: 'POST', path: '/api/queue/pause' })]);
    });

    it('pause_downloads refuses a single item, which Tidarr cannot pause', async () => {
        const h = harness();
        await expect(h.call('pause_downloads', { service: 'tidarr', action: 'pause', id: '251082404' })).rejects.toThrow(/whole queue/);
    });

    it('pause_downloads refuses a speed limit, which Tidarr does not have', async () => {
        const h = harness();
        await expect(h.call('pause_downloads', { service: 'tidarr', action: 'limit', speed_limit_kbps: 100 })).rejects.toThrow(
            /no download speed limit/
        );
    });
});

describe('the allowlist', () => {
    it('reaches only allowlisted endpoints across every action, and none of the forbidden ones', async () => {
        const h = harness();
        await h.call('manage_music', { action: 'add', url: 'https://tidal.com/album/42', dry_run: true });
        await h.confirmed('manage_music', { action: 'add', url: 'https://tidal.com/album/42' });
        await h.confirmed('manage_music', { action: 'retry', id: '222' });
        await h.confirmed('manage_music', { action: 'sync_add', url: 'https://tidal.com/playlist/11111111-2222-3333-4444-555555555555', quality: 'low' });
        await h.confirmed('manage_music', { action: 'sync_remove', id: SYNC[0]!.id });
        await h.confirmed('manage_music', { action: 'sync_now' });
        await h.confirmed('remove_queue_item', { service: 'tidarr', id: '222' });
        await h.confirmed('pause_downloads', { service: 'tidarr', action: 'pause' });
        await h.adapters[0]!.testConnection();

        const reached = new Set(h.seen.map(s => `${s.method} ${s.path}`));
        for (const route of reached) expect(ALLOWED.has(route), route).toBe(true);
        for (const path of FORBIDDEN) expect(h.seen.some(s => s.path.startsWith(path)), path).toBe(false);
    });

    it('offers no action that clears the queue, the history or the sync list', async () => {
        const h = harness();
        for (const action of ['remove_all', 'remove_finished', 'retry_failed', 'sync_remove_all', 'clear_history']) {
            expect(() => h.call('manage_music', { action })).toThrow(/action/);
        }
        expect(h.writes()).toEqual([]);
    });
});

describe('Tidarr configuration', () => {
    const parse = (services: unknown) => ConfigSchema.safeParse({ auth: { tokens: [] }, services });

    it('builds an adapter from a tidarr block', () => {
        const parsed = parse({ tidarr: { url: 'http://tidarr:8484', api_key: 'k' } });
        expect(parsed.success).toBe(true);
        const adapters = buildAdapters(parsed.data!);
        expect(adapters.map(a => a.id)).toEqual(['tidarr']);
        expect(adapters[0]).toBeInstanceOf(TidarrAdapter);
    });

    it('builds nothing for Tidarr when the block is absent', () => {
        const parsed = parse({});
        expect(buildAdapters(parsed.data!)).toEqual([]);
    });

    it('refuses a list of Tidarr instances', () => {
        expect(parse({ tidarr: [{ name: 'a', url: 'http://tidarr:8484', api_key: 'k' }] }).success).toBe(false);
    });

    it('refuses an empty key and a misspelled field', () => {
        expect(parse({ tidarr: { url: 'http://tidarr:8484', api_key: '' } }).success).toBe(false);
        expect(parse({ tidarr: { url: 'http://tidarr:8484', apikey: 'k' } }).success).toBe(false);
    });

    it('grants no writes unless the config says so', () => {
        const parsed = parse({ tidarr: { url: 'http://tidarr:8484', api_key: 'k' } });
        expect(parsed.data!.services.tidarr?.permissions).toEqual({ safe_write: false, destructive: false });
    });
});
