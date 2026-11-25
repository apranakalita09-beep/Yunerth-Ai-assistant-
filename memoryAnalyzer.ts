import { ThinkingLevel, Type, type GoogleGenAI } from "@google/genai";
import {
  assessDuplicateOrConflict,
  coerceMemoryCategory,
  containsSensitiveSecret,
  normalizeMemoryDescription,
} from "./memoryCore.ts";
import { isVoiceModeOnlyUtterance } from "./sessionContext.ts";
import {
  MEMORY_CATEGORIES,
  type AnalyzedMemoryCandidate,
  type MemoryRecord,
} from "./src/memory/types.ts";

const MEMORY_ANALYZER_MODEL = "gemini-4-hydrogen";
const MIN_ANALYZABLE_CHARS = 7;

const EXPLICIT_MEMORY_COMMAND_PATTERN =
  /\b(?:remember\s+that|don'?t\s+forget\s+(?:that|to\s+remember)|save\s+(?:this|that)\s+(?:to\s+)?memory|add\s+(?:this|that)\s+to\s+(?:your\s+)?memory|keep\s+in\s+mind\s+that)\b/i;

const TRIVIAL_UTTERANCE_PATTERN =
  /^(?:hi|hello|hey|good morning|good afternoon|good evening|good night|how are you(?: doing)?|thanks?(?:\s+(?:so\s+much|very\s+much|a\s+lot))?|thank you(?:\s+(?:so\s+much|very\s+much|again))?|ok(?:ay)?|got it|sounds good|cool|nice|sure|yeah|yes|no|nope|bye|goodbye|alright)[.!?\s]*$/i;

const EPHEMERAL_WEATHER_TIME_PATTERN =
  /^(?:what(?:'s|\s+is)\s+the\s+(?:weather|temperature|forecast|time|date)|what\s+time\s+is\s+it|is\s+it\s+raining)\b/i;

const MEMORY_RECALL_QUESTION_PATTERN =
  /^(?:what(?:'s|\s+is|\s+was)\s+my\s+|do you remember\s+(?:my|what)\s+|can you tell me\s+(?:my|what i)\s+|did i tell you\s+)/i;

const MEMORY_ANALYSIS_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    memories: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          level: {
            type: Type.STRING,
            enum: ["level1_auto", "level2_important"],
          },
          category: {
            type: Type.STRING,
            enum: [...MEMORY_CATEGORIES],
          },
          description: {
            type: Type.STRING,
          },
          reason: {
            type: Type.STRING,
          },
          updatesExistingId: {
            type: Type.STRING,
          },
        },
        required: ["level", "category", "description", "reason"],
      },
    },
  },
  required: ["memories"],
};

export interface TurnMemoryAnalysisResult {
  candidates: AnalyzedMemoryCandidate[];
  skippedReason?: string;
  metrics: {
    detectionMs: number;
    classificationMs: number;
  };
}

export function shouldSkipAsyncTurnAnalysis(userText: string): string | null {
  const clean = userText.replace(/\s+/g, " ").trim();
  if (!clean || clean.length < MIN_ANALYZABLE_CHARS) return "too_short";
  if (TRIVIAL_UTTERANCE_PATTERN.test(clean)) return "small_talk";
  if (isVoiceModeOnlyUtterance(clean)) return "voice_speed_command";
  if (EXPLICIT_MEMORY_COMMAND_PATTERN.test(clean)) {
    return "explicit_voice_command_handled_by_tool";
  }
  if (EPHEMERAL_WEATHER_TIME_PATTERN.test(clean)) {
    return "ephemeral_utility_query";
  }
  if (MEMORY_RECALL_QUESTION_PATTERN.test(clean)) {
    return "memory_recall_question";
  }
  if (containsSensitiveSecret(clean).blocked) {
    return "sensitive_secret_blocked";
  }
  return null;
}

function parseRawAnalysisJson(rawText: string): Array<Record<string, unknown>> {
  const trimmed = rawText.trim();
  if (!trimmed) return [];
  const unfenced = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(unfenced) as
      | { memories?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.memories)) return parsed.memories;
  } catch {
    // Ignore malformed JSON from non-critical background task
  }
  return [];
}

function isRetryableAnalyzerError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("timeout") ||
    msg.includes("deadline")
  );
}

