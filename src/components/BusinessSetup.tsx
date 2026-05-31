import { useState } from "preact/hooks";
import { api, type Business } from "../services/api";

const BUSINESS_TYPES = [
  "cafe",
  "restaurant",
  "bar / pub",
  "retail store",
  "grocery",
  "salon / spa",
  "gym / fitness",
  "professional services",
  "medical / clinic",
  "other",
];

interface Props {
  onCreated: (b: Business) => void;
  onCancel: () => void;
}

export function BusinessSetup({ onCreated, onCancel }: Props) {
  const [name, setName] = useState("");
  const [businessType, setType] = useState(BUSINESS_TYPES[0]);
  const [address, setAddress] = useState("");
  const [headcount, setHeadcount] = useState(1);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const biz = await api.createBusiness({ name, businessType, address, headcount, notes });
      // Street research runs in the background; agent still works with live data if this is slow.
      void api.refreshBusinessResearch(biz.id).catch(() => {});
      onCreated(biz);
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes("geocode")
          ? "Couldn't find that address in Toronto. Try a more specific street address."
          : err instanceof Error
            ? err.message
            : "Failed to create business.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="modal-backdrop" onClick={onCancel}>
      <form class="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Set up your business</h2>
        <p class="muted">
          We'll geocode your address and tailor a Toronto data agent to your location,
          type, and team.
        </p>

        <label>
          Business name
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} required placeholder="Queen St Cafe" />
        </label>

        <div class="form-row">
          <label>
            Type
            <select value={businessType} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
              {BUSINESS_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Staff
            <input
              type="number"
              min={1}
              value={headcount}
              onInput={(e) => setHeadcount(Number((e.target as HTMLInputElement).value) || 1)}
            />
          </label>
        </div>

        <label>
          Address (Toronto)
          <input value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} required placeholder="250 Queen St W" />
        </label>

        <label>
          Notes for your agent (optional)
          <textarea
            rows={2}
            value={notes}
            onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
            placeholder="Busy lunch crowd, patio in summer, rely on foot traffic…"
          />
        </label>

        {error && <div class="form-error">{error}</div>}

        <div class="form-actions">
          <button type="button" class="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" class="btn-primary" disabled={busy}>
            {busy ? "Setting up…" : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}
