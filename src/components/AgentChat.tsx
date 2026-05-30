import { useRef, useState } from "preact/hooks";
import { api, type Business } from "../services/api";

interface Msg {
  role: "user" | "agent";
  text: string;
  provider?: string;
}

const SUGGESTIONS = [
  "What should I know to run my business today?",
  "Any construction or road work that could affect foot traffic?",
  "Are there events nearby I could capitalize on?",
  "What's the weather and air quality impact today?",
];

export function AgentChat({ business }: { business: Business }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await api.agent({ businessId: business.id, question });
      setMessages((m) => [...m, { role: "agent", text: res.text, provider: res.provider }]);
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "agent", text: `Error: ${err instanceof Error ? err.message : "failed"}` },
      ]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight));
    }
  }

  return (
    <section class="panel agent panel-wide">
      <header class="panel-header">
        <div class="panel-heading">
          <h2 class="panel-title">Your Toronto Agent</h2>
          <p class="panel-desc">
            A location-tailored assistant grounded in live civic data around {business.name}.
          </p>
        </div>
        <span class="count-pill">{business.businessType}</span>
      </header>

      <div class="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div class="chat-empty">
            <p class="muted">
              Ask anything about how Toronto conditions affect <strong>{business.name}</strong>.
            </p>
            <div class="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} class="chip-btn" onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} class={`bubble bubble-${m.role}`}>
            {m.role === "agent" && m.provider && <span class="bubble-tag">{m.provider}</span>}
            <div class="bubble-text">{m.text}</div>
          </div>
        ))}
        {busy && <div class="bubble bubble-agent"><div class="bubble-text muted">Thinking…</div></div>}
      </div>

      <form
        class="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder="Ask your agent…"
          disabled={busy}
        />
        <button type="submit" class="btn-primary" disabled={busy || !input.trim()}>Send</button>
      </form>
    </section>
  );
}
