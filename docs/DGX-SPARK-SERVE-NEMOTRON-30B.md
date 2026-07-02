# DGX Spark — Nemotron 30B for Vercel + Railway

**You** run everything on the **Linux DGX Spark**. **Teammates** deploy Vercel (UI) +
Railway (API). Vercel never calls Nemotron — only Railway does.

**Skip ngrok** if you hit free-tier limits. Use a **Bearer API key** + one of:

| Method | Cost | HTTPS | Stable URL |
|--------|------|-------|------------|
| **Cloudflare Tunnel** (recommended) | Free, no bandwidth cap | Yes | Changes each restart* |
| **Your public IP** + port forward | Free | No (HTTP only) | Yes if IP is static |
| ngrok | Free tier limits | Yes | With reserved domain |

\* For a fixed hostname, use a [named Cloudflare tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

```
  Vercel (SPA)     Railway (API)        DGX Spark (you)
 ┌──────────┐      ┌─────────────┐      ┌─────────────────────────┐
 │ Frontend │─API─►│ NEMOTRON_*  │─HTTPS│ cloudflared → :11435    │
 └──────────┘      │ + API key   │      │   └─ auth proxy         │
                   └─────────────┘      │        └─ Ollama :11434  │
                                        └─────────────────────────┘
```

Toronto Monitor already sends `Authorization: Bearer $NEMOTRON_API_KEY` when that
env var is set on Railway (`server/ai/provider.ts`).

---

## Quick start (on the DGX Spark)

SSH into the Spark and run:

```bash
cd ~/nvidia-spark
chmod +x scripts/serve-dgx-nemotron-30b.sh scripts/ollama_auth_proxy.py

# 1. Prerequisites
scripts/serve-dgx-nemotron-30b.sh check

# 2. Install Ollama (once)
curl -fsSL https://ollama.com/install.sh | sh

# 3. Shared secret — give the same value to teammates for Railway
scripts/serve-dgx-nemotron-30b.sh keygen
export NEMOTRON_API_KEY=$(cat ~/.nemotron-api-key)

# 4. Model + auth proxy (Ollama stays on localhost only)
scripts/serve-dgx-nemotron-30b.sh start
scripts/serve-dgx-nemotron-30b.sh proxy
scripts/serve-dgx-nemotron-30b.sh smoke

# 5. Free HTTPS tunnel (install cloudflared once — see below)
scripts/serve-dgx-nemotron-30b.sh expose-tunnel
```

Keep it running in `tmux`:

```bash
tmux new -s nemotron
export NEMOTRON_API_KEY=$(cat ~/.nemotron-api-key)
scripts/serve-dgx-nemotron-30b.sh proxy
scripts/serve-dgx-nemotron-30b.sh expose-tunnel
# Ctrl-B, D to detach
```

### Install cloudflared (once, Linux aarch64)

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb \
  -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb
```

No Cloudflare account required for quick tunnels (`*.trycloudflare.com`).

---

## Option B — Public IP + API key (no tunnel)

If the Spark has a **public IPv4** (or you can port-forward on your router):

```bash
export NEMOTRON_API_KEY=$(cat ~/.nemotron-api-key)
scripts/serve-dgx-nemotron-30b.sh proxy
scripts/serve-dgx-nemotron-30b.sh expose-ip
```

Then on the router: forward **TCP 11435** → DGX Spark. If `ufw` is on:

```bash
sudo ufw allow 11435/tcp
```

Teammates set on Railway:

```env
NEMOTRON_BASE_URL=http://YOUR.PUBLIC.IP:11435/v1
NEMOTRON_MODEL=nemotron-3-nano:30b
NEMOTRON_API_KEY=<same secret as ~/.nemotron-api-key>
```

Traffic is **HTTP** (not encrypted). Prefer Cloudflare Tunnel when you can.

---

## Hand off to teammates (Railway)

```env
NEMOTRON_BASE_URL=https://xxxx.trycloudflare.com/v1   # from expose-tunnel output
NEMOTRON_MODEL=nemotron-3-nano:30b
NEMOTRON_API_KEY=<secret you generated with keygen>
```

Also set `ML_URL`, `CORS_ORIGIN` per [`docs/DEPLOY.md`](DEPLOY.md). **Do not** put
these on Vercel — only on Railway `cityflow-api`.

Verify:

```bash
curl -s https://their-api.up.railway.app/api/health
# {"provider":"nemotron", ...}
```

Vercel (frontend only):

```bash
vercel env add VITE_API_BASE production
# → https://their-api.up.railway.app
vercel --prod
```

Print handoff vars anytime:

```bash
export NEMOTRON_API_KEY=$(cat ~/.nemotron-api-key)
PUBLIC_BASE_URL=https://xxxx.trycloudflare.com scripts/serve-dgx-nemotron-30b.sh env
```

---

## ngrok (fallback only)

If you already use ngrok and accept the limits:

```bash
export NEMOTRON_API_KEY=$(cat ~/.nemotron-api-key)
NGROK_DOMAIN=your-name.ngrok-free.dev scripts/serve-dgx-nemotron-30b.sh expose-ngrok
```

The tunnel points at the **auth proxy** (`:11435`), not raw Ollama.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `401 unauthorized` | `NEMOTRON_API_KEY` mismatch between DGX and Railway |
| Railway shows `mock` | `NEMOTRON_BASE_URL` wrong or tunnel down |
| Tunnel URL changed | Re-run `expose-tunnel`, update Railway, redeploy API |
| `connection refused` | `proxy` not running — rerun start + proxy |
| OOM | `nvidia-smi` — stop other GPU jobs |

---

## Security notes

- Ollama binds to **127.0.0.1** only; the internet hits the **auth proxy**.
- Rotate the key: `rm ~/.nemotron-api-key && scripts/serve-dgx-nemotron-30b.sh keygen`
- Never commit `NEMOTRON_API_KEY` to git — Railway dashboard only.
