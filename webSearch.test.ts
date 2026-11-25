import assert from "node:assert/strict";
import type { GoogleGenAI } from "@google/genai";
import { buildYunerthOrchestrationInstruction } from "./orchestration.ts";
import {
  classifySearchError,
  executeWebSearch,
  parseRetryAfterHeader,
  SEARCH_MODEL,
  WebSearchCoordinator,
} from "./webSearch.ts";

function createMockAi(
  impl: (params: Record<string, unknown>) => Promise<unknown>
): GoogleGenAI {
  return {
    models: {
      generateContent: impl,
    },
  } as unknown as GoogleGenAI;
}

async function runTests(): Promise<void> {
  // 1. Successful live web search
  {
    const coordinator = new WebSearchCoordinator();
    let seenModel = "";
    let seenTools: unknown = null;
    const mockAi = createMockAi(async (params) => {
      seenModel = String(params.model);
      seenTools = (params.config as { tools?: unknown })?.tools;
      return {
        text: "Today major AI updates included new multimodal benchmarks and open tooling releases.",
        candidates: [
          {
            groundingMetadata: {
              webSearchQueries: ["latest AI news today"],
              groundingChunks: [
                {
                  web: {
                    title: "TechCrunch AI Daily",
                    uri: "https://techcrunch.com/ai-daily-example",
                  },
                },
                {
                  web: {
                    uri: "https://www.reuters.com/technology/ai-example",
                  },
                },
              ],
            },
          },
        ],
      };
    });

    const res = await executeWebSearch(
      mockAi,
      { query: "latest AI news today", recency: "today" },
      "Asia/Kolkata",
      coordinator
    );
    assert.equal(seenModel, SEARCH_MODEL);
    assert.deepEqual(seenTools, [{ googleSearch: {} }]);
    assert.equal(res.status, "ok");
    assert.ok(String(res.summary).includes("multimodal benchmarks"));
    const sources = res.sources as Array<{ title: string; url: string }>;
    assert.equal(sources.length, 2);
    assert.equal(sources[0].title, "TechCrunch AI Daily");
    assert.equal(sources[1].title, "reuters.com");
    assert.deepEqual(res.searchQueries, ["latest AI news today"]);
  }

  // 2 & 3. Repeated identical search requests & multiple different search requests
  {
    const coordinator = new WebSearchCoordinator();
    let callCount = 0;
    const mockAi = createMockAi(async (params) => {
      callCount += 1;
      await new Promise((r) => setTimeout(r, 20));
      const text = String(params.contents);
      return {
        text: text.includes("TypeScript")
          ? "TypeScript compiler speedups announced."
          : "Open-source AI news summary.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: `Source ${callCount}`,
                    uri: `https://example.com/${callCount}`,
                  },
                },
              ],
            },
          },
        ],
      };
    });

    const [r1, r2] = await Promise.all([
      executeWebSearch(mockAi, { query: "  Open source  AI news ", recency: "today" }, "UTC", coordinator),
      executeWebSearch(mockAi, { query: "open source ai news", recency: "today" }, "UTC", coordinator),
    ]);
    assert.equal(callCount, 1);
    assert.equal(r1.status, "ok");
    assert.equal(r2.status, "ok");

    const r3 = await executeWebSearch(
      mockAi,
      { query: "Open source AI news", recency: "today" },
      "UTC",
      coordinator
    );
    assert.equal(callCount, 1);
    assert.equal(r3.cached, true);

    const r4 = await executeWebSearch(
      mockAi,
      { query: "latest TypeScript release", recency: "recent" },
      "UTC",
      coordinator
    );
    assert.equal(callCount, 2);
    assert.equal(r4.status, "ok");
    assert.ok(String(r4.summary).includes("TypeScript"));
  }

  // 4. Temporary 429 rate-limit response (Retry-After header & RPM limit vs plan block)
  {
    assert.equal(parseRetryAfterHeader("19"), 19);
    const futureDate = new Date(Date.now() + 12000).toUTCString();
    const parsedDate = parseRetryAfterHeader(futureDate);
    assert.ok(parsedDate !== undefined && parsedDate >= 10 && parsedDate <= 14);

    const tempRateLimitErr = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Rate limit exceeded: requests per minute.",
          },
        })
      ),
      { status: 429 }
    );
    const classified = classifySearchError(tempRateLimitErr, "v1beta", 22);
    assert.equal(classified.errorCode, "RATE_LIMITED");
    assert.equal(classified.diagnostics.quotaCategory, "rate_limit");
    assert.equal(classified.diagnostics.retryAfterHeaderSeconds, 22);
    assert.equal(classified.diagnostics.retryAfterSeconds, 22);
  }

  // 5. Confirmed Search grounding quota exhaustion (both limit:0 & Google "plan and billing details" 429)
  {
    const coordinator = new WebSearchCoordinator();
    let callCount = 0;
    const planBilling429 = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message:
              "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.Help",
                links: [
                  {
                    description: "Learn more about Gemini API quotas",
                    url: "https://aistudio.google.com/docs/rate-limits",
                  },
                ],
              },
            ],
          },
        })
      ),
      { status: 429 }
    );

    const mockAi = createMockAi(async () => {
      callCount += 1;
      throw planBilling429;
    });

    const first = await executeWebSearch(
      mockAi,
      { query: "today AI headlines", recency: "today" },
      "UTC",
      coordinator
    );
    assert.equal(callCount, 1, "Must NEVER retry 429 quota exhaustion");
    assert.equal(first.status, "error");
    assert.equal(first.errorCode, "SEARCH_GROUNDING_QUOTA");
    assert.equal(first.retryAfterSeconds, 300);
    assert.equal(
      (first.diagnostics as { planOrBillingRestricted?: boolean })
        ?.planOrBillingRestricted,
      true
    );
    assert.ok(
      !String(first.message).toLowerCase().includes("temporarily hit a rate limit"),
      "Must NOT describe plan/billing Search Grounding quota block as a short temporary rate limit"
    );

    // Subsequent different search during cooldown must short-circuit without calling API
    const second = await executeWebSearch(
      mockAi,
      { query: "another current news query", recency: "today" },
      "UTC",
      coordinator
    );
    assert.equal(callCount, 1);
    assert.equal(second.cooldownActive, true);
    assert.equal(second.errorCode, "SEARCH_GROUNDING_QUOTA");

    // Explicit QuotaFailure with grounding metric + limit: 0
    const explicitZeroLimit = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Quota exceeded for google_search_grounding: limit: 0.",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [
                  {
                    quotaMetric:
                      "generativelanguage.googleapis.com/google_search_grounding_requests",
                    quotaValue: "0",
                  },
                ],
              },
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: "23s",
              },
            ],
          },
        })
      ),
      { status: 429 }
    );
    const classifiedZero = classifySearchError(explicitZeroLimit, "v1beta");
    assert.equal(classifiedZero.errorCode, "SEARCH_GROUNDING_QUOTA");
    assert.equal(classifiedZero.diagnostics.isZeroLimit, true);
    assert.equal(classifiedZero.diagnostics.retryAfterSeconds, 23);
  }

  // 6. Invalid API key or project configuration (400 / 401 / 403)
  {
    const err403 = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "API key restricted.",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "SERVICE_DISABLED",
              },
            ],
          },
        })
      ),
      { status: 403 }
    );
    assert.equal(classifySearchError(err403).errorCode, "PERMISSION_DENIED");

    const err401 = Object.assign(new Error("Request unauthenticated"), {
      status: 401,
    });
    assert.equal(classifySearchError(err401).errorCode, "UNAUTHENTICATED");

    const err400 = Object.assign(
      new Error(
        JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "API key not valid.",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_INVALID",
              },
            ],
          },
        })
      ),
      { status: 400 }
    );
    assert.equal(classifySearchError(err400).errorCode, "INVALID_REQUEST");
  }

  // 7. Recovery after limit resets AND bounded 1-retry recovery on transient 5xx
  {
    // 7a. Recovery after cooldown resets
    const coordinator = new WebSearchCoordinator();
    let mode: "rate_limited" | "ok" = "rate_limited";
    const mockAi = createMockAi(async () => {
      if (mode === "rate_limited") {
        throw Object.assign(
          new Error(
            JSON.stringify({
              error: {
                code: 429,
                status: "RESOURCE_EXHAUSTED",
                message: "Rate limit exceeded.",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "5s",
                  },
                ],
              },
            })
          ),
          { status: 429 }
        );
      }
      return {
        text: "Recovered search result with latest updates.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                {
                  web: {
                    title: "Recovered Source",
                    uri: "https://example.com/recovered",
                  },
                },
              ],
            },
          },
        ],
      };
    });

    const failed = await executeWebSearch(
      mockAi,
      { query: "recovery test news" },
      "UTC",
      coordinator
    );
    assert.equal(failed.status, "error");
    assert.equal(failed.errorCode, "RATE_LIMITED");
    assert.ok(coordinator.getCooldownRemainingSeconds() > 0);

    // Simulate cooldown expiry / reset
    coordinator.clearState();
    mode = "ok";
    const recovered = await executeWebSearch(
      mockAi,
      { query: "recovery test news" },
      "UTC",
      coordinator
    );
    assert.equal(recovered.status, "ok");
    assert.equal(coordinator.getCooldownRemainingSeconds(), 0);

    // 7b. Transient 503 bounded 1-retry backoff succeeds on attempt 2
    const retryCoordinator = new WebSearchCoordinator();
    let attempts = 0;
    const flaky503Ai = createMockAi(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(
          new Error(
            JSON.stringify({
              error: {
                code: 503,
                status: "UNAVAILABLE",
                message: "This model is currently experiencing high demand.",
              },
            })
          ),
          { status: 503 }
        );
      }
      return {
        text: "Search succeeded cleanly after bounded 503 retry.",
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [
                { web: { title: "BBC", uri: "https://www.bbc.com/news/example" } },
              ],
            },
          },
        ],
      };
    });

    const retryOk = await executeWebSearch(
      flaky503Ai,
      { query: "transient 503 recovery test" },
      "UTC",
      retryCoordinator
    );
    assert.equal(attempts, 2, "Transient 503 must retry at most once");
    assert.equal(retryOk.status, "ok");

    // Persistent 503 must stop after 2 total attempts (initial + 1 retry)
    const always503Coordinator = new WebSearchCoordinator();
    let persistentAttempts = 0;
    const always503Ai = createMockAi(async () => {
      persistentAttempts += 1;
      throw Object.assign(new Error("Service unavailable"), { status: 503 });
    });
    const persistentFail = await executeWebSearch(
      always503Ai,
      { query: "persistent 503 test" },
      "UTC",
      always503Coordinator
    );
    assert.equal(persistentAttempts, 2);
    assert.equal(persistentFail.status, "error");
    assert.equal(persistentFail.errorCode, "SERVICE_UNAVAILABLE");
    assert.equal(
      (persistentFail.diagnostics as { retriedTransientError?: boolean })
        ?.retriedTransientError,
      true
    );
  }

  // 8. Honest fallback & orchestration prompt rules when search is unavailable
  {
    const coordinator = new WebSearchCoordinator();
    const emptyAi = createMockAi(async () => ({
      text: "",
      candidates: [{ groundingMetadata: { groundingChunks: [] } }],
    }));

    const res = await executeWebSearch(
      emptyAi,
      { query: "obscure nonexistent event xyz123" },
      "UTC",
      coordinator
    );
    assert.equal(res.status, "no_results");
    assert.deepEqual(res.sources, []);

    const abortErr = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    assert.equal(classifySearchError(abortErr).errorCode, "TIMEOUT");

    const prompt = buildYunerthOrchestrationInstruction("Asia/Kolkata");
    assert.ok(prompt.includes("ALWAYS call `search_web`"));
    assert.ok(prompt.includes("Do NOT call `search_web` unnecessarily"));
    assert.ok(prompt.includes("planOrBillingRestricted"));
    assert.ok(prompt.includes("Do NOT describe this as a brief temporary rate limit"));
    assert.ok(prompt.includes("NEVER present outdated memory as newly verified current facts"));
  }

  console.log("WEB_SEARCH_RELIABILITY_AND_DIAGNOSTICS_TESTS: PASSED");
}

runTests().catch((err) => {
  console.error("WEB_SEARCH_TEST_FAILED:", err);
  process.exit(1);
});
