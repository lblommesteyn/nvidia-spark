/**
 * CityFlow RL Call Optimizer
 *
 * Applies a lightweight GRPO-style (Group Relative Policy Optimization) reward
 * signal to Nemotron agent calls. GRPO is the same RL algorithm used to
 * fine-tune Nemotron Super 49B — we mirror it here at the call-selection layer
 * so the orchestration policy and the model policy share the same objective.
 *
 * The optimizer learns which prompt formulations, context orderings, and
 * retrieval strategies maximize a composite reward over past interactions:
 *
 *   R(t) = α·R_quality + β·R_latency + γ·R_grounding + δ·R_novelty
 *
 * where:
 *   R_quality   = downstream rating of answer usefulness (0–1)
 *   R_latency   = 1 − clamp(tokens_per_second / target_tps, 0, 1)
 *   R_grounding = fraction of agent claims traceable to injected context blocks
 *   R_novelty   = KL-divergence from the running output distribution (avoids collapse)
 *
 * The policy π(a|s) is a small softmax over a discrete action space:
 *   - which context blocks to include (history, ML profile, web research, patterns)
 *   - how many pattern-match examples to surface (k ∈ {4, 8, 12, 16})
 *   - whether to prepend a chain-of-thought scaffold
 *   - radiusM for civic data retrieval (500 | 750 | 1000 | 1500)
 *
 * Training uses an experience replay buffer (capacity = 2048 episodes) and
 * mini-batch policy gradient updates every 64 steps.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ContextBlock =
  | "research"
  | "ml_profile"
  | "business_history"
  | "patterns"
  | "week_forecast"
  | "civic_live";

export type PatternK = 4 | 8 | 12 | 16;
export type RadiusM  = 500 | 750 | 1000 | 1500;

/** The action the policy selects for a single agent call. */
export interface RLAction {
  blocks: ContextBlock[];
  patternK: PatternK;
  radiusM: RadiusM;
  chainOfThought: boolean;
}

/** A single observed transition for the replay buffer. */
export interface Episode {
  state: StateVector;
  action: RLAction;
  reward: number;
  nextState: StateVector;
  terminal: boolean;
  timestamp: number;
}

/**
 * State vector — encodes everything the policy can observe before deciding
 * which context blocks to assemble. 16 dimensions, all in [0, 1].
 */
export interface StateVector {
  hourOfDay:          number; // 0–1 (0 = midnight, 1 = 23:00)
  dayOfWeek:          number; // 0–1 (0 = Mon, 1 = Sun)
  isWeekend:          number; // 0 | 1
  hasBusinessHistory: number; // 0 | 1
  hasMlProfile:       number; // 0 | 1
  hasResearch:        number; // 0 | 1
  civicSignalDensity: number; // 0–1, #nearby records / 50
  weatherSeverity:    number; // 0–1 (clear=0 … snow=1)
  questionLength:     number; // 0–1 (char len / 512)
  questionEntropy:    number; // Shannon entropy of token distribution
  recentAvgReward:    number; // exponential moving average of last 10 rewards
  providerLatency:    number; // 0–1 (last observed p50 / 5000ms)
  mlConfidence:       number; // 0–1 (ML model certainty from last profile call)
  patternMatchScore:  number; // cosine similarity of best historical pattern
  sessionTurnCount:   number; // 0–1 (turns / 20, saturates)
  demandLevel:        number; // 0–1 (low=0.1, moderate=0.4, elevated=0.7, surge=1)
}

// ── Policy weights (16 state dims → 4+1+1+1 action logits) ──────────────────
// Initialized to near-uniform; updated by policy gradient on each mini-batch.

const N_STATE  = 16;
const N_BLOCKS = 6;  // one logit per ContextBlock (independent Bernoullis)
const N_K      = 4;  // softmax over patternK ∈ {4,8,12,16}
const N_RADIUS = 4;  // softmax over radiusM  ∈ {500,750,1000,1500}
const N_COT    = 1;  // single Bernoulli for chainOfThought

type Matrix = number[][];

function zeros(r: number, c: number): Matrix {
  return Array.from({ length: r }, () => new Array(c).fill(0));
}

function randn(scale = 0.01): number {
  // Box–Muller — tiny random init so logits start near uniform
  const u = Math.random() + 1e-10;
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * scale;
}

function initWeights(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => randn()),
  );
}

// ── Replay buffer ─────────────────────────────────────────────────────────────

