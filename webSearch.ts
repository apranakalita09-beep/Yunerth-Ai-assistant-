import { AsyncLocalStorage } from "node:async_hooks";
import {
  GoogleGenAI,
  ThinkingLevel,
  Type,
  type FunctionDeclaration,
} from "@google/genai";

export interface WebSearchSource {
  title: string;
  url: string;
}

export type WebSearchErrorCode =
  | "SEARCH_GROUNDING_QUOTA"
  | "MODEL_QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "PERMISSION_DENIED"
  | "UNAUTHENTICATED"
  | "INVALID_REQUEST"
  | "SERVICE_UNAVAILABLE"
  | "TIMEOUT"
  | "SEARCH_FAILED";

export interface WebSearchErrorDiagnostics {
  httpStatus?: number;
  rpcStatus?: string;
  reason?: string;
  quotaCategory?: "search_grounding" | "model_quota" | "rate_limit" | "none";
  quotaMetrics?: string[];
  quotaIds?: string[];
  quotaModels?: string[];
  isZeroLimit?: boolean;
  planOrBillingRestricted?: boolean;
  retryAfterSeconds?: number;
  retryAfterHeaderSeconds?: number;
  retriedTransientError?: boolean;
  upstreamSummary?: string;
  apiVersion?: string;
  detailCount?: number;
  rawDetails?: Array<Record<string, unknown>>;
}

export interface WebSearchResult {
  status: "ok" | "no_results" | "error";
  errorCode?: WebSearchErrorCode;
  query: string;
  searchedAt: string;
  summary?: string;
  sources: WebSearchSource[];
  searchQueries?: string[];
  message?: string;
  cached?: boolean;
  cooldownActive?: boolean;
  retryAfterSeconds?: number;
  diagnostics?: WebSearchErrorDiagnostics;
}

export interface SearchDiagnosticProbeResult {
  checkedAt: string;
  configured: boolean;
  searchModel: string;
  cooldownRemainingSeconds: number;
  lastOutcome: {
    status: WebSearchResult["status"];
    errorCode?: WebSearchErrorCode;
    searchedAt: string;
    diagnostics?: WebSearchErrorDiagnostics;
  } | null;
  probes?: {
    plainModelV1Beta: {
      ok: boolean;
      latencyMs: number;
      textPreview?: string;
      errorCode?: WebSearchErrorCode;
      diagnostics?: WebSearchErrorDiagnostics;
    };
    searchGroundedV1Beta: {
      ok: boolean;
      latencyMs: number;
      sourceCount?: number;
      searchQueries?: string[];
      errorCode?: WebSearchErrorCode;
      diagnostics?: WebSearchErrorDiagnostics;
    };
  };
}

export const SEARCH_MODEL = "gemini-4-hydrogen";
const SEARCH_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 45000;
const DEFAULT_TEMP_RATE_LIMIT_COOLDOWN_MS = 15000;
const PLAN_OR_GROUNDING_QUOTA_COOLDOWN_MS = 300000; // 5 minutes for non-transient plan/grounding blocks
const AUTH_OR_CONFIG_COOLDOWN_MS = 60000;
const MAX_TEMP_COOLDOWN_MS = 120000;
const MIN_TEMP_COOLDOWN_MS = 5000;
const TRANSIENT_5XX_BASE_BACKOFF_MS = 650;

interface CapturedHttpMeta {
  retryAfterHeaderSeconds?: number;
  status?: number;
}

const httpMetaStorage = new AsyncLocalStorage<CapturedHttpMeta>();

export function parseRetryAfterHeader(rawHeader: string | null): number | undefined {
  if (!rawHeader) return undefined;
  const trimmed = rawHeader.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const secs = Math.ceil(Number(trimmed));
    return Number.isFinite(secs) && secs > 0 ? secs : undefined;
  }
  const targetMs = Date.parse(trimmed);
  if (Number.isFinite(targetMs)) {
    const deltaSecs = Math.ceil((targetMs - Date.now()) / 1000);
    return deltaSecs > 0 ? deltaSecs : undefined;
  }
  return undefined;
}

export const WEB_SEARCH_FUNCTION_DECLARATION: FunctionDeclaration = {
  name: "search_web",
  description:
    "Searches the live internet via Google Search grounding for current news, recent events, mutable real-time facts (such as current officeholders, latest releases, live scores, prices, or current conditions), or any topic the user asks to look up. Do NOT use this for time/date/time-difference queries (use get_world_clock / get_time_difference) or for casual chat or timeless general knowledge.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description:
          "Clear, specific search query capturing what the user wants to find online, resolved with any active conversation context.",
      },
      recency: {
        type: Type.STRING,
        description:
          "Optional recency hint: 'today' for breaking/today news, 'recent' for recent developments, or 'general' for general current lookup.",
      },
    },
    required: ["query"],
  },
};

