# Model Selection Rubric — Bubble AI Note Provider Router

Use this to score candidate models (Groq's Llama variants, Gemini Flash,
OpenRouter free-pool models, local Ollama models) against the same criteria,
so "which model should handle this mode" becomes a comparison of numbers,
not a vibe.

---

## 1. Reasoning-handling criteria

Each Bubble mode needs a different depth of reasoning. Don't judge every
model against one bar — judge it against the bar its assigned mode needs.

| Mode | Reasoning tier | What "handling it well" looks like |
|---|---|---|
| **Explain** | Low–medium, single-step | Restates the confusing part in simpler terms without adding new claims. No invented facts, no unrelated tangents. |
| **Notes** | Low, compression-only | Preserves the source's actual structure and claims. Doesn't reorganize into an opinion or drop caveats the original had. |
| **Quiz** | Medium, generative | Questions are answerable strictly from the material given — no testing on facts that weren't in scope. Wrong-answer options are plausible, not absurd. |
| **Exam** | High, multi-step | Shows the actual working (not just a final answer), each step follows from the last, and it flags its own uncertainty when a step is genuinely ambiguous rather than guessing silently. |

**Score each candidate model 1–5 per mode it might handle:**
- **1** — Skips steps, states wrong intermediate results with full confidence, or answers a different question than asked.
- **3** — Gets there, but reasoning is implicit ("the answer is X") rather than shown, so a student can't follow *why*.
- **5** — Shows its work at the level a mode needs, catches its own errors mid-answer when re-prompted, doesn't overstate certainty on genuinely hard steps.

**How to test it:** pull 3–5 real prompts you'd actually send in each mode (an ambiguous textbook paragraph, a past quiz question, an exam-style problem) and run the identical prompt against every candidate model. Don't paraphrase the prompt per-model — that changes what you're comparing.

---

## 2. Tone criteria

Bubble's voice should read like a sharp peer tutor, not a corporate support
bot and not a textbook. Score each model on these four axes, 1–5 each:

| Axis | 1 (fails) | 5 (nails it) |
|---|---|---|
| **Clarity** | Buries the point in hedges/qualifiers | States the answer plainly, in plain words, then adds nuance if needed |
| **Warmth** | Cold/clinical, or over-familiar and gimmicky | Direct but not cold — sounds like it's actually trying to help |
| **Concision** | Pads with filler ("Great question!", restating the prompt) | Every sentence does a job; stops when done |
| **Confidence calibration** | Either hedges everything or states shaky answers as fact | Confident where the material is clear, explicit about uncertainty where it's genuinely unclear |

A model can be reasoning-strong and tone-weak (or vice versa) — score them
separately. A model that reasons well but answers like a legal disclaimer
isn't a good Explain-mode fit even if the logic is correct.

---

## 3. Comparison table (fill in after testing)

| Model | Reasoning: Explain | Reasoning: Notes | Reasoning: Quiz | Reasoning: Exam | Tone avg | Speed (tokens/sec, felt latency) | Free-tier ceiling | Notes |
|---|---|---|---|---|---|---|---|---|
| Groq — Llama 3.3 70B | | | | | | | | |
| Groq — Llama 3.1 8B (fast tier) | | | | | | | | |
| Gemini — Flash | | | | | | | | |
| OpenRouter — [free model name] | | | | | | | | |
| Ollama — Phi-3 mini (local) | | | | | | | | |
| Ollama — Llama 3.2 3B (local) | | | | | | | | |

**Reading the table once it's filled in:**
- Route **Explain / Notes** to whichever model scores best on *speed × tone*, since these are high-frequency, low-reasoning-depth calls — a slower, heavier model buys you nothing here.
- Route **Quiz / Exam** to whichever model scores highest on *reasoning*, even if it's slower — these are lower-frequency, and a wrong worked-answer is worse than a slow one.
- If one model wins everything, that's your default with the others as fallback order. If it splits, that's your actual per-mode routing table — wire it directly into the provider router's mode-to-model map.

---

## 4. Note on what this rubric doesn't give you

I can't run these models against each other for you from here — I don't have
API access to Groq/Gemini/OpenRouter in this environment, so the table above
is a scoring instrument, not a benchmark result. Fill it in by actually
sending the same prompt set to each candidate (curl, a quick script, or each
provider's playground) and scoring what comes back against the criteria in
sections 1 and 2.
