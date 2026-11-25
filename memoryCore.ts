import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryConfirmationStatus,
  type MemoryImportance,
  type MemoryRecord,
  type MemorySource,
} from "./src/memory/types.ts";

export const MAX_MEMORY_DESCRIPTION_LENGTH = 600;
export const MIN_MEMORY_DESCRIPTION_LENGTH = 3;
export const MAX_MEMORY_KEYWORDS = 16;

const VALID_CATEGORIES = new Set<string>(MEMORY_CATEGORIES);
const VALID_SOURCES = new Set<string>(["Manual", "Voice", "Automatic"]);
const VALID_IMPORTANCE = new Set<string>(["standard", "important"]);
const VALID_CONFIRMATION_STATUS = new Set<string>([
  "manual",
  "voice",
  "auto_saved",
  "user_approved",
]);

const STOPWORDS = new Set<string>([
  "the",
  "and",
  "for",
  "that",
  "with",
  "this",
  "from",
  "have",
  "has",
  "are",
  "was",
  "were",
  "will",
  "would",
  "could",
  "should",
  "about",
  "into",
  "your",
  "you",
  "user",
  "they",
  "their",
  "them",
  "what",
  "when",
  "where",
  "which",
  "while",
  "please",
  "remember",
  "yunerth",
  "also",
  "just",
  "very",
  "really",
  "more",
  "most",
  "some",
  "such",
  "than",
  "then",
  "only",
  "been",
  "being",
]);

const SENSITIVE_SECRET_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:my\s+|the\s+|new\s+)?(?:password|passcode|passphrase|pin\s*code|atm\s*pin|login\s*pin)\s*(?:is|=|:|as)?\s*\S+/i,
    reason: "Passwords and PINs cannot be stored in memory.",
  },
  {
    pattern: /\b(?:api[_\s-]*key|secret[_\s-]*key|access[_\s-]*token|refresh[_\s-]*token|bearer\s+token|auth[_\s-]*token|private[_\s-]*key|client[_\s-]*secret)\b/i,
    reason: "API keys, auth tokens, and private security credentials cannot be stored.",
  },
  {
    pattern: /\b(?:AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/,
    reason: "Token or API key strings cannot be stored in memory.",
  },
  {
    pattern: /-----BEGIN\s+[A-Z ]*PRIVATE\s+KEY-----/i,
    reason: "Private cryptographic keys cannot be stored in memory.",
  },
  {
    pattern: /\b(?:\d[ -]*?){13,19}\b/,
    reason: "Payment card or sensitive multi-digit account numbers cannot be stored.",
  },
  {
    pattern: /\b(?:cvv|cvc|security\s*code|card\s*number|bank\s*account(?:\s*number)?|routing\s*number|ifsc|ssn|social\s*security(?:\s*number)?|aadhaar|passport\s*number|pan\s*card(?:\s*number)?)\b/i,
    reason: "Sensitive financial or government identification details cannot be stored.",
  },
];

export function containsSensitiveSecret(rawText: string): {
  blocked: boolean;
  reason?: string;
} {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return { blocked: false };
  for (const rule of SENSITIVE_SECRET_PATTERNS) {
    if (rule.pattern.test(text)) {
      return { blocked: true, reason: rule.reason };
    }
  }
  return { blocked: false };
}

