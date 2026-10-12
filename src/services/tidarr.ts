import type { ConfigByService, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type MusicQueueCapable,
    type MusicQueueState,
    type MusicSyncItem,
    type MusicSyncCapable,
    type PauseCapable,
    type PauseState,
    type QueueCapable,
    type QueueItem,
    type QueueRemoveCapable,
    type ServiceAdapter,
    TIDAL_QUALITIES,
    type TidalItem,
    type TidalQuality
} from './types.ts';

/**
 * Hand-written against Tidarr's REST API (`docs/API_DOCUMENTATION.md` and
 * `api/src/routes/` in cstaelen/tidarr, 1.2.8). It publishes no OpenAPI
 * document.
 *
 * **An allowlist, not a client.** Every path this adapter can reach is a
 * literal below; nothing builds a path from caller input. The endpoints left
 * out are left out on purpose and must stay out: `/api/settings` and
 * `/api/tiddl/config` return the Tidal access and refresh tokens, `/api/api-key`
 * returns this adapter's own credential, `/api/token` logs Tidarr out of Tidal,
 * and `remove-all`, `remove-finished`, `retry-failed`, `sync/remove-all` and
 * `DELETE /api/history/list` are the bulk forms of writes this server only
 * ever does one item at a time. `test/tidarr.test.ts` asserts the list.
 *
 * The key travels as `X-Api-Key`, never as `?apikey=`, which Tidarr also
 * accepts: a query string reaches proxy logs.
 */

type RawQueueItem = {
    id?: string | number;
    type?: string;
    title?: string;
    artist?: string;
    quality?: string;
    status?: string;
    error?: boolean;
    /** Only on `status: "error"`. */
    errorStage?: 'download' | 'post_processing';
};

type RawQueueList = { total?: number; queue?: RawQueueItem[] };

type RawQueueStatus = {
    isPaused?: boolean;
    /** Items downloaded in the current batch, with `DOWNLOAD_BATCH_SIZE` set. */
    batchCount?: number;
    /** Epoch **milliseconds** of the scheduled auto-resume, or null. */
    batchResumeAt?: number | null;
};

type RawSyncItem = {
    id?: string | number;
    title?: string;
    artist?: string;
    type?: string;
    quality?: string;
    lastUpdate?: string;
    paused?: boolean;
};

/**
 * Tidarr's own status vocabulary, in the words `get_queue` uses for the other
 * clients. `queue` is a legacy spelling Tidarr still accepts on disk.
 */
const STATUS: Record<string, string> = {
    queue_download: 'queued',
    queue: 'queued',
    download: 'downloading',
    queue_processing: 'queued for processing',
    processing: 'processing',
    error: 'failed'
};

/**
 * What a failed item needs next depends on where it failed, and Tidarr says
 * which: a post-processing failure keeps its downloaded files, so it can be
 * retried without fetching anything from Tidal again.
 */
const STAGE_MESSAGE: Record<string, string> = {
    post_processing:
        'failed after downloading, while tagging or moving the files — manage_music with action "retry" re-runs that step without downloading again',
    download:
        'failed while downloading — manage_music with action "retry" only helps if some tracks were already saved; otherwise remove it and add it again'
};

const isQuality = (value: string | undefined): value is TidalQuality =>
    (TIDAL_QUALITIES as readonly (string | undefined)[]).includes(value);

