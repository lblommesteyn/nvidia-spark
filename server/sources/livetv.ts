/**
 * Live TV resolver for Toronto news channels.
 *
 * YouTube live stream IDs rotate over time, so we resolve the *current* live
 * video for a channel by scraping its `/@handle/live` page and extracting the
 * `"videoId":"..."` that the watch page is built around. The result is cached
 * for a few minutes (mirrors WorldMonitor's LiveNewsPanel approach).
 */

import { cached, nowIso } from "../cache.ts";

export interface LiveChannel {
  id: string;
  name: string;
  handle: string;
  description: string;
  /**
   * Optional pinned YouTube live video id. When set, we embed this stream
   * directly instead of scraping the channel's `/live` page — useful for a
   * persistent feed (e.g. CBC Toronto) whose live id is known and stable.
   */
  videoId?: string;
}

/** Toronto-relevant live news channels (ordered: CP24 first). */
export const LIVE_CHANNELS: LiveChannel[] = [
  {
    id: "cp24",
    name: "CP24",
    handle: "CP24",
    description: "Toronto's 24-hour breaking news, traffic and weather channel.",
  },
  {
    id: "citynews",
    name: "CityNews Toronto",
    handle: "CityNews",
    description: "Local Toronto headlines, civic affairs and live coverage.",
  },
  {
    id: "globalnews",
    name: "Global News",
    handle: "globalnews",
    description: "National + Ontario live news with frequent Toronto segments.",
  },
  {
    id: "cbcnews",
    name: "CBC Toronto",
    handle: "cbcnews",
    description: "CBC's Toronto live stream — local news, weather and civic coverage.",
    videoId: "mM3kOpgjm98",
  },
];

export interface LiveResolution {
  channel: LiveChannel;
  videoId: string | null;
  embedUrl: string | null;
  status: "live" | "demo" | "error";
  fetchedAt: string;
  note?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Scrape the channel's live page and pull the current live videoId. */
async function resolveVideoId(handle: string): Promise<string | null> {
  const url = `https://www.youtube.com/@${handle}/live`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-CA,en;q=0.9" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    // The canonical live video id appears in several forms; try the most
    // reliable ones in order.
    const patterns = [
      /"videoId":"([\w-]{11})"/,
      /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})">/,
      /watch\?v=([\w-]{11})/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m) return m[1];
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveChannel(id: string): Promise<LiveResolution | null> {
  const channel = LIVE_CHANNELS.find((c) => c.id === id);
  if (!channel) return null;
  // Pinned stream: embed the known live id directly, no scrape needed.
  if (channel.videoId) {
    return {
      channel,
      videoId: channel.videoId,
      embedUrl: `https://www.youtube.com/embed/${channel.videoId}?autoplay=1&mute=1&playsinline=1`,
      status: "live",
      fetchedAt: nowIso(),
    };
  }
  try {
    const videoId = await cached(
      `livetv:${channel.handle}`,
      () => resolveVideoId(channel.handle),
      8 * 60 * 1000, // 8 min — live IDs are stable over short windows
    );
    if (!videoId) {
      return {
        channel,
        videoId: null,
        embedUrl: null,
        status: "demo",
        fetchedAt: nowIso(),
        note: "No live stream resolved (channel may be off-air).",
      };
    }
    return {
      channel,
      videoId,
      embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&playsinline=1`,
      status: "live",
      fetchedAt: nowIso(),
    };
  } catch (err) {
    return {
      channel,
      videoId: null,
      embedUrl: null,
      status: "error",
      fetchedAt: nowIso(),
      note: err instanceof Error ? err.message : "resolve error",
    };
  }
}