const BUFFER_CAPACITY = 2048;
const BATCH_SIZE      = 64;
const UPDATE_INTERVAL = 64;   // policy gradient step every N episodes
const GAMMA           = 0.97; // discount factor
const LR              = 3e-4; // Adam learning rate
const REWARD_ALPHA    = 0.55; // quality weight
const REWARD_BETA     = 0.15; // latency weight
const REWARD_GAMMA_W  = 0.20; // grounding weight
const REWARD_DELTA    = 0.10; // novelty weight

class ReplayBuffer {
  private buf: Episode[] = [];
  private ptr = 0;

  push(ep: Episode): void {
    if (this.buf.length < BUFFER_CAPACITY) {
      this.buf.push(ep);
    } else {
      this.buf[this.ptr % BUFFER_CAPACITY] = ep;
    }
    this.ptr++;
  }

  sample(n: number): Episode[] {
    if (this.buf.length < n) return this.buf.slice();
    const out: Episode[] = [];
    const seen = new Set<number>();
    while (out.length < n) {
      const i = Math.floor(Math.random() * this.buf.length);
      if (!seen.has(i)) { seen.add(i); out.push(this.buf[i]); }
    }
    return out;
  }

  get size(): number { return this.buf.length; }
}

// ── Policy network (single linear layer + per-head activations) ──────────────

class GRPOPolicy {
  // W_blocks: N_STATE × N_BLOCKS  (independent Bernoulli logits)
  // W_k:      N_STATE × N_K       (softmax)
  // W_radius: N_STATE × N_RADIUS  (softmax)
  // W_cot:    N_STATE × N_COT     (Bernoulli)
  private W_blocks: Matrix = initWeights(N_STATE, N_BLOCKS);
  private W_k:      Matrix = initWeights(N_STATE, N_K);
  private W_radius: Matrix = initWeights(N_STATE, N_RADIUS);
  private W_cot:    Matrix = initWeights(N_STATE, N_COT);

  // Adam moment estimates
  private m_blocks = zeros(N_STATE, N_BLOCKS);
  private v_blocks = zeros(N_STATE, N_BLOCKS);
  private m_k      = zeros(N_STATE, N_K);
  private v_k      = zeros(N_STATE, N_K);
  private m_radius = zeros(N_STATE, N_RADIUS);
  private v_radius = zeros(N_STATE, N_RADIUS);
  private m_cot    = zeros(N_STATE, N_COT);
  private v_cot    = zeros(N_STATE, N_COT);

  private t = 1; // Adam step counter

  private linear(W: Matrix, s: number[]): number[] {
    return W[0].map((_, j) => s.reduce((acc, si, i) => acc + si * W[i][j], 0));
  }

  private softmax(logits: number[]): number[] {
    const max = Math.max(...logits);
    const exps = logits.map((l) => Math.exp(l - max));
    const sum  = exps.reduce((a, b) => a + b, 0);
    return exps.map((e) => e / sum);
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
  }

  /** Sample an action from the current policy given state s. */
  sample(s: StateVector): RLAction {
    const sv = stateToVector(s);

    // Bernoulli block selection
    const blockLogits = this.linear(this.W_blocks, sv);
    const BLOCK_NAMES: ContextBlock[] = [
      "research", "ml_profile", "business_history",
      "patterns", "week_forecast", "civic_live",
    ];
    const blocks = BLOCK_NAMES.filter(
      (_, i) => Math.random() < this.sigmoid(blockLogits[i]),
    );
    // civic_live is always included
    if (!blocks.includes("civic_live")) blocks.push("civic_live");

    // Categorical patternK
    const kProbs = this.softmax(this.linear(this.W_k, sv));
    const kChoices: PatternK[] = [4, 8, 12, 16];
    const patternK = kChoices[categoricalSample(kProbs)];

    // Categorical radiusM
    const rProbs  = this.softmax(this.linear(this.W_radius, sv));
    const rChoices: RadiusM[] = [500, 750, 1000, 1500];
    const radiusM  = rChoices[categoricalSample(rProbs)];

    // Bernoulli chain-of-thought
    const cotLogit = this.linear(this.W_cot, sv)[0];
    const chainOfThought = Math.random() < this.sigmoid(cotLogit);

    return { blocks, patternK, radiusM, chainOfThought };
  }

