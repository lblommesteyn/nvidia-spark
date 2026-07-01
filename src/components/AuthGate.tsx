import { useState } from "preact/hooks";
import { api, type Business, type TransitNearby } from "../services/api";

/**
 * Onboarding gate shown before the terminal on the /app route. A three-step
 * form collects the operator's identity + their business details + acceptance
 * of the acceptable-use terms, then mints a session token (via /api/auth/register)
 * that gates every subsequent API call. This is the app's misuse guardrail for
 * public hosting: no anonymous access to the data feeds or the model.
 */

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

const RELEVANCE_LABEL: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  minimal: "Minimal",
};

interface Props {
  onAuthed: (business: Business) => void;
}

type Step = 0 | 1 | 2;

export function AuthGate({ onAuthed }: Props) {
  const [step, setStep] = useState<Step>(0);

  // Step 1 — operator identity
  const [operatorName, setOperatorName] = useState("");
  const [operatorEmail, setOperatorEmail] = useState("");

  // Step 2 — business
  const [name, setName] = useState("");
  const [businessType, setType] = useState(BUSINESS_TYPES[0]);
  const [address, setAddress] = useState("");
  const [headcount, setHeadcount] = useState(1);
  const [opensAt, setOpensAt] = useState(8);
  const [closesAt, setClosesAt] = useState(22);

  // Step 2 — transit preview (derived from address)
  const [transit, setTransit] = useState<TransitNearby | null>(null);
  const [transitBusy, setTransitBusy] = useState(false);

  // Step 3 — acceptance
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operatorEmail);
  const step1Valid = operatorName.trim().length > 0 && emailValid;
  const step2Valid = name.trim().length > 0 && address.trim().length > 0;

  async function lookupTransit() {
    const addr = address.trim();
    if (!addr) return;
    setTransitBusy(true);
    try {
      setTransit(await api.transitNearby(addr));
    } catch {
      setTransit(null);
    } finally {
      setTransitBusy(false);
    }
  }

  function next() {
    setError(null);
    if (step === 0 && !step1Valid) {
      setError("Enter your name and a valid work email.");
      return;
    }
    if (step === 1 && !step2Valid) {
      setError("Enter your business name and Toronto address.");
      return;
    }
    setStep((s) => Math.min(2, s + 1) as Step);
  }

  function back() {
    setError(null);
    setStep((s) => Math.max(0, s - 1) as Step);
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (!acceptedTerms) {
      setError("Please accept the acceptable-use terms to continue.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { business } = await api.register({
        operatorName: operatorName.trim(),
        operatorEmail: operatorEmail.trim(),
        acceptedTerms: true,
        business: { name: name.trim(), businessType, address: address.trim(), headcount, opensAt, closesAt },
      });
      onAuthed(business);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Registration failed.";
      setError(
        msg.includes("geocode")
          ? "Couldn't find that address in Toronto. Try a more specific street address."
          : msg.includes("rate_limited") || msg.includes("429")
            ? "Too many attempts from your network — please wait a bit and try again."
            : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="auth-gate">
      <div class="auth-gate-card" role="dialog" aria-modal="true" aria-label="CityFlow onboarding">
        <div class="auth-gate-head">
          <span class="auth-gate-mark">TO</span>
          <div>
            <h1>Get access to CityFlow</h1>
            <p class="muted">
              Tell us about you and your business. We use this to tailor your agent and to keep the
              public platform fair — access is per-operator and rate-limited.
            </p>
          </div>
        </div>

        <ol class="auth-steps" aria-hidden="true">
          <li class={step >= 0 ? "is-active" : ""}>1 · You</li>
          <li class={step >= 1 ? "is-active" : ""}>2 · Business</li>
          <li class={step >= 2 ? "is-active" : ""}>3 · Terms</li>
        </ol>

        <form onSubmit={submit}>
          {step === 0 && (
            <div class="auth-step">
              <label>
                Your name
                <input
                  value={operatorName}
                  onInput={(e) => setOperatorName((e.target as HTMLInputElement).value)}
                  placeholder="Alex Chen"
                  autoFocus
                />
              </label>
              <label>
                Work email
                <input
                  type="email"
                  value={operatorEmail}
                  onInput={(e) => setOperatorEmail((e.target as HTMLInputElement).value)}
                  placeholder="alex@harbourgrind.ca"
                />
                {operatorEmail.length > 0 && !emailValid && (
                  <span class="auth-hint-err">Enter a valid email address.</span>
                )}
              </label>
            </div>
          )}

          {step === 1 && (
            <div class="auth-step">
              <label>
                Business name
                <input
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                  placeholder="Harbour Grind"
                  autoFocus
                />
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
                  Staff (current)
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
                <input
                  value={address}
                  onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
                  onBlur={lookupTransit}
                  placeholder="250 Queen St W"
                />
              </label>
              <div class="form-row">
                <label>
                  Opens at (hour)
                  <input type="number" min={0} max={23} value={opensAt}
                    onInput={(e) => setOpensAt(clampHour((e.target as HTMLInputElement).value, 8))} />
                </label>
                <label>
                  Closes at (hour)
                  <input type="number" min={0} max={23} value={closesAt}
                    onInput={(e) => setClosesAt(clampHour((e.target as HTMLInputElement).value, 22))} />
                </label>
              </div>
              {transitBusy ? (
                <div class="muted auth-transit">Checking nearby transit…</div>
              ) : transit ? (
                <div class="auth-transit">
                  <span class={`transit-badge rel-${transit.relevance}`}>
                    Transit: {RELEVANCE_LABEL[transit.relevance] ?? transit.relevance}
                    {transit.nearestM !== null && ` · nearest ${transit.nearestM} m`}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {step === 2 && (
            <div class="auth-step">
              <div class="auth-review">
                <div><span class="muted">Operator</span><strong>{operatorName}</strong></div>
                <div><span class="muted">Email</span><strong>{operatorEmail}</strong></div>
                <div><span class="muted">Business</span><strong>{name} · {businessType}</strong></div>
                <div><span class="muted">Address</span><strong>{address}</strong></div>
              </div>
              <div class="auth-terms">
                <p class="auth-terms-title">Acceptable use</p>
                <ul>
                  <li>One operator account per business; don't share your access link.</li>
                  <li>No automated scraping, load testing, or reselling of the data feeds or model.</li>
                  <li>Requests are rate-limited; the agent is for operating your own business.</li>
                  <li>Data shown is for planning only and may be delayed or approximate.</li>
                </ul>
                <label class="auth-accept">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms((e.target as HTMLInputElement).checked)}
                  />
                  I agree to the acceptable-use terms.
                </label>
              </div>
            </div>
          )}

          {error && <div class="form-error">{error}</div>}

          <div class="auth-actions">
            {step > 0 ? (
              <button type="button" class="btn-ghost" onClick={back} disabled={busy}>← Back</button>
            ) : (
              <a class="btn-ghost" href="/">← Home</a>
            )}
            {step < 2 ? (
              <button type="button" class="btn-primary" onClick={next}>Continue →</button>
            ) : (
              <button type="submit" class="btn-primary" disabled={busy || !acceptedTerms}>
                {busy ? "Setting up…" : "Enter terminal"}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function clampHour(raw: string, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(23, n));
}