export class TidarrAdapter
    implements ServiceAdapter, QueueCapable, QueueRemoveCapable, PauseCapable, MusicQueueCapable, MusicSyncCapable
{
    readonly type: ServiceId = 'tidarr';
    /** Single-instance, like Profilarr: one queue, one sync list. */
    readonly id: string = 'tidarr';
    readonly #http: ServiceHttp;

    constructor(config: ConfigByService['tidarr'], fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    /**
     * Tidarr reports its version only inside `/api/settings`, beside the Tidal
     * tokens, and that endpoint is the first thing this adapter refuses to
     * read. So there is no version to report, and saying so is better than
     * fetching secrets to find one.
     */
    async getVersion(): Promise<string> {
        throw new ServiceError('NotFound', this.id, 'Tidarr publishes its version only alongside its Tidal credentials', {
            remedy: 'Read it in the Tidarr web UI. arr-mcp does not call /api/settings.'
        });
    }

    /** Reachability and a valid key, proved by the cheapest authenticated read. */
    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, async () => {
            await this.readQueueState();
            return undefined;
        });
    }

    /**
     * Everything not yet finished. Tidarr keeps finished items in the same list
     * until someone clears them, often hundreds of them, and `get_queue` is the
     * answer to "what is downloading or stuck" — a finished album is neither.
     */
    async getQueue(): Promise<QueueItem[]> {
        return (await this.#readQueue())
            .filter(item => item.status !== 'finished')
            .map(item => this.#toQueueItem(item));
    }

    /** Tidarr has no blocklist. */
    readonly supportsBlocklist = false;

    /**
     * Tidarr deletes the item's processing folder on every removal; there is no
     * form that keeps partial data. Declared so `remove_queue_item` can say so
     * instead of describing a `remove_from_client: false` that never happens.
     */
    readonly removalDeletesData = true;

    /**
     * `DELETE /api/remove` answers 204 whether or not the id existed, so the
     * caller confirms the item is there first — `remove_queue_item` does, from
     * the live queue.
     */
    async removeQueueItem(id: string): Promise<void> {
        await this.#http.deleteWithBody('/api/remove', { id });
    }

    async readPauseState(id?: string): Promise<PauseState> {
        this.#refuseItemPause(id);
        const state = await this.readQueueState();
        return {
            paused: state.paused,
            scope: 'the Tidarr queue',
            // The generic preview promises that partial downloads resume where
            // they left off. On Tidarr they do not, and an album interrupted
            // at track nine starts again from track one.
            pauseNote:
                'Tidarr cancels the item it is downloading and puts it back in the queue; the partial download is discarded and starts over on resume.'
        };
    }

    async setPaused(paused: boolean, id?: string): Promise<void> {
        this.#refuseItemPause(id);
        await this.#http.post(paused ? '/api/queue/pause' : '/api/queue/resume', undefined, true);
    }

    async readQueueState(): Promise<MusicQueueState> {
        const body = await this.#http.get<RawQueueStatus>('/api/queue/status');
        if (typeof body?.isPaused !== 'boolean') {
            throw new ServiceError('UpstreamError', this.id, 'queue status carried no isPaused flag');
        }
        const resumeAt =
            typeof body.batchResumeAt === 'number' && Number.isFinite(body.batchResumeAt)
                ? new Date(body.batchResumeAt).toISOString()
                : undefined;
        return {
            service: this.id,
            paused: body.isPaused,
            ...(typeof body.batchCount === 'number' && body.batchCount > 0 ? { batchCount: body.batchCount } : {}),
            ...(resumeAt === undefined ? {} : { batchResumeAt: resumeAt })
        };
    }

    /**
     * Every row, finished included, for the write tools: "is this already
     * here" has to see a finished album too, since adding it again replaces
     * the finished row and downloads it a second time.
     */
    async readQueueItems(): Promise<QueueItem[]> {
        return (await this.#readQueue()).map(item => this.#toQueueItem(item));
    }

    /**
     * The URL is rebuilt here from type and id rather than forwarded, so
     * whatever the caller pasted never reaches Tidarr — only a canonical
     * `listen.tidal.com` address can.
     *
     * Tidarr answers 201 with a plain-text "Created", hence the discarded body.
     */
    async addToQueue(item: TidalItem, quality?: TidalQuality): Promise<void> {
        await this.#http.post(
            '/api/save',
            {
                item: {
                    id: item.id,
                    url: tidalUrl(item),
                    type: item.type,
                    status: 'queue_download',
                    ...(quality === undefined ? {} : { quality })
                }
            },
            true
        );
    }

    /**
     * Tidarr answers 500 for an id it does not have, one not in error, or while
     * another item is post-processing — so the tool checks the first two
     * against the live queue before calling this.
     */
    async retryPostProcessing(id: string): Promise<void> {
        await this.#http.post('/api/retry-post-processing', { id }, true);
    }

    async readSyncList(): Promise<MusicSyncItem[]> {
        const body = await this.#http.get<RawSyncItem[]>('/api/sync/list');
        if (!Array.isArray(body)) {
            throw new ServiceError('UpstreamError', this.id, 'sync list was not a list');
        }
        return body
            .filter((s): s is RawSyncItem & { id: string | number } => typeof s.id === 'string' || typeof s.id === 'number')
            .map(s => ({
                service: this.id,
                id: String(s.id),
                type: s.type ?? 'unknown',
                // Playlist names are chosen by whoever made the playlist.
                title: fenceText(s.title ?? '', { service: this.id, field: 'title' }),
                ...(isQuality(s.quality) ? { quality: s.quality } : {}),
                ...(s.lastUpdate === undefined ? {} : { lastUpdate: s.lastUpdate }),
                ...(s.paused === true ? { paused: true as const } : {})
            }));
    }

    /**
     * Tidarr stores what it is given and queues it with exactly that quality on
     * every run — the server default that `/api/save` falls back to is not
     * applied here, which is why `quality` is required.
     */
    async addToSyncList(item: TidalItem, title: string, quality: TidalQuality): Promise<void> {
        await this.#http.post(
            '/api/sync/save',
            { item: { id: item.id, title, url: tidalUrl(item), type: item.type, quality } },
            true
        );
    }

    async removeFromSyncList(id: string): Promise<void> {
        await this.#http.deleteWithBody('/api/sync/remove', { id });
    }

    /** Queues every unpaused sync entry now, rather than at the next cron run. */
    async triggerSync(): Promise<void> {
        await this.#http.post('/api/sync/trigger', undefined, true);
    }

    #refuseItemPause(id: string | undefined): void {
        if (id === undefined) return;
        throw new ServiceError('NotFound', this.id, 'Tidarr pauses its whole queue, never one item', {
            remedy: 'Omit `id` to pause the Tidarr queue, or remove the one item with remove_queue_item.'
        });
    }

    async #readQueue(): Promise<RawQueueItem[]> {
        const body = await this.#http.get<RawQueueList>('/api/queue/list');
        if (!Array.isArray(body?.queue)) {
            throw new ServiceError('UpstreamError', this.id, 'queue list carried no queue array');
        }
        return body.queue.filter(
            (item): item is RawQueueItem & { id: string | number } =>
                typeof item.id === 'string' || typeof item.id === 'number'
        );
    }

    #toQueueItem(item: RawQueueItem): QueueItem {
        const status = item.status ?? 'unknown';
        // Artist and title come from Tidal's catalogue, which uploaders and
        // labels write, so they are fenced like any release name.
        const name = [item.artist, item.title].filter(s => typeof s === 'string' && s !== '').join(' — ');
        const stage = status === 'error' && item.errorStage !== undefined ? STAGE_MESSAGE[item.errorStage] : undefined;
        return {
            service: this.id,
            id: String(item.id),
            title: fenceText(name, { service: this.id, field: 'title' }),
            status: STATUS[status] ?? status,
            protocol: 'tidal',
            ...(item.type === undefined ? {} : { mediaType: item.type }),
            ...(item.quality === undefined ? {} : { quality: item.quality }),
            ...(stage === undefined ? {} : { statusMessages: [stage] })
        };
    }
}