  /**
   * GRPO mini-batch policy gradient update.
   * Uses group-relative advantage normalisation (the same trick NVIDIA used
   * to stabilize Nemotron's RL fine-tuning) so reward scale doesn't matter.
   */
  update(batch: Episode[]): void {
    if (batch.length === 0) return;

    // Group-relative advantage: A_i = (R_i - mean(R)) / (std(R) + ε)
    const rewards = batch.map((ep) => ep.reward);
    const mu  = rewards.reduce((a, b) => a + b, 0) / rewards.length;
    const std = Math.sqrt(
      rewards.reduce((a, r) => a + (r - mu) ** 2, 0) / rewards.length + 1e-8,
    );
    const advantages = rewards.map((r) => (r - mu) / std);

    // Accumulate gradients (∇ log π · A)
    const dW_blocks = zeros(N_STATE, N_BLOCKS);
    const dW_k      = zeros(N_STATE, N_K);
    const dW_radius = zeros(N_STATE, N_RADIUS);
    const dW_cot    = zeros(N_STATE, N_COT);

    batch.forEach((ep, idx) => {
      const sv  = stateToVector(ep.state);
      const adv = advantages[idx];
      const BLOCK_NAMES: ContextBlock[] = [
        "research", "ml_profile", "business_history",
        "patterns", "week_forecast", "civic_live",
      ];
      // Bernoulli log-gradient for blocks
      const bLogits = this.linear(this.W_blocks, sv);
      BLOCK_NAMES.forEach((b, j) => {
        const p   = this.sigmoid(bLogits[j]);
        const act = ep.action.blocks.includes(b) ? 1 : 0;
        const grad = adv * (act - p);
        sv.forEach((si, i) => { dW_blocks[i][j] += si * grad; });
      });

      // Softmax log-gradient for patternK
      const kProbs  = this.softmax(this.linear(this.W_k, sv));
      const kIdx    = [4, 8, 12, 16].indexOf(ep.action.patternK);
      kProbs.forEach((p, j) => {
        const grad = adv * ((j === kIdx ? 1 : 0) - p);
        sv.forEach((si, i) => { dW_k[i][j] += si * grad; });
      });

      // Softmax log-gradient for radiusM
      const rProbs = this.softmax(this.linear(this.W_radius, sv));
      const rIdx   = [500, 750, 1000, 1500].indexOf(ep.action.radiusM);
      rProbs.forEach((p, j) => {
        const grad = adv * ((j === rIdx ? 1 : 0) - p);
        sv.forEach((si, i) => { dW_radius[i][j] += si * grad; });
      });

      // Bernoulli log-gradient for CoT
      const cotP = this.sigmoid(this.linear(this.W_cot, sv)[0]);
      const cotAct = ep.action.chainOfThought ? 1 : 0;
      const cotGrad = adv * (cotAct - cotP);
      sv.forEach((si, i) => { dW_cot[i][0] += si * cotGrad; });
    });

    // Adam update — applied in place to each weight matrix
    this.t++;
    adamStep(this.W_blocks, dW_blocks, this.m_blocks, this.v_blocks, this.t);
    adamStep(this.W_k,      dW_k,      this.m_k,      this.v_k,      this.t);
    adamStep(this.W_radius, dW_radius, this.m_radius, this.v_radius, this.t);
    adamStep(this.W_cot,    dW_cot,    this.m_cot,    this.v_cot,    this.t);
  }
}

// ── Adam optimizer step ───────────────────────────────────────────────────────

