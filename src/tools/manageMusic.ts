import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { parseTidalUrl } from '../services/tidarr.ts';
import {
    hasMusicQueue,
    hasMusicSync,
    TIDAL_QUALITIES,
    type MusicQueueCapable,
    type MusicSyncCapable,
    type ServiceAdapter
} from '../services/types.ts';
import { resolveInstance } from './resolveInstance.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

/**
 * Everything Tidarr does that no other tool here covers: download a Tidal link,
 * retry a download whose files arrived but never reached the library, and the
 * playlists it re-downloads on a schedule.
 *
 * **One tool, five actions**, for the reason `pause_downloads` and
 * `trigger_scan` are one tool each: the forty-tool ceiling in CONTRIBUTING.md.
 * Its queue, its pause and single-item removal are not here — they are
 * `get_queue`, `pause_downloads` and `remove_queue_item`, like every other
 * download client's.
 *
 * Tier is per action. `sync_remove` is destructive because it drops the
 * entry's stored quality and sync history, and Tidarr has no undo for that
 * short of re-adding it by hand; everything else is safe — an added download
 * comes back off with `remove_queue_item`, and nothing on disk is lost.
 *
 * Never a bulk form: one link, one id, one playlist per call. Tidarr's
 * `remove-all`, `retry-failed` and `sync/remove-all` are not reachable from
 * here, and an artist link — a whole discography in one entry — is refused.
 */

const ACTIONS = ['add', 'retry', 'sync_add', 'sync_remove', 'sync_now'] as const;

const findAdapter = (adapters: readonly ServiceAdapter[]): ServiceAdapter & MusicQueueCapable & MusicSyncCapable => {
    const adapter = resolveInstance(adapters, 'tidarr');
    if (!hasMusicQueue(adapter) || !hasMusicSync(adapter)) {
        throw new ServiceError('NotFound', adapter.id, `${adapter.id} cannot download music`);
    }
    return adapter;
};

const need = <T>(value: T | undefined, message: string): T => {
    if (value === undefined || value === '') throw new Error(message);
    return value;
};