export function createSearchGenAIClient(
  apiVersion = "v1beta"
): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }

  const headerCapturingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const store = httpMetaStorage.getStore();
    if (store) {
      store.status = response.status;
      const retryAfter = parseRetryAfterHeader(
        response.headers.get("retry-after")
      );
      if (retryAfter !== undefined) {
        store.retryAfterHeaderSeconds = retryAfter;
      }
    }
    return response;
  };

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(apiVersion ? { apiVersion } : {}),
      fetch: headerCapturingFetch,
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function sanitizeUpstreamText(text: string): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{16,}/g, "[REDACTED_KEY]")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSafeSourceTitle(title: string | undefined, uri: string): string {
  const cleanTitle = title?.trim();
  if (cleanTitle) return cleanTitle;
  try {
    return new URL(uri).hostname.replace(/^www\./, "") || "Web Source";
  } catch {
    return "Web Source";
  }
}

function parseDurationSeconds(rawDelay: unknown): number | undefined {
  if (typeof rawDelay === "number" && Number.isFinite(rawDelay) && rawDelay > 0) {
    return Math.ceil(rawDelay);
  }
  if (typeof rawDelay !== "string") return undefined;
  const match = rawDelay.trim().match(/^(\d+(?:\.\d+)?)s$/i);
  if (match) {
    const val = Number(match[1]);
    return Number.isFinite(val) && val > 0 ? Math.ceil(val) : undefined;
  }
  return undefined;
}

interface ParsedRpcPayload {
  code?: number;
  message?: string;
  status?: string;
  details?: Array<Record<string, unknown>>;
}

function tryParseRpcPayload(rawMessage: string): ParsedRpcPayload | null {
  const trimmed = rawMessage.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
      error?: ParsedRpcPayload;
      code?: number;
      message?: string;
      status?: string;
      details?: Array<Record<string, unknown>>;
    };
    if (parsed.error && typeof parsed.error === "object") {
      return parsed.error;
    }
    if (
      typeof parsed.code === "number" ||
      typeof parsed.status === "string" ||
      typeof parsed.message === "string"
    ) {
      return parsed;
    }
  } catch {
    // Message does not contain valid JSON error payload
  }
  return null;
}