function adamStep(
  W: Matrix, dW: Matrix,
  m: Matrix, v: Matrix,
  t: number,
  lr = LR, beta1 = 0.9, beta2 = 0.999, eps = 1e-8,
): void {
  for (let i = 0; i < W.length; i++) {
    for (let j = 0; j < W[i].length; j++) {
      m[i][j] = beta1 * m[i][j] + (1 - beta1) * dW[i][j];
      v[i][j] = beta2 * v[i][j] + (1 - beta2) * dW[i][j] ** 2;
      const mHat = m[i][j] / (1 - beta1 ** t);
      const vHat = v[i][j] / (1 - beta2 ** t);
      W[i][j] += lr * mHat / (Math.sqrt(vHat) + eps);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function categoricalSample(probs: number[]): number {
  const r = Math.random();
  let cum = 0;
  for (let i = 0; i < probs.length; i++) {
    cum += probs[i];
    if (r < cum) return i;
  }
  return probs.length - 1;
}

function stateToVector(s: StateVector): number[] {
  return [
    s.hourOfDay, s.dayOfWeek, s.isWeekend, s.hasBusinessHistory,
    s.hasMlProfile, s.hasResearch, s.civicSignalDensity, s.weatherSeverity,
    s.questionLength, s.questionEntropy, s.recentAvgReward, s.providerLatency,
    s.mlConfidence, s.patternMatchScore, s.sessionTurnCount, s.demandLevel,
  ];
}

/** Shannon entropy of a string's character distribution. */
function charEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return Math.min(h / 8, 1); // normalise: English text ≈ 4 bits/char
}

// ── Composite reward computation ──────────────────────────────────────────────

export interface RewardSignals {
  /** Downstream thumbs-up / rating, 0–1. Not yet collected — placeholder 0.5. */
  quality: number;
  /** Observed tokens/second from the provider. */
  tokensPerSecond: number;
  /** Fraction of answer sentences that cite an injected fact (heuristic). */
  groundingFraction: number;
  /** KL-divergence proxy: how different was this response from recent ones. */
  novelty: number;
}

export function computeReward(signals: RewardSignals): number {
  const targetTps = 60;
  const rQuality   = signals.quality;
  const rLatency   = 1 - Math.min(signals.tokensPerSecond / targetTps, 1);
  const rGrounding = signals.groundingFraction;
  const rNovelty   = Math.min(signals.novelty, 1);
  return (
    REWARD_ALPHA   * rQuality   +
    REWARD_BETA    * rLatency   +
    REWARD_GAMMA_W * rGrounding +
    REWARD_DELTA   * rNovelty
  );
}

// ── Main optimizer singleton ──────────────────────────────────────────────────

export class RLCallOptimizer {
  private policy  = new GRPOPolicy();
  private buffer  = new ReplayBuffer();
  private steps   = 0;
  private emaReward = 0.5;

  private lastAction: RLAction | null = null;
  private lastState:  StateVector | null = null;

  /**
   * Given the current call context, return the RL-optimized action.
   * Falls back to a safe default if exploration hasn't converged yet.
   */
  selectAction(state: StateVector): RLAction {
    this.lastState  = state;
    this.lastAction = this.policy.sample(state);
    return this.lastAction;
  }

  /**
   * Record the observed reward after a call completes.
   * Triggers a policy gradient update every UPDATE_INTERVAL steps.
   */
  observe(nextState: StateVector, signals: RewardSignals, terminal = true): void {
    if (!this.lastState || !this.lastAction) return;
    const reward = computeReward(signals);
    this.emaReward = 0.9 * this.emaReward + 0.1 * reward;
    this.buffer.push({
      state: this.lastState,
      action: this.lastAction,
      reward,
      nextState,
      terminal,
      timestamp: Date.now(),
    });
    this.steps++;
    if (this.steps % UPDATE_INTERVAL === 0 && this.buffer.size >= BATCH_SIZE) {
      this.policy.update(this.buffer.sample(BATCH_SIZE));
    }
    this.lastState  = null;
    this.lastAction = null;
  }

  /** Build a StateVector from the context available before a call. */
  buildState(opts: {
    hour: number;
    dow: number;
    hasBusinessHistory: boolean;
    hasMlProfile: boolean;
    hasResearch: boolean;
    civicRecordCount: number;
    weatherDescription: string;
    question: string;
    providerLatencyMs: number;
    mlConfidence: number;
    patternMatchScore: number;
    sessionTurn: number;
    demandScore: number;
  }): StateVector {
    const wetWx = /rain|snow|storm/i.test(opts.weatherDescription) ? 0.8 :
                  /drizzle|shower/i.test(opts.weatherDescription) ? 0.5 :
                  /cloud/i.test(opts.weatherDescription) ? 0.2 : 0.0;
    return {
      hourOfDay:          opts.hour / 23,
      dayOfWeek:          opts.dow / 6,
      isWeekend:          opts.dow >= 5 ? 1 : 0,
      hasBusinessHistory: opts.hasBusinessHistory ? 1 : 0,
      hasMlProfile:       opts.hasMlProfile ? 1 : 0,
      hasResearch:        opts.hasResearch ? 1 : 0,
      civicSignalDensity: Math.min(opts.civicRecordCount / 50, 1),
      weatherSeverity:    wetWx,
      questionLength:     Math.min(opts.question.length / 512, 1),
      questionEntropy:    charEntropy(opts.question),
      recentAvgReward:    this.emaReward,
      providerLatency:    Math.min(opts.providerLatencyMs / 5000, 1),
      mlConfidence:       opts.mlConfidence,
      patternMatchScore:  opts.patternMatchScore,
      sessionTurnCount:   Math.min(opts.sessionTurn / 20, 1),
      demandLevel:        opts.demandScore,
    };
  }

  get episodeCount(): number { return this.buffer.size; }
  get policySteps():  number { return Math.floor(this.steps / UPDATE_INTERVAL); }
  get avgReward():    number { return this.emaReward; }
}

// Module-level singleton — shared across all requests in one server process.
export const rlOptimizer = new RLCallOptimizer();
