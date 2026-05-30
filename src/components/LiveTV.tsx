import { useEffect, useState } from "preact/hooks";
import { api, type LiveChannelSummary, type LiveResolution } from "../services/api";

/**
 * Live Toronto news TV tile. Lists available channels and embeds the currently
 * resolved YouTube live stream (CP24, CityNews, Global, CBC). The live video id
 * is resolved server-side and rotates, so we re-fetch on channel change.
 */
export function LiveTV() {
  const [channels, setChannels] = useState<LiveChannelSummary[]>([]);
  const [activeId, setActiveId] = useState<string>("cbcnews");
  const [stream, setStream] = useState<LiveResolution | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.liveChannels().then((list) => {
      setChannels(list);
      if (list.length && !list.some((c) => c.id === activeId)) setActiveId(list[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStream(null);
    api.liveChannel(activeId)
      .then((r) => { if (!cancelled) setStream(r); })
      .catch(() => { if (!cancelled) setStream(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  const active = channels.find((c) => c.id === activeId);

  return (
    <div class="livetv">
      <div class="livetv-tabs">
        {channels.map((c) => (
          <button
            key={c.id}
            class={`livetv-tab${c.id === activeId ? " is-active" : ""}`}
            onClick={() => setActiveId(c.id)}
            title={c.description}
          >
            {c.name}
          </button>
        ))}
      </div>

      <div class="livetv-screen">
        {loading && <div class="livetv-msg">Resolving live stream…</div>}
        {!loading && stream?.embedUrl && (
          <iframe
            class="livetv-frame"
            src={stream.embedUrl}
            title={stream.channel.name}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        )}
        {!loading && !stream?.embedUrl && (
          <div class="livetv-msg">
            {active?.name ?? "Channel"} is off-air right now.
            {stream?.note && <span class="muted"> {stream.note}</span>}
          </div>
        )}
      </div>

      {active && <div class="livetv-desc muted">{active.description}</div>}
    </div>
  );
}