/** The one address Tidarr is ever handed for an item. */
export const tidalUrl = (item: TidalItem): string => `https://listen.tidal.com/${item.type}/${item.id}`;

/** Every host Tidal shares links from. Anything else is refused, not fetched. */
const TIDAL_HOSTS = new Set(['tidal.com', 'www.tidal.com', 'listen.tidal.com']);

/** What each kind of id looks like on Tidal. A path segment that fails these
 *  is not an id, and nothing past this point ever sees it. */
const ID_SHAPE: Record<string, RegExp> = {
    album: /^\d{1,15}$/,
    track: /^\d{1,15}$/,
    video: /^\d{1,15}$/,
    artist: /^\d{1,15}$/,
    playlist: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    mix: /^[0-9a-z]{8,64}$/i
};

/**
 * A Tidal share link, resolved to the one thing it names.
 *
 * Accepts the forms Tidal hands out — `tidal.com/album/1`,
 * `tidal.com/browse/album/1`, `listen.tidal.com/album/1`, a trailing `/u` or
 * `?u` from the share sheet, and `/album/1/track/2`, which names the track.
 * The query string is dropped, and the caller rebuilds the URL with
 * `tidalUrl`, so nothing typed here reaches Tidarr verbatim.
 */
export function parseTidalUrl(raw: string): TidalItem {
    const refuse = (why: string): never => {
        throw new ServiceError('NotFound', 'tidarr', `not a Tidal link Tidarr can download: ${why}`, {
            remedy: 'Paste a share link such as https://tidal.com/album/251082404 or https://tidal.com/playlist/<uuid>.'
        });
    };

    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return refuse('it is not a URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return refuse('it is not an http(s) link');
    if (url.username !== '' || url.password !== '' || url.port !== '') return refuse('it carries credentials or a port');
    if (!TIDAL_HOSTS.has(url.hostname.toLowerCase())) return refuse(`${url.hostname} is not a Tidal host`);

    const segments = url.pathname.split('/').filter(s => s !== '');
    if (segments[0] === 'browse') segments.shift();
    if (segments.at(-1) === 'u') segments.pop();
    // `/album/1/track/2` is a track seen from its album.
    if (segments.length === 4 && segments[0] === 'album' && segments[2] === 'track') segments.splice(0, 2);
    if (segments.length !== 2) return refuse('the path does not name one album, track, video, playlist, mix or artist');

    const [type, id] = segments as [string, string];
    const shape = ID_SHAPE[type];
    if (shape === undefined) return refuse(`"${type}" is not something Tidarr downloads`);
    if (!shape.test(id)) return refuse(`"${id}" is not a ${type} id`);
    return { type, id: type === 'playlist' ? id.toLowerCase() : id };
}
