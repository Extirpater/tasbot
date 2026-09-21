export class JevPolicy {
  constructor({
    apiKey,
    model = "jev-latest",
    timeoutMs = 600,
    fetchImpl = fetch,
  } = {}) {
    if (!apiKey)
      throw new Error("Set TYPESAFE_API_KEY in .env, or run npm run baseline.");
    Object.assign(this, { apiKey, model, timeoutMs, fetchImpl });
  }

  async decide(candidates, { signal } = {}) {
    const allowed = candidates.filter((c) => !c.collision);
    if (!allowed.length) return null;
    const response = await this.fetchImpl(
      "https://api.typesafe.ai/v1/systemone",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          state: {
            game: "Evades.io: move a circle toward the exit while avoiding moving hazards.",
            candidates: allowed.map((c) => ({
              action: c.action,
              risk: c.risk,
              progress: c.progressLabel,
              clearance: Math.round(c.clearance),
              progressDistance: Math.round(c.progress),
            })),
          },
          questions: {
            movement: {
              type: "choice",
              instructions:
                "Objective: complete the area as fast as possible while surviving. Choose the safe route with the most progress toward the exit. Progress follows the planned route around obstacles, so a temporary retreat can be positive progress out of a pocket. Use full-speed movement whenever safe; focus means half speed and is only for a necessary dodge. Use sideways movement, retreat, or stay when advancing is unsafe. Collision predictions and route costs have already been computed by code.",
              criteria: Object.fromEntries(
                allowed.map((c) => [c.action, `${c.risk}; ${c.progressLabel}`]),
              ),
            },
          },
        }),
      },
    );
    if (!response.ok) {
      const error = new Error(`Jev HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    const answer = data.answers?.movement;
    if (
      answer?.type !== "choice" ||
      !allowed.some((c) => c.action === answer.choice) ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    ) {
      throw new Error("Jev returned an invalid movement answer.");
    }
    return {
      action: answer.choice,
      confidence: answer.confidence,
      inputTokens: data.usage?.input_tokens ?? 0,
    };
  }
}
