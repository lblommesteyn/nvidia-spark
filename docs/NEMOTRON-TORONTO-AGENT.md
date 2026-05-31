# Toronto business agent with Nemotron-3-Nano-30B

## How it works

1. **Set up your business** (`BusinessSetup.tsx`) — name, type, staff, Toronto address, notes.
2. **Web research agent** (`server/ai/web-agent.ts`) — on create, pulls City of Toronto open data, road restrictions, 311, permits, weather, traffic (TomTom if keyed), and a 7-day demand outlook; caches a `STREET_RESEARCH` briefing in SQLite.
3. **Nemotron Q&A** (`server/ai/agent.ts`) — each question gets live context + cached street research + week forecast + your history/schedule; answered by `nemotron-3-nano:30b` via Ollama.

OpenClaw is **not** required. Ollama + Toronto live APIs is simpler and stays grounded in civic data.

## Quick start

```bash
# 1. Ollama + model (on DGX / this machine)
ollama serve   # if not already running
ollama pull nemotron-3-nano:30b

# 2. Configure LLM in .env
cd ~/Documents/nvidia_hackathon/nvidia-spark
cp .env.example .env   # or edit existing .env
```

Add to `.env`:

```env
NEMOTRON_BASE_URL=http://localhost:11434/v1
NEMOTRON_MODEL=nemotron-3-nano:30b
TOMTOM_API_KEY=your_key   # optional, live road speeds

# Optional: Ollama model to polish street briefings (faster than 30b)
# OLLAMA_WEB_AGENT_HOST=http://localhost:11434
# OLLAMA_WEB_AGENT_MODEL=llama3.2:3b
```

```bash
# 3. Run API + UI
chmod +x scripts/run-nemotron-agent.sh
./scripts/run-nemotron-agent.sh
```

Open **http://localhost:3100/app** → **+ Add business** → fill the form → **Create agent** → ask in the chat panel.

## Example questions

- How many staff do I need next week?
- What sales should I expect this weekend?
- What construction or road closures affect my address?
- When are my busiest windows based on traffic and events?

## API (for scripts)

```bash
# Create business
curl -s -X POST http://localhost:8787/api/businesses \
  -H 'content-type: application/json' \
  -d '{"name":"Queen St Cafe","businessType":"cafe","address":"250 Queen St W","headcount":4,"notes":"Busy lunch crowd"}'

# Refresh street research
curl -s -X POST http://localhost:8787/api/businesses/<id>/research

# Ask Nemotron
curl -s -X POST http://localhost:8787/api/agent \
  -H 'content-type: application/json' \
  -d '{"businessId":"<id>","question":"How many staff do I need next week?"}'
```

## UI components

| Component | Path |
|-----------|------|
| Business setup form | `src/components/BusinessSetup.tsx` |
| Agent chat | `src/components/AgentChat.tsx` |
| API client | `src/services/api.ts` |

## Switching from the LoRA forecaster on :8001

If `.env` still has `NEMOTRON_BASE_URL=http://localhost:8001/v1` and `toronto-forecaster`, comment those out and use the Ollama block above instead.