export async function analyzeCompletedTurnForMemory(options: {
  ai: GoogleGenAI | null;
  userText: string;
  assistantText: string;
  currentTopic?: string | null;
  existingMemories: MemoryRecord[];
  recentlyDeclinedDescriptions?: string[];
  turnCompletedAtMs?: number;
}): Promise<TurnMemoryAnalysisResult> {
  const startedAt = Date.now();
  const detectionMs = options.turnCompletedAtMs
    ? Math.max(0, startedAt - options.turnCompletedAtMs)
    : 0;

  const skipReason = shouldSkipAsyncTurnAnalysis(options.userText);
  if (skipReason) {
    return {
      candidates: [],
      skippedReason: skipReason,
      metrics: {
        detectionMs,
        classificationMs: Math.max(0, Date.now() - startedAt),
      },
    };
  }
  if (!options.ai) {
    return {
      candidates: [],
      skippedReason: "ai_client_unavailable",
      metrics: {
        detectionMs,
        classificationMs: Math.max(0, Date.now() - startedAt),
      },
    };
  }

  const existingSummary =
    options.existingMemories.length > 0
      ? options.existingMemories
          .slice(0, 20)
          .map((m) => `- [${m.id}] (${m.category}): ${m.description}`)
          .join("\n")
      : "(none)";

  const declinedSummary =
    options.recentlyDeclinedDescriptions &&
    options.recentlyDeclinedDescriptions.length > 0
      ? options.recentlyDeclinedDescriptions.map((d) => `- ${d}`).join("\n")
      : "(none)";

  const prompt = [
    "You are Yunerth's silent post-turn Long-Term Memory Analyzer.",
    "Inspect ONE completed turn and return JSON matching the schema.",
    "",
    "Strict Rules:",
    "1. Extract ONLY durable, useful facts explicitly stated by the user: stable preferences (favorite color, food, games, communication style like simple English), ongoing projects, active learning, recurring habits/interests, identity/relationship facts, important life goals/milestones, or direct corrections updating Existing Memories.",
    "2. Return an empty memories array for small talk, jokes, guesses, temporary conversation details, hypothetical examples, or facts already identical in Existing Memories.",
    "3. NEVER extract passwords, API keys, auth tokens, PINs, payment cards, bank details, OTPs, or government IDs.",
    "4. Assign exact category from: Identity, Preferences, Life, Active, Relationships, Milestones, Behaviors.",
    "5. Saving Levels:",
    '   - "level1_auto": Ordinary durable preferences, habits, interests, tools, or projects (e.g., "Favorite color is blue", "Prefers explanations in simple English", "Working on Yunerth project").',
    '   - "level2_important": Exceptionally important personal goals, major commitments, life transitions, or things the user marks as very important that deserve permission first.',
    "6. If correcting or updating an item in Existing Memories (e.g. 'Actually I changed my project' or 'Now my favorite color is green'), set updatesExistingId to its exact ID.",
    "7. Do NOT propose anything matching Recently Declined items.",
    "",
    `Active Topic: ${options.currentTopic || "General"}`,
    `Existing Memories:\n${existingSummary}`,
    `Recently Declined (do not re-propose):\n${declinedSummary}`,
    "",
    `User said: "${options.userText}"`,
    `Assistant replied: "${options.assistantText}"`,
  ].join("\n");

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await options.ai.models.generateContent({
        model: MEMORY_ANALYZER_MODEL,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: MEMORY_ANALYSIS_RESPONSE_SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const rawItems = parseRawAnalysisJson(response.text || "");
      const results: AnalyzedMemoryCandidate[] = [];
      const declinedList = (options.recentlyDeclinedDescriptions || []).map(
        (d) => d.toLowerCase()
      );

      for (const item of rawItems.slice(0, 2)) {
        const level =
          item.level === "level2_important" ? "level2_important" : "level1_auto";
        const rawDesc =
          typeof item.description === "string" ? item.description : "";
        const description = normalizeMemoryDescription(rawDesc);
        if (description.length < 5) continue;
        if (containsSensitiveSecret(description).blocked) continue;
        if (containsSensitiveSecret(options.userText).blocked) continue;

        const lowerDesc = description.toLowerCase();
        if (
          declinedList.some(
            (declined) =>
              declined === lowerDesc ||
              (declined.length > 10 &&
                (lowerDesc.includes(declined) || declined.includes(lowerDesc)))
          )
        ) {
          continue;
        }

        const category = MEMORY_CATEGORIES.includes(
          item.category as (typeof MEMORY_CATEGORIES)[number]
        )
          ? (item.category as (typeof MEMORY_CATEGORIES)[number])
          : coerceMemoryCategory(item.category, description);

        const dupCheck = assessDuplicateOrConflict(
          description,
          category,
          options.existingMemories
        );
        if (dupCheck.kind === "exact_duplicate") {
          continue;
        }

        const updatesExistingId =
          typeof item.updatesExistingId === "string" &&
          options.existingMemories.some((m) => m.id === item.updatesExistingId)
            ? item.updatesExistingId
            : dupCheck.kind === "update_or_conflict"
              ? dupCheck.matchedMemory?.id
              : undefined;

        const reason =
          typeof item.reason === "string" && item.reason.trim()
            ? item.reason.trim().slice(0, 180)
            : level === "level2_important"
              ? "Detected significant goal, commitment, or explicitly marked important statement."
              : "Detected useful long-term preference, project, or context.";

        results.push({
          level,
          description,
          category,
          reason,
          updatesExistingId,
        });
      }

      return {
        candidates: results,
        metrics: {
          detectionMs,
          classificationMs: Math.max(0, Date.now() - startedAt),
        },
      };
    } catch (err) {
      lastError = err;
      if (attempt === 0 && isRetryableAnalyzerError(err)) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      break;
    }
  }

  console.warn(
    "[MemoryAnalyzer] Post-turn background analysis failed:",
    lastError instanceof Error ? lastError.message : lastError
  );
  return {
    candidates: [],
    skippedReason: "analyzer_error",
    metrics: {
      detectionMs,
      classificationMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

export interface QueuedTurnAnalysisJob {
  userText: string;
  assistantText: string;
  currentTopic?: string | null;
  turnCompletedAtMs: number;
}

export class BackgroundMemoryAnalyzerQueue {
  private readonly maxQueueDepth = 3;
  private readonly seenTurnSignatures = new Set<string>();
  private readonly pendingJobs: QueuedTurnAnalysisJob[] = [];
  private isProcessing = false;
  private disposed = false;

  constructor(
    private readonly handlers: {
      getAi: () => GoogleGenAI | null;
      getExistingMemories: () => MemoryRecord[];
      getDeclinedDescriptions: () => string[];
      onCandidates: (
        result: TurnMemoryAnalysisResult,
        job: QueuedTurnAnalysisJob
      ) => void;
    }
  ) {}

  enqueue(job: QueuedTurnAnalysisJob): boolean {
    if (this.disposed) return false;
    const normalizedUser = job.userText
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\u0900-\u097F\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (shouldSkipAsyncTurnAnalysis(job.userText) !== null) {
      return false;
    }

    if (normalizedUser && this.seenTurnSignatures.has(normalizedUser)) {
      return false;
    }

    if (normalizedUser) {
      this.seenTurnSignatures.add(normalizedUser);
      if (this.seenTurnSignatures.size > 40) {
        const oldest = this.seenTurnSignatures.values().next().value;
        if (oldest) this.seenTurnSignatures.delete(oldest);
      }
    }

    // Keep backlog bounded by replacing oldest unstarted item if overloaded
    if (this.pendingJobs.length >= this.maxQueueDepth) {
      this.pendingJobs.shift();
    }
    this.pendingJobs.push(job);
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.isProcessing || this.disposed) return;
    this.isProcessing = true;
    try {
      while (!this.disposed && this.pendingJobs.length > 0) {
        const job = this.pendingJobs.shift()!;
        const result = await analyzeCompletedTurnForMemory({
          ai: this.handlers.getAi(),
          userText: job.userText,
          assistantText: job.assistantText,
          currentTopic: job.currentTopic,
          existingMemories: this.handlers.getExistingMemories(),
          recentlyDeclinedDescriptions: this.handlers.getDeclinedDescriptions(),
          turnCompletedAtMs: job.turnCompletedAtMs,
        });
        if (this.disposed) return;
        this.handlers.onCandidates(result, job);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pendingJobs.length = 0;
  }
}