export function normalizeMemoryDescription(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_MEMORY_DESCRIPTION_LENGTH) {
    return cleaned;
  }
  return `${cleaned.slice(0, MAX_MEMORY_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

export function isValidMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && VALID_CATEGORIES.has(value);
}

export function coerceMemoryCategory(
  value: unknown,
  fallbackText = ""
): MemoryCategory {
  if (isValidMemoryCategory(value)) return value;
  return inferMemoryCategory(fallbackText);
}

export function inferMemoryCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (
    /\b(prefer|favorite|favourite|like|dislike|love|hate|style|simple english|short(?:er)? explanation|detailed explanation|format|tone)\b/.test(
      lower
    )
  ) {
    return "Preferences";
  }
  if (
    /\b(working on|building|developing|project|learning|studying|course|goal|plan|deadline|currently|startup|app|yunerth)\b/.test(
      lower
    )
  ) {
    return "Active";
  }
  if (
    /\b(my name is|i am called|born|birthday|age|software engineer|student|developer|designer|live in|based in|from)\b/.test(
      lower
    )
  ) {
    return "Identity";
  }
  if (
    /\b(wife|husband|partner|friend|brother|sister|mom|mother|dad|father|daughter|son|colleague|team|mentor|family)\b/.test(
      lower
    )
  ) {
    return "Relationships";
  }
  if (
    /\b(graduated|launched|completed|won|promoted|milestone|achieved|certified|first time|finished)\b/.test(
      lower
    )
  ) {
    return "Milestones";
  }
  if (
    /\b(every morning|every day|habit|routine|always|usually|tend to|practice|workout|meditate|journal)\b/.test(
      lower
    )
  ) {
    return "Behaviors";
  }
  return "Life";
}

export function extractMemoryKeywords(
  text: string,
  maxItems = MAX_MEMORY_KEYWORDS
): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9\u00C0-\u024F\u0900-\u097F_-]+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        (t.length >= 2 || /^\d+$/.test(t)) &&
        t.length <= 48 &&
        !STOPWORDS.has(t)
    );
  const unique: string[] = [];
  for (const token of tokens) {
    if (!unique.includes(token)) {
      unique.push(token);
      if (unique.length >= maxItems) break;
    }
  }
  return unique;
}

export function buildMemoryId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `mem_${Date.now().toString(36)}_${rand}`;
}

export function sanitizeMemoryId(rawId: unknown): string | null {
  if (typeof rawId !== "string") return null;
  const trimmed = rawId.trim();
  if (
    trimmed.length >= 1 &&
    trimmed.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(trimmed)
  ) {
    return trimmed;
  }
  return null;
}

export function sanitizeMemoryRecords(input: unknown): MemoryRecord[] {
  if (!Array.isArray(input)) return [];
  const clean: MemoryRecord[] = [];
  const seenIds = new Set<string>();

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<MemoryRecord>;
    const id = sanitizeMemoryId(raw.id);
    const ownerId =
      typeof raw.ownerId === "string" && raw.ownerId.trim()
        ? raw.ownerId.trim().slice(0, 128)
        : "local";
    const description =
      typeof raw.description === "string"
        ? normalizeMemoryDescription(raw.description)
        : "";
    if (
      !id ||
      seenIds.has(id) ||
      description.length < MIN_MEMORY_DESCRIPTION_LENGTH
    ) {
      continue;
    }
    if (containsSensitiveSecret(description).blocked) {
      continue;
    }
    const category: MemoryCategory = isValidMemoryCategory(raw.category)
      ? raw.category
      : inferMemoryCategory(description);
    const source: MemorySource =
      typeof raw.source === "string" && VALID_SOURCES.has(raw.source)
        ? (raw.source as MemorySource)
        : "Manual";
    const importance: MemoryImportance =
      typeof raw.importance === "string" && VALID_IMPORTANCE.has(raw.importance)
        ? (raw.importance as MemoryImportance)
        : "standard";
    const confirmationStatus: MemoryConfirmationStatus =
      typeof raw.confirmationStatus === "string" &&
      VALID_CONFIRMATION_STATUS.has(raw.confirmationStatus)
        ? (raw.confirmationStatus as MemoryConfirmationStatus)
        : source === "Manual"
          ? "manual"
          : source === "Voice"
            ? "voice"
            : "auto_saved";
    const keywords = Array.isArray(raw.keywords)
      ? raw.keywords
          .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
          .map((k) => k.trim().toLowerCase().slice(0, 48))
          .slice(0, MAX_MEMORY_KEYWORDS)
      : extractMemoryKeywords(description);
    const createdAt =
      typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
        ? raw.createdAt
        : Date.now();
    const updatedAt =
      typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : createdAt;

    seenIds.add(id);
    clean.push({
      id,
      ownerId,
      description,
      category,
      source,
      importance,
      confirmationStatus,
      keywords,
      createdAt,
      updatedAt,
    });
  }

  return clean.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface DuplicateMatchAssessment {
  kind: "none" | "exact_duplicate" | "update_or_conflict";
  matchedMemory?: MemoryRecord;
  similarity: number;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/^(?:the user|user|i)\s+(?:is|am|prefers?|likes?|loves?|has|have|works? on)\s+/i, "")
    .replace(/[^a-z0-9\u00C0-\u024F\u0900-\u097F\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeTokenJaccard(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let intersection = 0;
  for (const t of aSet) {
    if (bSet.has(t)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union > 0 ? intersection / union : 0;
}

export function assessDuplicateOrConflict(
  candidateDescription: string,
  candidateCategory: MemoryCategory,
  existingMemories: MemoryRecord[],
  ignoreMemoryId?: string
): DuplicateMatchAssessment {
  const cleanCandidate = normalizeMemoryDescription(candidateDescription);
  const normCandidate = normalizeForComparison(cleanCandidate);
  const candidateTokens = extractMemoryKeywords(cleanCandidate, 24);

  let bestConflict: { memory: MemoryRecord; similarity: number } | null = null;

  for (const existing of existingMemories) {
    if (ignoreMemoryId && existing.id === ignoreMemoryId) continue;

    const normExisting = normalizeForComparison(existing.description);
    if (!normExisting) continue;

    if (normCandidate === normExisting) {
      return {
        kind: "exact_duplicate",
        matchedMemory: existing,
        similarity: 1,
      };
    }

    const existingTokens = extractMemoryKeywords(existing.description, 24);
    const jaccard = computeTokenJaccard(candidateTokens, existingTokens);

    const sameCategory = existing.category === candidateCategory;
    const candidateDigits = candidateTokens.filter((t) => /^\d+$/.test(t)).join(",");
    const existingDigits = existingTokens.filter((t) => /^\d+$/.test(t)).join(",");
    const hasNumericMismatch = candidateDigits !== existingDigits;

    if (
      !hasNumericMismatch &&
      (jaccard >= 0.72 ||
        (sameCategory &&
          (normCandidate.includes(normExisting) || normExisting.includes(normCandidate)) &&
          Math.min(normCandidate.length, normExisting.length) >= 12))
    ) {
      return {
        kind: "exact_duplicate",
        matchedMemory: existing,
        similarity: jaccard,
      };
    }

    const minSharedThreshold = sameCategory ? 0.34 : 0.48;
    if (jaccard >= minSharedThreshold) {
      if (!bestConflict || jaccard > bestConflict.similarity) {
        bestConflict = { memory: existing, similarity: jaccard };
      }
    }
  }

  if (bestConflict) {
    return {
      kind: "update_or_conflict",
      matchedMemory: bestConflict.memory,
      similarity: bestConflict.similarity,
    };
  }

  return { kind: "none", similarity: 0 };
}

export function retrieveRelevantMemories(
  memories: MemoryRecord[],
  queryContext: string,
  maxResults = 8
): MemoryRecord[] {
  if (memories.length === 0) return [];
  const limit = Math.max(1, Math.min(12, maxResults));
  const queryTokens = new Set(extractMemoryKeywords(queryContext, 24));
  const now = Date.now();

  const scored = memories.map((memory) => {
    const memoryTokens =
      memory.keywords.length > 0
        ? memory.keywords
        : extractMemoryKeywords(memory.description, 16);

    let overlapScore = 0;
    for (const token of memoryTokens) {
      if (queryTokens.has(token)) {
        overlapScore += 4;
      }
    }

    // Check category cues from query text
    const lowerQuery = queryContext.toLowerCase();
    let categoryBonus = 0;
    if (
      memory.category === "Preferences" &&
      /\b(explain|explanation|english|style|prefer|favorite|favourite|short|simple|detail|like)\b/.test(
        lowerQuery
      )
    ) {
      categoryBonus += 3.2;
    } else if (
      memory.category === "Active" &&
      /\b(project|working|work|building|learning|plan|yunerth|goal|study|task)\b/.test(
        lowerQuery
      )
    ) {
      categoryBonus += 3.2;
    } else if (
      memory.category === "Identity" &&
      /\b(who am i|my name|where do i|live|job|work as)\b/.test(lowerQuery)
    ) {
      categoryBonus += 3.2;
    } else if (
      memory.category === "Relationships" &&
      /\b(family|friend|wife|husband|partner|brother|sister|mom|dad|team)\b/.test(
        lowerQuery
      )
    ) {
      categoryBonus += 3.0;
    }

    // Small baseline affinity so core Preferences & Active items inform greetings/tone naturally without dumping everything
    const baselineBonus =
      (memory.category === "Preferences" || memory.category === "Active"
        ? 1.1
        : 0.3) + (memory.importance === "important" ? 0.8 : 0);

    const ageDays = Math.max(0, (now - memory.updatedAt) / 86400000);
    const recencyBonus = Math.max(0, 0.7 - ageDays * 0.02);

    const score = overlapScore + categoryBonus + baselineBonus + recencyBonus;
    return {
      memory,
      score,
      hasDirectMatch: overlapScore > 0 || categoryBonus > 0,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  if (queryTokens.size === 0) {
    // Session start without specific query: surface up to 10 compact core memories so common personal questions answer immediately without tool-call stalls
    const bootLimit = Math.min(10, Math.max(limit, 8));
    return scored
      .filter(
        (entry) =>
          memories.length <= 16 ||
          entry.memory.category === "Preferences" ||
          entry.memory.category === "Active" ||
          entry.memory.category === "Identity" ||
          entry.memory.importance === "important"
      )
      .slice(0, bootLimit)
      .map((entry) => entry.memory);
  }

  const directMatches = scored
    .filter((entry) => entry.hasDirectMatch)
    .slice(0, limit);
  const selected = new Set(directMatches.map((entry) => entry.memory));

  // Add up to 2 baseline Preferences/Active memories only if slots remain
  let baselineAdded = 0;
  for (const entry of scored) {
    if (selected.size >= limit || baselineAdded >= 2) break;
    if (
      !selected.has(entry.memory) &&
      (entry.memory.category === "Preferences" ||
        entry.memory.category === "Active")
    ) {
      selected.add(entry.memory);
      baselineAdded += 1;
    }
  }

  return Array.from(selected).slice(0, limit);
}

export function buildRetrievedMemoriesBlock(memories: MemoryRecord[]): string {
  if (memories.length === 0) return "";

  const lines = [
    "[STAGE 7 LONG-TERM USER MEMORY — NATURAL CONVERSATIONAL CONTEXT — APPLY SILENTLY]",
    "- Use these verified facts naturally as personal context you already know (such as style preferences, favorite things, or ongoing projects).",
    "- When the user asks about one of these remembered details (e.g., 'What is my favorite color?'), answer warmly and naturally—and when it fits the moment, offer ONE brief, genuine follow-up remark or relevant question instead of stopping abruptly in dead silence.",
    "- Never sound robotic or say phrases like 'According to my memory database', 'I checked Memory Core', or announce memory IDs.",
    "- Never invent or claim remembered facts that are not listed below or stated in the active conversation.",
  ];

  for (const memory of memories) {
    const importanceTag = memory.importance === "important" ? " [important]" : "";
    lines.push(
      `- (${memory.category}${importanceTag}): ${memory.description} [ref:${memory.id}]`
    );
  }

  return lines.join("\n");
}

export type FirestoreFailureKind =
  | "transient_offline"
  | "auth_expired"
  | "permission_denied"
  | "quota_exceeded"
  | "unknown";

export interface ClassifiedFirestoreFailure {
  kind: FirestoreFailureKind;
  retryable: boolean;
  userMessage: string;
}

export function classifyFirestoreFailure(
  error: unknown,
  isNavigatorOnline = true
): ClassifiedFirestoreFailure {
  const raw =
    error instanceof Error
      ? `${(error as { code?: string }).code ?? ""} ${error.message}`
      : String(error);
  const lower = raw.toLowerCase();

  if (
    lower.includes("unauthenticated") ||
    lower.includes("auth/user-token-expired") ||
    lower.includes("auth/id-token-expired") ||
    lower.includes("auth/requires-recent-login") ||
    lower.includes("auth/invalid-user-token") ||
    lower.includes("token expired")
  ) {
    return {
      kind: "auth_expired",
      retryable: false,
      userMessage:
        "Your Google session expired. Sign in again in Memory Core to resume cloud sync.",
    };
  }

  if (
    lower.includes("permission-denied") ||
    lower.includes("permission_denied") ||
    lower.includes("missing or insufficient permissions")
  ) {
    return {
      kind: "permission_denied",
      retryable: false,
      userMessage:
        "Cloud storage permission denied. Check your signed-in account and Firestore rules.",
    };
  }

  if (
    lower.includes("resource-exhausted") ||
    lower.includes("quota exceeded")
  ) {
    return {
      kind: "quota_exceeded",
      retryable: false,
      userMessage:
        "Cloud storage daily quota reached. Changes remain safely cached locally.",
    };
  }

  if (
    !isNavigatorOnline ||
    lower.includes("offline") ||
    lower.includes("unavailable") ||
    lower.includes("deadline-exceeded") ||
    lower.includes("timeout") ||
    lower.includes("network") ||
    lower.includes("failed to get document because the client is offline")
  ) {
    return {
      kind: "transient_offline",
      retryable: true,
      userMessage:
        "Offline or unstable network. Memories are saved locally and will retry automatically.",
    };
  }

  return {
    kind: "unknown",
    retryable: true,
    userMessage:
      error instanceof Error && error.message
        ? error.message
        : "Temporary cloud sync error.",
  };
}

export function searchMemoriesLocally(
  memories: MemoryRecord[],
  query: string,
  categoryFilter: "All Memories" | MemoryCategory = "All Memories"
): MemoryRecord[] {
  const cleanQuery = query.trim().toLowerCase();
  const queryTokens = extractMemoryKeywords(cleanQuery, 12);

  return memories.filter((memory) => {
    if (categoryFilter !== "All Memories" && memory.category !== categoryFilter) {
      return false;
    }
    if (!cleanQuery) return true;

    const hay = `${memory.description} ${memory.category} ${memory.source} ${memory.keywords.join(" ")}`.toLowerCase();
    if (hay.includes(cleanQuery)) return true;

    if (queryTokens.length > 0) {
      return queryTokens.some((tok) => hay.includes(tok));
    }
    return false;
  });
}