export function registerManageMusic(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'manage_music',
        title: 'Download music with Tidarr',
        description:
            'Tidarr, the Tidal downloader. `action: "add"` downloads one Tidal link — an album, track, video, playlist or mix — into the music library; pass the share link as `url`, and `quality` to override Tidarr\'s default. An artist link is refused, since it would queue a whole discography: add albums one at a time. `action: "retry"` re-runs tagging and the move into the library for one failed item whose files already downloaded — take `id` from get_queue, whose `statusMessages` say when that helps. `sync_add` makes Tidarr re-download a playlist on its schedule to pick up new tracks (`url` and `quality` required, `title` optional); `sync_remove` stops that for one playlist `id`; `sync_now` runs every synced playlist now instead of waiting. The synced playlists are listed in stack_health at `detail: "full"` under `musicSync`. The queue itself, pausing it and removing one item are get_queue, pause_downloads and remove_queue_item. Previews by default — call again with the returned `confirm` token to apply it.',
        inputSchema: z.object({
            action: z
                .enum(ACTIONS)
                .describe('add, retry, sync_add, sync_remove or sync_now.'),
            url: z
                .string()
                .min(1)
                .max(500)
                .optional()
                .describe('A Tidal share link, such as https://tidal.com/album/251082404. Required for add and sync_add.'),
            id: z
                .string()
                .min(1)
                .max(100)
                .optional()
                .describe('For retry, the queue id from get_queue. For sync_remove, the playlist id from stack_health\'s musicSync.'),
            quality: z
                .enum(TIDAL_QUALITIES)
                .optional()
                .describe(
                    'low (AAC 96), normal (AAC 320), high (16-bit FLAC) or max (24-bit FLAC). Optional for add, where Tidarr\'s own default applies; required for sync_add.'
                ),
            title: z
                .string()
                .min(1)
                .max(200)
                .optional()
                .describe('For sync_add, the name Tidarr shows for the playlist. Defaults to its id.')
        }),
        service: () => findAdapter(adapters).id,
        operation: 'manage_music',
        tier: ({ action }) => (action === 'sync_remove' ? 'destructive' : 'safe'),

        async plan({ action, url, id, quality, title }): Promise<WritePlan> {
            const adapter = findAdapter(adapters);

            switch (action) {
                case 'add': {
                    const item = parseTidalUrl(need(url, 'add needs `url`: the Tidal share link to download.'));
                    if (item.type === 'artist') {
                        throw new ServiceError('NotFound', adapter.id, 'an artist link would queue the whole discography', {
                            remedy: 'Add the albums you want one at a time, each by its own link.'
                        });
                    }

                    const [items, state] = await Promise.all([adapter.readQueueItems(), adapter.readQueueState()]);
                    const existing = items.find(q => q.id === item.id);
                    const target = `${adapter.id}:${item.type}/${item.id}`;

                    // Re-adding replaces the row in Tidarr, which for an item
                    // still in progress restarts it from nothing.
                    if (existing !== undefined && existing.status !== 'finished' && existing.status !== 'failed') {
                        return {
                            target,
                            summary: `${existing.title} is already in ${adapter.id}'s queue (${existing.status}).`,
                            effects: [],
                            noop: true
                        };
                    }

                    const effects = [
                        `Downloads the ${item.type} into the music library at ${quality ?? 'Tidarr\'s configured default'} quality.`,
                        // There is no Tidal catalogue read here — only Tidarr's
                        // own endpoints — so the preview cannot say what the
                        // link is. Saying so beats implying it was checked.
                        'The preview cannot name it: arr-mcp never calls Tidal itself. Check the link is the one you meant.'
                    ];
                    if (item.type === 'playlist' || item.type === 'mix') {
                        effects.push(`Every track on the ${item.type} is downloaded, so a long one is a long download.`);
                    }
                    if (existing?.status === 'finished') {
                        effects.push('It has already been downloaded once. Adding it again replaces that entry and downloads it a second time.');
                    }
                    if (existing?.status === 'failed') {
                        effects.push('Replaces the failed entry and downloads it from scratch. If only tagging or the move failed, action "retry" is cheaper.');
                    }
                    if (state.paused) {
                        effects.push('The Tidarr queue is paused, so this waits until pause_downloads resumes it.');
                    }
                    effects.push('Undo it with remove_queue_item while it is still queued. Once downloaded, the files stay in the library.');

                    return {
                        target,
                        summary: `Download Tidal ${item.type} ${item.id} with ${adapter.id}.`,
                        effects,
                        args: { action, type: item.type, id: item.id, quality: quality ?? null }
                    };
                }

                case 'retry': {
                    const wanted = need(id, 'retry needs `id`: the failed item\'s id from get_queue.');
                    const item = (await adapter.readQueueItems()).find(q => q.id === wanted);
                    if (item === undefined) {
                        throw new ServiceError('NotFound', adapter.id, `nothing in ${adapter.id}'s queue has id "${wanted}"`, {
                            remedy: 'Take a current id from get_queue.'
                        });
                    }
                    // Tidarr answers a bare 500 for this; refusing here says why.
                    if (item.status !== 'failed') {
                        throw new ServiceError('NotFound', adapter.id, `only a failed item can be retried, and ${wanted} is ${item.status}`);
                    }

                    return {
                        target: `${adapter.id}:${wanted}:retry`,
                        summary: `Retry post-processing of ${item.title} on ${adapter.id}.`,
                        effects: [
                            ...(item.statusMessages ?? []),
                            'Re-runs tagging, permissions and the move into the library using the files already downloaded. Nothing is fetched from Tidal.',
                            'Tidarr refuses this while another item is post-processing. If it does, try again once that one has finished.'
                        ],
                        args: { action, id: wanted }
                    };
                }

                case 'sync_add': {
                    const item = parseTidalUrl(need(url, 'sync_add needs `url`: the Tidal playlist link.'));
                    const chosen = need(
                        quality,
                        'sync_add needs `quality`: Tidarr downloads the playlist at exactly that quality on every run, and has no default for it.'
                    );
                    if (item.type !== 'playlist') {
                        throw new ServiceError('NotFound', adapter.id, `only a playlist can be synced here, and that link is a ${item.type}`, {
                            remedy: 'Use action "add" to download it once.'
                        });
                    }

                    const target = `${adapter.id}:sync/${item.id}`;
                    const existing = (await adapter.readSyncList()).find(s => s.id === item.id);
                    if (existing !== undefined) {
                        return { target, summary: `${existing.title} is already synced by ${adapter.id}.`, effects: [], noop: true };
                    }

                    const name = title?.trim() || `Tidal playlist ${item.id}`;
                    return {
                        target,
                        summary: `Sync the Tidal playlist ${item.id} with ${adapter.id}, as "${name}".`,
                        effects: [
                            'Tidarr re-downloads it on its sync schedule — 03:00 daily unless SYNC_CRON_EXPRESSION says otherwise — picking up tracks added since.',
                            `Every run downloads at ${chosen} quality.`,
                            'Nothing downloads yet. Follow with action "sync_now" to start straight away.'
                        ],
                        args: { action, id: item.id, quality: chosen, title: name }
                    };
                }

                case 'sync_remove': {
                    const wanted = need(id, 'sync_remove needs `id`: the playlist id from stack_health\'s musicSync.');
                    const list = await adapter.readSyncList();
                    const entry = list.find(s => s.id === wanted);
                    if (entry === undefined) {
                        throw new ServiceError('NotFound', adapter.id, `${adapter.id} syncs no playlist with id "${wanted}"`, {
                            remedy:
                                list.length === 0
                                    ? 'Nothing is synced.'
                                    : `Synced ids: ${list.slice(0, 10).map(s => s.id).join(', ')}${list.length > 10 ? ', …' : ''}. stack_health at detail: "full" lists them with their names.`
                        });
                    }

                    return {
                        target: `${adapter.id}:sync/${wanted}`,
                        summary: `Stop syncing ${entry.title} on ${adapter.id}.`,
                        effects: [
                            'No more scheduled downloads of it. Tracks already downloaded stay in the library, and the playlist stays on Tidal.',
                            'Undo it with action "sync_add" and the playlist link — the quality has to be given again.'
                        ],
                        args: { action, id: wanted }
                    };
                }

                case 'sync_now': {
                    const list = await adapter.readSyncList();
                    const active = list.filter(s => s.paused !== true);
                    const target = `${adapter.id}:sync`;
                    if (active.length === 0) {
                        return {
                            target,
                            summary: list.length === 0 ? `${adapter.id} syncs no playlists.` : `Every playlist ${adapter.id} syncs is paused.`,
                            effects: [],
                            noop: true
                        };
                    }

                    return {
                        target,
                        summary: `Queue ${active.length} synced playlist(s) on ${adapter.id} now.`,
                        effects: [
                            `Queues: ${active.map(s => s.title).join(', ')}.`,
                            'A playlist already downloading is skipped, not restarted.',
                            ...(active.length < list.length ? [`${list.length - active.length} paused playlist(s) are left alone.`] : [])
                        ],
                        args: { action }
                    };
                }
            }
        },

        async apply(_plan, { action, url, id, quality, title }) {
            const adapter = findAdapter(adapters);

            switch (action) {
                case 'add': {
                    const item = parseTidalUrl(url ?? '');
                    await adapter.addToQueue(item, quality);
                    return { queued: `${adapter.id}:${item.type}/${item.id}` };
                }
                case 'retry':
                    await adapter.retryPostProcessing(id ?? '');
                    return { retried: `${adapter.id}:${id}` };
                case 'sync_add': {
                    const item = parseTidalUrl(url ?? '');
                    const chosen = need(quality, 'sync_add needs `quality`.');
                    await adapter.addToSyncList(item, title?.trim() || `Tidal playlist ${item.id}`, chosen);
                    return { synced: `${adapter.id}:sync/${item.id}` };
                }
                case 'sync_remove':
                    await adapter.removeFromSyncList(id ?? '');
                    return { unsynced: `${adapter.id}:sync/${id}` };
                case 'sync_now':
                    await adapter.triggerSync();
                    return { triggered: `${adapter.id}:sync` };
            }
        }
    });
}