export function classifySearchError(
  err: unknown,
  apiVersion?: string,
  retryAfterHeaderSeconds?: number
): {
  errorCode: WebSearchErrorCode;
  message: string;
  retryAfterMs?: number;
  diagnostics: WebSearchErrorDiagnostics;
} {
  const errObj =
    err && typeof err === "object"
      ? (err as {
          name?: unknown;
          status?: unknown;
          code?: unknown;
          message?: unknown;
          errorDetails?: unknown;
        })
      : undefined;

  const rawMessage =
    err instanceof Error ? err.message : String(err ?? "");
  const rpc = tryParseRpcPayload(rawMessage);

  const httpStatus =
    typeof errObj?.status === "number"
      ? errObj.status
      : typeof rpc?.code === "number"
        ? rpc.code
        : undefined;
  const rpcStatus = typeof rpc?.status === "string" ? rpc.status : undefined;
  const cleanMessage = sanitizeUpstreamText(rpc?.message || rawMessage);
  const lower = cleanMessage.toLowerCase();

  const details: Array<Record<string, unknown>> = Array.isArray(rpc?.details)
    ? rpc.details
    : Array.isArray(errObj?.errorDetails)
      ? (errObj.errorDetails as Array<Record<string, unknown>>)
      : [];

  let reason: string | undefined;
  const quotaMetrics: string[] = [];
  const quotaIds: string[] = [];
  const quotaModels: string[] = [];
  let isZeroLimit = false;
  let retryAfterSecondsFromBody: number | undefined;

  for (const detail of details) {
    const type = typeof detail["@type"] === "string" ? detail["@type"] : "";
    if (type.includes("ErrorInfo")) {
      if (typeof detail.reason === "string") {
        reason = detail.reason;
      }
    }
    if (type.includes("RetryInfo")) {
      const parsedDelay = parseDurationSeconds(detail.retryDelay);
      if (parsedDelay !== undefined) {
        retryAfterSecondsFromBody = parsedDelay;
      }
    }
    if (type.includes("QuotaFailure") && Array.isArray(detail.violations)) {
      for (const v of detail.violations as Array<Record<string, unknown>>) {
        if (typeof v.quotaMetric === "string" && !quotaMetrics.includes(v.quotaMetric)) {
          quotaMetrics.push(v.quotaMetric);
        }
        if (typeof v.quotaId === "string" && !quotaIds.includes(v.quotaId)) {
          quotaIds.push(v.quotaId);
        }
        if (
          v.quotaValue === "0" ||
          v.quotaValue === 0 ||
          (typeof v.description === "string" && /\blimit\s*[:=]\s*0\b/i.test(v.description))
        ) {
          isZeroLimit = true;
        }
        const dims = v.quotaDimensions;
        if (dims && typeof dims === "object") {
          const modelDim = (dims as Record<string, unknown>).model;
          if (typeof modelDim === "string" && !quotaModels.includes(modelDim)) {
            quotaModels.push(modelDim);
          }
        }
      }
    }
  }

  if (!isZeroLimit && /\blimit\s*[:=]\s*0\b/i.test(cleanMessage)) {
    isZeroLimit = true;
  }

  if (retryAfterSecondsFromBody === undefined) {
    const msgRetryMatch = cleanMessage.match(/retry\s+in\s+(\d+(?:\.\d+)?)\s*s/i);
    if (msgRetryMatch) {
      const parsed = Math.ceil(Number(msgRetryMatch[1]));
      if (Number.isFinite(parsed) && parsed > 0) {
        retryAfterSecondsFromBody = parsed;
      }
    }
  }

  const effectiveProvidedRetrySeconds =
    retryAfterHeaderSeconds ?? retryAfterSecondsFromBody;

  // Timeout / Abort classification
  if (
    errObj?.name === "AbortError" ||
    lower.includes("timed out") ||
    lower.includes("aborted")
  ) {
    return {
      errorCode: "TIMEOUT",
      message: "The live web search request timed out before returning results.",
      diagnostics: {
        httpStatus,
        rpcStatus,
        reason,
        quotaCategory: "none",
        upstreamSummary: cleanMessage || "Request aborted due to timeout.",
        apiVersion,
      },
    };
  }

  // 401 Unauthenticated
  if (httpStatus === 401 || rpcStatus === "UNAUTHENTICATED") {
    return {
      errorCode: "UNAUTHENTICATED",
      message:
        "Live web search failed authentication (HTTP 401). Check the active API key in Settings > Secrets.",
      retryAfterMs: AUTH_OR_CONFIG_COOLDOWN_MS,
      diagnostics: {
        httpStatus: httpStatus ?? 401,
        rpcStatus: rpcStatus ?? "UNAUTHENTICATED",
        reason,
        quotaCategory: "none",
        retryAfterSeconds: Math.round(AUTH_OR_CONFIG_COOLDOWN_MS / 1000),
        upstreamSummary: cleanMessage,
        apiVersion,
      },
    };
  }

  // 403 Permission denied / API key or project scope restrictions
  if (
    httpStatus === 403 ||
    rpcStatus === "PERMISSION_DENIED" ||
    lower.includes("permission_denied") ||
    reason === "SERVICE_DISABLED" ||
    reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"
  ) {
    return {
      errorCode: "PERMISSION_DENIED",
      message: `Live web search permission denied (HTTP 403${reason ? `, ${reason}` : ""}). Check API key restrictions and Generative Language API access in Google Cloud / Settings > Secrets.`,
      retryAfterMs: AUTH_OR_CONFIG_COOLDOWN_MS,
      diagnostics: {
        httpStatus: httpStatus ?? 403,
        rpcStatus: rpcStatus ?? "PERMISSION_DENIED",
        reason,
        quotaCategory: "none",
        retryAfterSeconds: Math.round(AUTH_OR_CONFIG_COOLDOWN_MS / 1000),
        upstreamSummary: cleanMessage,
        apiVersion,
      },
    };
  }

  // 429 Quota / Rate Limit — separate Search Grounding plan/quota blocks vs Model quota vs Temporary rate limits
  if (
    httpStatus === 429 ||
    rpcStatus === "RESOURCE_EXHAUSTED" ||
    lower.includes("resource_exhausted") ||
    lower.includes("429") ||
    lower.includes("quota") ||
    lower.includes("rate limit")
  ) {
    const joinedMetrics = `${quotaMetrics.join(" ")} ${quotaIds.join(" ")} ${cleanMessage}`.toLowerCase();
    const isGroundingMetric =
      joinedMetrics.includes("grounding") ||
      joinedMetrics.includes("google_search") ||
      joinedMetrics.includes("search_grounding");
    const isPlanOrBillingNotice =
      joinedMetrics.includes("plan and billing") ||
      joinedMetrics.includes("billing details") ||
      joinedMetrics.includes("ai.dev/rate-limit");
    const isExplicitRpmOrTpmRateLimit =
      joinedMetrics.includes("requests_per_minute") ||
      joinedMetrics.includes("tokens_per_minute") ||
      joinedMetrics.includes("per minute") ||
      joinedMetrics.includes("rate limit");
    const isModelSpecific =
      !isGroundingMetric &&
      (quotaModels.length > 0 ||
        joinedMetrics.includes("generate_content") ||
        joinedMetrics.includes("requests_per_day") ||
        joinedMetrics.includes("free_tier") ||
        joinedMetrics.includes("hydrogen"));

    const isGroundingOrPlanBlock =
      isGroundingMetric ||
      (isPlanOrBillingNotice &&
        !isModelSpecific &&
        effectiveProvidedRetrySeconds === undefined &&
        !isExplicitRpmOrTpmRateLimit);

    if (isGroundingOrPlanBlock) {
      const planRestricted = isZeroLimit || isPlanOrBillingNotice;
      const cooldownMs =
        effectiveProvidedRetrySeconds !== undefined
          ? Math.min(
              MAX_TEMP_COOLDOWN_MS,
              Math.max(MIN_TEMP_COOLDOWN_MS, effectiveProvidedRetrySeconds * 1000)
            )
          : PLAN_OR_GROUNDING_QUOTA_COOLDOWN_MS;
      const cooldownSeconds = Math.ceil(cooldownMs / 1000);

      return {
        errorCode: "SEARCH_GROUNDING_QUOTA",
        message: planRestricted
          ? "Live web search is blocked by the active project's Google Search grounding quota or plan/billing limits (HTTP 429 RESOURCE_EXHAUSTED). Verify Search grounding allowance and billing eligibility in Google AI Studio (ai.dev/rate-limit) or Settings > Secrets."
          : `Google Search grounding quota limit reached (HTTP 429 RESOURCE_EXHAUSTED). Pausing live search for ${cooldownSeconds}s before retrying.`,
        retryAfterMs: cooldownMs,
        diagnostics: {
          httpStatus: httpStatus ?? 429,
          rpcStatus: rpcStatus ?? "RESOURCE_EXHAUSTED",
          reason,
          quotaCategory: "search_grounding",
          quotaMetrics: quotaMetrics.length > 0 ? quotaMetrics : undefined,
          quotaIds: quotaIds.length > 0 ? quotaIds : undefined,
          quotaModels: quotaModels.length > 0 ? quotaModels : undefined,
          isZeroLimit,
          planOrBillingRestricted: planRestricted,
          retryAfterSeconds: cooldownSeconds,
          retryAfterHeaderSeconds,
          upstreamSummary: cleanMessage,
          apiVersion,
          detailCount: details.length,
          rawDetails: details.length > 0 ? details : undefined,
        },
      };
    }

    if (isModelSpecific) {
      const cooldownMs =
        effectiveProvidedRetrySeconds !== undefined
          ? Math.min(
              MAX_TEMP_COOLDOWN_MS,
              Math.max(MIN_TEMP_COOLDOWN_MS, effectiveProvidedRetrySeconds * 1000)
            )
          : isZeroLimit
            ? PLAN_OR_GROUNDING_QUOTA_COOLDOWN_MS
            : DEFAULT_TEMP_RATE_LIMIT_COOLDOWN_MS;
      const cooldownSeconds = Math.ceil(cooldownMs / 1000);

      return {
        errorCode: "MODEL_QUOTA_EXCEEDED",
        message: isZeroLimit
          ? `The search synthesis model (${SEARCH_MODEL}) reported a quota limit of 0 (HTTP 429 RESOURCE_EXHAUSTED). Check model quotas and project configuration in Google AI Studio / Google Cloud Console.`
          : `The search model (${SEARCH_MODEL}) hit a request or token quota limit (HTTP 429 RESOURCE_EXHAUSTED). Pausing live search for ${cooldownSeconds}s before retrying.`,
        retryAfterMs: cooldownMs,
        diagnostics: {
          httpStatus: httpStatus ?? 429,
          rpcStatus: rpcStatus ?? "RESOURCE_EXHAUSTED",
          reason,
          quotaCategory: "model_quota",
          quotaMetrics: quotaMetrics.length > 0 ? quotaMetrics : undefined,
          quotaIds: quotaIds.length > 0 ? quotaIds : undefined,
          quotaModels: quotaModels.length > 0 ? quotaModels : undefined,
          isZeroLimit,
          planOrBillingRestricted: isZeroLimit,
          retryAfterSeconds: cooldownSeconds,
          retryAfterHeaderSeconds,
          upstreamSummary: cleanMessage,
          apiVersion,
          detailCount: details.length,
          rawDetails: details.length > 0 ? details : undefined,
        },
      };
    }

    const tempCooldownMs =
      effectiveProvidedRetrySeconds !== undefined
        ? Math.min(
            MAX_TEMP_COOLDOWN_MS,
            Math.max(MIN_TEMP_COOLDOWN_MS, effectiveProvidedRetrySeconds * 1000)
          )
        : DEFAULT_TEMP_RATE_LIMIT_COOLDOWN_MS;
    const tempCooldownSeconds = Math.ceil(tempCooldownMs / 1000);

    return {
      errorCode: "RATE_LIMITED",
      message: `Live web search hit a temporary upstream rate limit (HTTP 429${rpcStatus ? ` ${rpcStatus}` : ""}). Pausing search for ${tempCooldownSeconds}s before retrying.`,
      retryAfterMs: tempCooldownMs,
      diagnostics: {
        httpStatus: httpStatus ?? 429,
        rpcStatus: rpcStatus ?? "RESOURCE_EXHAUSTED",
        reason,
        quotaCategory: "rate_limit",
        quotaMetrics: quotaMetrics.length > 0 ? quotaMetrics : undefined,
        quotaIds: quotaIds.length > 0 ? quotaIds : undefined,
        quotaModels: quotaModels.length > 0 ? quotaModels : undefined,
        isZeroLimit,
        retryAfterSeconds: tempCooldownSeconds,
        retryAfterHeaderSeconds,
        upstreamSummary: cleanMessage,
        apiVersion,
        detailCount: details.length,
        rawDetails: details.length > 0 ? details : undefined,
      },
    };
  }

  // 400 Invalid request / unsupported configuration / invalid key format
  if (
    httpStatus === 400 ||
    rpcStatus === "INVALID_ARGUMENT" ||
    reason === "API_KEY_INVALID" ||
    lower.includes("api_key_invalid") ||
    lower.includes("invalid argument")
  ) {
    return {
      errorCode: "INVALID_REQUEST",
      message:
        reason === "API_KEY_INVALID" || lower.includes("api_key_invalid")
          ? "Live web search rejected the configured API key as invalid (HTTP 400 API_KEY_INVALID). Check Settings > Secrets."
          : `Live web search request configuration was rejected (HTTP 400${rpcStatus ? ` ${rpcStatus}` : ""}): ${cleanMessage || "Invalid request parameters."}`,
      retryAfterMs: AUTH_OR_CONFIG_COOLDOWN_MS,
      diagnostics: {
        httpStatus: httpStatus ?? 400,
        rpcStatus: rpcStatus ?? "INVALID_ARGUMENT",
        reason,
        quotaCategory: "none",
        retryAfterSeconds: Math.round(AUTH_OR_CONFIG_COOLDOWN_MS / 1000),
        upstreamSummary: cleanMessage,
        apiVersion,
      },
    };
  }

  // 5xx Upstream temporary service error
  if (
    (httpStatus !== undefined && httpStatus >= 500) ||
    rpcStatus === "UNAVAILABLE" ||
    rpcStatus === "INTERNAL" ||
    rpcStatus === "DEADLINE_EXCEEDED"
  ) {
    return {
      errorCode: "SERVICE_UNAVAILABLE",
      message: `Google's live search service returned a temporary server error (HTTP ${httpStatus ?? 503}${rpcStatus ? ` ${rpcStatus}` : ""}). Please try again shortly.`,
      diagnostics: {
        httpStatus: httpStatus ?? 503,
        rpcStatus,
        reason,
        quotaCategory: "none",
        retryAfterHeaderSeconds,
        upstreamSummary: cleanMessage,
        apiVersion,
      },
    };
  }

  return {
    errorCode: "SEARCH_FAILED",
    message: cleanMessage || "Unable to complete live web search right now.",
    diagnostics: {
      httpStatus,
      rpcStatus,
      reason,
      quotaCategory: "none",
      upstreamSummary: cleanMessage,
      apiVersion,
    },
  };
}

function formatSearchDateContext(userLocalTimeZone?: string): string {
  const now = new Date();
  const tz = userLocalTimeZone || "UTC";
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now);
    return `${formatted} (${tz})`;
  } catch {
    return now.toISOString().slice(0, 10) + " (UTC)";
  }
}

function normalizeQueryKey(query: string, recency: string): string {
  return `${recency.toLowerCase()}::${query.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class WebSearchCoordinator {
  private readonly inFlight = new Map<string, Promise<WebSearchResult>>();
  private readonly recentCache = new Map<
    string,
    { result: WebSearchResult; expiresAt: number }
  >();
  private cooldownUntil = 0;
  private cooldownError: {
    errorCode: WebSearchErrorCode;
    message: string;
    diagnostics?: WebSearchErrorDiagnostics;
  } | null = null;
  private lastOutcome: SearchDiagnosticProbeResult["lastOutcome"] = null;
  private lastProbeTimestamp = 0;
  private lastProbeResult: SearchDiagnosticProbeResult["probes"] | undefined;

  getCooldownRemainingSeconds(now = Date.now()): number {
    if (now >= this.cooldownUntil) return 0;
    return Math.max(1, Math.ceil((this.cooldownUntil - now) / 1000));
  }

  clearState(): void {
    this.inFlight.clear();
    this.recentCache.clear();
    this.cooldownUntil = 0;
    this.cooldownError = null;
  }

  getDiagnosticsSnapshot(configured: boolean): SearchDiagnosticProbeResult {
    return {
      checkedAt: new Date().toISOString(),
      configured,
      searchModel: SEARCH_MODEL,
      cooldownRemainingSeconds: this.getCooldownRemainingSeconds(),
      lastOutcome: this.lastOutcome,
      probes: this.lastProbeResult,
    };
  }

  async runDiagnosticProbes(
    v1BetaAi: GoogleGenAI | null
  ): Promise<SearchDiagnosticProbeResult> {
    const now = Date.now();
    // Rate-limit live diagnostic probes to at most once per 15 seconds
    if (this.lastProbeResult && now - this.lastProbeTimestamp < 15000) {
      return this.getDiagnosticsSnapshot(Boolean(v1BetaAi));
    }
    this.lastProbeTimestamp = now;

    if (!v1BetaAi) {
      return this.getDiagnosticsSnapshot(false);
    }

    const probeCall = async (withSearch: boolean) => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      const meta: CapturedHttpMeta = {};
      try {
        const res = await httpMetaStorage.run(meta, () =>
          v1BetaAi.models.generateContent({
            model: SEARCH_MODEL,
            contents: withSearch
              ? "Current latest AI news today"
              : "Reply with OK.",
            config: {
              ...(withSearch
                ? {
                    tools: [{ googleSearch: {} }],
                    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                  }
                : {}),
              abortSignal: controller.signal,
            },
          })
        );
        clearTimeout(timer);
        const gm = res.candidates?.[0]?.groundingMetadata;
        return {
          ok: true as const,
          latencyMs: Date.now() - started,
          textPreview: (res.text ?? "").trim().slice(0, 120),
          sourceCount: gm?.groundingChunks?.length ?? 0,
          searchQueries: gm?.webSearchQueries ?? undefined,
        };
      } catch (err) {
        clearTimeout(timer);
        const classified = classifySearchError(
          err,
          "v1beta",
          meta.retryAfterHeaderSeconds
        );
        return {
          ok: false as const,
          latencyMs: Date.now() - started,
          errorCode: classified.errorCode,
          diagnostics: classified.diagnostics,
        };
      }
    };

    const plainV1BetaRes = await probeCall(false);
    const groundedV1BetaRes = await probeCall(true);

    if (groundedV1BetaRes.ok) {
      this.cooldownUntil = 0;
      this.cooldownError = null;
    }

    this.lastProbeResult = {
      plainModelV1Beta: {
        ok: plainV1BetaRes.ok,
        latencyMs: plainV1BetaRes.latencyMs,
        textPreview: plainV1BetaRes.ok ? plainV1BetaRes.textPreview : undefined,
        errorCode: plainV1BetaRes.ok ? undefined : plainV1BetaRes.errorCode,
        diagnostics: plainV1BetaRes.ok ? undefined : plainV1BetaRes.diagnostics,
      },
      searchGroundedV1Beta: {
        ok: groundedV1BetaRes.ok,
        latencyMs: groundedV1BetaRes.latencyMs,
        sourceCount: groundedV1BetaRes.ok ? groundedV1BetaRes.sourceCount : undefined,
        searchQueries: groundedV1BetaRes.ok ? groundedV1BetaRes.searchQueries : undefined,
        errorCode: groundedV1BetaRes.ok ? undefined : groundedV1BetaRes.errorCode,
        diagnostics: groundedV1BetaRes.ok ? undefined : groundedV1BetaRes.diagnostics,
      },
    };

    return this.getDiagnosticsSnapshot(true);
  }

  async search(
    ai: GoogleGenAI,
    args: Record<string, unknown> | undefined,
    userLocalTimeZone?: string,
    apiVersionLabel = "v1beta"
  ): Promise<WebSearchResult> {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    const recency =
      typeof args?.recency === "string" && args.recency.trim()
        ? args.recency.trim()
        : "general";
    const searchedAt = new Date().toISOString();

    if (!query) {
      return {
        status: "error",
        errorCode: "INVALID_REQUEST",
        query: "",
        searchedAt,
        sources: [],
        message: "No search query was provided.",
      };
    }

    const cacheKey = normalizeQueryKey(query, recency);
    const now = Date.now();

    // Return cached recent success without burning additional quota
    const cached = this.recentCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      return {
        ...cached.result,
        searchedAt,
        cached: true,
      };
    }

    // Coalesce identical concurrent search calls in-flight
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    // Clear expired cooldown automatically
    if (this.cooldownUntil > 0 && now >= this.cooldownUntil) {
      this.cooldownUntil = 0;
      this.cooldownError = null;
    }

    // Honor server-provided retryDelay / cooldown without sending failing duplicate calls
    if (now < this.cooldownUntil && this.cooldownError) {
      const remainingSeconds = this.getCooldownRemainingSeconds(now);
      const isPlanBlock = Boolean(
        this.cooldownError.diagnostics?.planOrBillingRestricted
      );
      return {
        status: "error",
        errorCode: this.cooldownError.errorCode,
        query,
        searchedAt,
        sources: [],
        cooldownActive: true,
        retryAfterSeconds: remainingSeconds,
        message: isPlanBlock
          ? this.cooldownError.message
          : `${this.cooldownError.message} Waiting ${remainingSeconds}s before trying live search again.`,
        diagnostics: this.cooldownError.diagnostics,
      };
    }

    const requestPromise = this.executeSingleRequest(
      ai,
      query,
      recency,
      userLocalTimeZone,
      apiVersionLabel
    ).finally(() => {
      this.inFlight.delete(cacheKey);
    });

    this.inFlight.set(cacheKey, requestPromise);
    return requestPromise;
  }

  private async executeSingleRequest(
    ai: GoogleGenAI,
    query: string,
    recency: string,
    userLocalTimeZone: string | undefined,
    apiVersionLabel: string
  ): Promise<WebSearchResult> {
    const searchedAt = new Date().toISOString();
    const dateContext = formatSearchDateContext(userLocalTimeZone);
    const controller = new AbortController();
    const timerId = setTimeout(() => {
      controller.abort();
    }, SEARCH_TIMEOUT_MS);

    const runAttempt = async () => {
      const meta: CapturedHttpMeta = {};
      try {
        const response = await httpMetaStorage.run(meta, () =>
          ai.models.generateContent({
            model: SEARCH_MODEL,
            contents: `Today's date context: ${dateContext}.
Recency focus: ${recency}.
User search query: ${query}`,
            config: {
              systemInstruction: `You are a factual real-time search grounding synthesizer for a voice assistant.
- Use Google Search results strictly to answer the query accurately.
- Clearly distinguish recent or today's developments from older background facts by mentioning dates when relevant.
- Keep the synthesis crisp, well-organized, and factual (3 to 6 key points or concise sentences) so a voice assistant can summarize the main points first and expand if asked.
- If search results do not contain reliable or current information for the query, state that clearly instead of guessing or inventing details.`,
              tools: [{ googleSearch: {} }],
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              abortSignal: controller.signal,
            },
          })
        );
        return { response, meta };
      } catch (err) {
        throw Object.assign(
          err instanceof Error ? err : new Error(String(err)),
          { __capturedMeta: meta }
        );
      }
    };

    let retriedTransientError = false;

    try {
      let attemptResult: Awaited<ReturnType<typeof runAttempt>>;
      try {
        attemptResult = await runAttempt();
      } catch (firstErr) {
        const firstMeta = (firstErr as { __capturedMeta?: CapturedHttpMeta })
          ?.__capturedMeta;
        const firstClassified = classifySearchError(
          firstErr,
          apiVersionLabel,
          firstMeta?.retryAfterHeaderSeconds
        );

        // Bounded 1-retry with jittered backoff ONLY for transient 5xx service failures (never 429/40x)
        if (
          firstClassified.errorCode === "SERVICE_UNAVAILABLE" &&
          !controller.signal.aborted
        ) {
          retriedTransientError = true;
          const jitterMs = Math.floor(Math.random() * 200);
          await abortableDelay(
            TRANSIENT_5XX_BASE_BACKOFF_MS + jitterMs,
            controller.signal
          );
          attemptResult = await runAttempt();
        } else {
          throw firstErr;
        }
      }

      clearTimeout(timerId);
      const { response } = attemptResult;
      const summary = (response.text ?? "").trim();
      const groundingMetadata = response.candidates?.[0]?.groundingMetadata;
      const rawChunks = groundingMetadata?.groundingChunks ?? [];

      const seenUrls = new Set<string>();
      const sources: WebSearchSource[] = [];
      for (const chunk of rawChunks) {
        const uri = chunk.web?.uri?.trim();
        if (uri && !seenUrls.has(uri)) {
          seenUrls.add(uri);
          sources.push({
            title: extractSafeSourceTitle(chunk.web?.title, uri),
            url: uri,
          });
        }
        if (sources.length >= 6) break;
      }

      const searchQueries = groundingMetadata?.webSearchQueries ?? undefined;

      if (!summary && sources.length === 0) {
        const noResults: WebSearchResult = {
          status: "no_results",
          query,
          searchedAt,
          sources: [],
          searchQueries,
          message:
            "Live web search did not return reliable current results for that query.",
        };
        this.lastOutcome = {
          status: "no_results",
          searchedAt,
        };
        return noResults;
      }

      const okResult: WebSearchResult = {
        status: "ok",
        query,
        searchedAt,
        summary,
        sources,
        searchQueries,
      };
      this.cooldownUntil = 0;
      this.cooldownError = null;
      this.recentCache.set(normalizeQueryKey(query, recency), {
        result: okResult,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      this.lastOutcome = {
        status: "ok",
        searchedAt,
      };
      return okResult;
    } catch (err) {
      clearTimeout(timerId);
      const capturedMeta = (err as { __capturedMeta?: CapturedHttpMeta })
        ?.__capturedMeta;
      const classified = classifySearchError(
        err,
        apiVersionLabel,
        capturedMeta?.retryAfterHeaderSeconds
      );
      if (retriedTransientError) {
        classified.diagnostics.retriedTransientError = true;
      }

      if (classified.retryAfterMs && classified.retryAfterMs > 0) {
        this.cooldownUntil = Date.now() + classified.retryAfterMs;
        this.cooldownError = {
          errorCode: classified.errorCode,
          message: classified.message,
          diagnostics: classified.diagnostics,
        };
      }

      this.lastOutcome = {
        status: "error",
        errorCode: classified.errorCode,
        searchedAt,
        diagnostics: classified.diagnostics,
      };

      console.warn(
        `Live web search failed (${classified.errorCode}, status=${classified.diagnostics.httpStatus ?? "none"}, planRestricted=${Boolean(classified.diagnostics.planOrBillingRestricted)}, metric=${classified.diagnostics.quotaMetrics?.join(",") || "none"}):`,
        classified.diagnostics.upstreamSummary || classified.message
      );

      return {
        status: "error",
        errorCode: classified.errorCode,
        query,
        searchedAt,
        sources: [],
        retryAfterSeconds: classified.diagnostics.retryAfterSeconds,
        message: classified.message,
        diagnostics: classified.diagnostics,
      };
    }
  }
}

const defaultCoordinator = new WebSearchCoordinator();

export function getDefaultWebSearchCoordinator(): WebSearchCoordinator {
  return defaultCoordinator;
}

export async function executeWebSearch(
  ai: GoogleGenAI,
  args: Record<string, unknown> | undefined,
  userLocalTimeZone?: string,
  coordinator: WebSearchCoordinator = defaultCoordinator
): Promise<Record<string, unknown>> {
  const result = await coordinator.search(ai, args, userLocalTimeZone);
  return result as unknown as Record<string, unknown>;
}
