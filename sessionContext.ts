import type { SessionContextSummary, VoiceSpeedMode } from "./src/voice/types.ts";

const MAX_TOPIC_HISTORY = 5;
const MAX_KEY_DETAILS = 8;
const MAX_PENDING_ITEMS = 4;
const MAX_RECENT_TURNS = 6;

const BACK_REFERENCE_PATTERN =
  /\b(that topic|earlier topic|previous topic|previous question|earlier question|what (?:i|we) (?:said|discussed|talked about|mentioned) earlier|going back to|back to what we|you mentioned earlier|that thing we|remind me what)\b/i;

const EXPLICIT_TOPIC_SHIFT_PATTERN =
  /^(?:anyway|by the way|btw|on another note|switching topics?|new topic|different question|unrelated(?: question)?|changing the subject)\b/i;

const META_OR_ACKNOWLEDGEMENT_PATTERN =
  /^(?:ok(?:ay)?|got it|thanks?|thank you|cool|nice|great|sure|yeah|yes|no|nope|hmm+|uh huh|alright|sounds good|go ahead|continue|please continue)[.!?\s]*$/i;

const SLOW_VOICE_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:speak|talk|go|read|sound|reply|answer|explain|say(?:\s+(?:it|this|that))?|summarize|describe)(?:\s+(?:to\s+me|this|it|that))?(?:\s+(?:a\s+(?:little|bit)|slightly|much|even|more))*\s+(?:slower|slowly|slow)\b/i,
  /\bslow\s+(?:down(?:\s+(?:a\s+(?:little|bit)|please|your\s+(?:voice|speech|pace|speaking)))?|your\s+(?:voice|speech|pace|speaking)|the\s+(?:voice|speech|pace|speed))\b/i,
  /\b(?:use|switch\s+to|turn\s+on|change\s+to|set(?:\s+(?:the|your))?\s*(?:voice|speech|speaking)?(?:\s*(?:mode|speed|pace))?\s+to)\s+(?:a\s+)?slow(?:er)?\s*(?:voice|speaking|speech|mode|speed|pace)?\b/i,
  /\btake\s+(?:it|things)\s+(?:a\s+(?:little|bit)\s+)?slow(?:er)?\b/i,
  /\bslower\s+(?:voice|speech|pace|speed|mode)\b/i,
];

const FAST_VOICE_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:speak|talk|go|read|sound|reply|answer|explain|say(?:\s+(?:it|this|that))?|summarize|describe)(?:\s+(?:to\s+me|this|it|that))?(?:\s+(?:a\s+(?:little|bit)|slightly|much|even|more))*\s+(?:faster|fast|quicker|quickly)\b/i,
  /\b(?:speed\s+up(?:\s+(?:a\s+(?:little|bit)|please|your\s+(?:voice|speech|pace|speaking)))?|pick\s+up\s+the\s+pace)\b/i,
  /\b(?:use|switch\s+to|turn\s+on|change\s+to|set(?:\s+(?:the|your))?\s*(?:voice|speech|speaking)?(?:\s*(?:mode|speed|pace))?\s+to)\s+(?:a\s+)?fast(?:er)?\s*(?:voice|speaking|speech|mode|speed|pace)?\b/i,
  /\bfaster\s+(?:voice|speech|pace|speed|mode)\b/i,
];

const NORMAL_VOICE_COMMAND_PATTERNS: RegExp[] = [
  /\b(?:back\s+to\s+normal(?:\s+(?:voice|speech|pace|speed|mode))?|return\s+to\s+(?:your\s+)?normal(?:\s+(?:voice|speaking|speech))?(?:\s*(?:speed|pace|mode))?|speak\s+normally|talk\s+normally)\b/i,
  /\b(?:use|switch\s+to|change\s+to|set(?:\s+(?:the|your))?\s*(?:voice|speech|speaking)?(?:\s*(?:mode|speed|pace))?\s+to)\s+(?:your\s+)?(?:normal|regular|default)\s+(?:voice|speaking|speech)?\s*(?:speed|pace|mode)?\b/i,
  /\b(?:stop|quit)\s+(?:speaking|talking|going)\s+(?:so\s+|too\s+)?(?:fast|quickly|slow(?:ly)?)\b/i,
  /\b(?:don'?t|do\s+not)\s+(?:speak|talk)\s+(?:so\s+|too\s+)?(?:fast|quickly|slow(?:ly)?)\b/i,
  /\b(?:reset|restore)\s+(?:your\s+)?(?:speaking\s+|voice\s+)?(?:speed|pace|mode)\b/i,
];

const SPEED_INFORMATION_QUESTION_PATTERN =
  /^(?:what(?:'s|\s+is|\s+are)|which|how\s+(?:fast|slow(?:ly)?|quick(?:ly)?)|why(?:\s+are|\s+do|\s+is)?|do\s+you\s+have|tell\s+me\s+(?:what|about)|can\s+you\s+tell\s+me\s+(?:what|how|about)|explain\s+(?:what|your)\s+(?:speaking|voice|normal|slow|fast))\b/i;

const EXPLICIT_DIRECTIVE_OVERRIDE_PATTERN =
  /\b(?:use|switch\s+to|return\s+to|back\s+to|set\s+(?:your\s+)?(?:speaking\s+|voice\s+)?(?:mode|speed|pace)\s+to|stop\s+(?:speaking|talking)\s+so|speak\s+(?:faster|slowly|slower|normally)|slow\s+down|speed\s+up)\b/i;

const CLARIFYING_QUESTION_OUTPUT_PATTERN =
  /\b(which (?:city|one|part|option)|could you (?:say|repeat|clarify)|didn'?t quite catch|do you mean|which would you prefer|what city|tell me the (?:correct )?city)\b/i;

const INCOMPLETE_TRAILING_PATTERN =
  /(?:\.\.\.|…|\b(?:in|for|about|between|with|of|to|on|at|from|versus|vs|and|or|because|the|a|an|my|weather in|time in|forecast in)\s*)$/i;

function compactText(text: string, maxLen = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1).trimEnd()}…`;
}

function stripQuestionScaffolding(text: string): string {
  return text
    .replace(EXPLICIT_TOPIC_SHIFT_PATTERN, "")
    .replace(
      /^(?:hey\s+yunerth|yunerth|please|can you|could you|would you|will you|i want to know|tell me|explain|what is|what are|what's|how does|how do|why does|why do|let's talk about|let's discuss)\s+/gi,
      ""
    )
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isQuestionAboutVoiceSpeed(rawText: string): boolean {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (EXPLICIT_DIRECTIVE_OVERRIDE_PATTERN.test(text)) {
    return false;
  }
  if (SPEED_INFORMATION_QUESTION_PATTERN.test(text)) {
    return /\b(?:speed|pace|rate|mode|fast|slow|slowly|quickly|normal(?:ly)?)\b/i.test(
      text
    );
  }
  return /\bwhat(?:'s|\s+is)\s+(?:your|the)\s+(?:current\s+|normal\s+|slow\s+|fast\s+)?(?:speaking\s+|voice\s+)?(?:speed|pace|rate|mode)\b/i.test(
    text
  );
}

export function detectVoiceSpeedCommand(rawText: string): VoiceSpeedMode | null {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text || isQuestionAboutVoiceSpeed(text)) return null;
  if (NORMAL_VOICE_COMMAND_PATTERNS.some((p) => p.test(text))) {
    return "normal";
  }
  if (SLOW_VOICE_COMMAND_PATTERNS.some((p) => p.test(text))) {
    return "slow";
  }
  if (FAST_VOICE_COMMAND_PATTERNS.some((p) => p.test(text))) {
    return "fast";
  }
  return null;
}

export function isVoiceModeOnlyUtterance(rawText: string): boolean {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return false;
  if (!detectVoiceSpeedCommand(text)) return false;
  let remainder = text;
  for (const pattern of [
    ...NORMAL_VOICE_COMMAND_PATTERNS,
    ...SLOW_VOICE_COMMAND_PATTERNS,
    ...FAST_VOICE_COMMAND_PATTERNS,
  ]) {
    remainder = remainder.replace(pattern, " ");
  }
  remainder = remainder
    .replace(
      /\b(?:hey|yunerth|can you|could you|would you|please|for me|this|that|it|from now on|right now|a little|a bit|just|and)\b/gi,
      " "
    )
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\u0900-\u097F]+/g, "")
    .trim();
  return remainder.length < 3;
}

export type SilentTurnReason = "incomplete_trailing" | "unclear_speech";

export function classifySilentUserTurn(
  rawTranscript: string,
  sawAudioActivity: boolean
): SilentTurnReason | null {
  const text = rawTranscript.replace(/\s+/g, " ").trim();
  if (!text) {
    return sawAudioActivity ? "unclear_speech" : null;
  }
  if (INCOMPLETE_TRAILING_PATTERN.test(text)) {
    return "incomplete_trailing";
  }
  const alphaNumCount = text.replace(/[^a-zA-Z0-9\u00C0-\u024F\u0900-\u097F]/g, "").length;
  if (alphaNumCount < 2) {
    return "unclear_speech";
  }
  return "unclear_speech";
}

export function sanitizeSessionContextSummary(
  input: unknown
): SessionContextSummary | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<SessionContextSummary>;
  const currentTopic =
    typeof candidate.currentTopic === "string" && candidate.currentTopic.trim()
      ? compactText(candidate.currentTopic, 72)
      : null;

  const topicHistory = Array.isArray(candidate.topicHistory)
    ? candidate.topicHistory
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .slice(0, MAX_TOPIC_HISTORY)
        .map((t) => compactText(t, 72))
    : [];

  const keyDetails = Array.isArray(candidate.keyDetails)
    ? candidate.keyDetails
        .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        .slice(0, MAX_KEY_DETAILS)
        .map((d) => compactText(d, 110))
    : [];

  const pendingItems = Array.isArray(candidate.pendingItems)
    ? candidate.pendingItems
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .slice(0, MAX_PENDING_ITEMS)
        .map((p) => compactText(p, 110))
    : [];

  const recentTurns = Array.isArray(candidate.recentTurns)
    ? candidate.recentTurns
        .filter(
          (t): t is { user: string; assistant: string } =>
            Boolean(t) &&
            typeof t === "object" &&
            typeof t.user === "string" &&
            typeof t.assistant === "string"
        )
        .slice(-MAX_RECENT_TURNS)
        .map((t) => ({
          user: compactText(t.user, 150),
          assistant: compactText(t.assistant, 160),
        }))
    : [];

  return {
    currentTopic,
    topicHistory,
    keyDetails,
    pendingItems,
    recentTurns,
    turnCount:
      typeof candidate.turnCount === "number" && Number.isFinite(candidate.turnCount)
        ? Math.max(0, Math.floor(candidate.turnCount))
        : recentTurns.length,
    updatedAt: Date.now(),
  };
}

export class SessionContextTracker {
  private currentTopic: string | null = null;
  private topicHistory: string[] = [];
  private keyDetails: string[] = [];
  private pendingItems: string[] = [];
  private recentTurns: Array<{ user: string; assistant: string }> = [];
  private turnCount = 0;
  private updatedAt = Date.now();

  constructor(initial?: SessionContextSummary | null) {
    if (initial) {
      this.restore(initial);
    }
  }

  restore(summary: SessionContextSummary): void {
    const clean = sanitizeSessionContextSummary(summary);
    if (!clean) return;
    this.currentTopic = clean.currentTopic;
    this.topicHistory = [...clean.topicHistory];
    this.keyDetails = [...clean.keyDetails];
    this.pendingItems = [...clean.pendingItems];
    this.recentTurns = clean.recentTurns.map((t) => ({ ...t }));
    this.turnCount = clean.turnCount;
    this.updatedAt = clean.updatedAt;
  }

  reset(): void {
    this.currentTopic = null;
    this.topicHistory = [];
    this.keyDetails = [];
    this.pendingItems = [];
    this.recentTurns = [];
    this.turnCount = 0;
    this.updatedAt = Date.now();
  }

  recordTurn(params: {
    userText: string;
    assistantText: string;
    now?: number;
  }): SessionContextSummary {
    const now = params.now ?? Date.now();
    const userText = params.userText.replace(/\s+/g, " ").trim();
    const assistantText = params.assistantText.replace(/\s+/g, " ").trim();

    if (!userText && !assistantText) {
      return this.getSummary();
    }

    this.turnCount += 1;
    this.updatedAt = now;

    if (userText) {
      this.updateTopicFromUserText(userText);
      this.extractKeyDetails(userText);
    }

    // Track unresolved questions or clear previously pending items once answered
    if (userText && this.pendingItems.length > 0) {
      const answeredPending =
        !CLARIFYING_QUESTION_OUTPUT_PATTERN.test(assistantText) &&
        !META_OR_ACKNOWLEDGEMENT_PATTERN.test(userText);
      if (answeredPending) {
        this.pendingItems = [];
      }
    }

    if (
      assistantText &&
      assistantText.endsWith("?") &&
      CLARIFYING_QUESTION_OUTPUT_PATTERN.test(assistantText)
    ) {
      const pendingNote = compactText(
        userText
          ? `Clarifying "${compactText(userText, 60)}" -> asked: ${assistantText}`
          : `Waiting for user answer: ${assistantText}`,
        110
      );
      this.pendingItems = [pendingNote, ...this.pendingItems.slice(0, MAX_PENDING_ITEMS - 1)];
    }

    if (userText || assistantText) {
      this.recentTurns.push({
        user: compactText(userText || "(voice turn)", 150),
        assistant: compactText(assistantText || "(spoken reply)", 160),
      });
      if (this.recentTurns.length > MAX_RECENT_TURNS) {
        this.recentTurns.shift();
      }
    }

    return this.getSummary();
  }

  getSummary(): SessionContextSummary {
    return {
      currentTopic: this.currentTopic,
      topicHistory: [...this.topicHistory],
      keyDetails: [...this.keyDetails],
      pendingItems: [...this.pendingItems],
      recentTurns: this.recentTurns.map((t) => ({ ...t })),
      turnCount: this.turnCount,
      updatedAt: this.updatedAt,
    };
  }

  buildContextSummaryBlock(): string {
    if (
      !this.currentTopic &&
      this.keyDetails.length === 0 &&
      this.pendingItems.length === 0 &&
      this.recentTurns.length === 0
    ) {
      return "";
    }

    const lines: string[] = [
      "[STAGE 6 ACTIVE-SESSION WORKING MEMORY — SILENT CONTEXT REFERENCE]",
      "- Preserve exact user meaning, remember prior details within this session, and never mix superseded old values with newer updates.",
    ];

    if (this.currentTopic) {
      lines.push(`- Current topic: ${this.currentTopic}`);
    }
    if (this.topicHistory.length > 0) {
      lines.push(`- Earlier topics in this session: ${this.topicHistory.join(" | ")}`);
    }
    if (this.keyDetails.length > 0) {
      lines.push(`- Key user facts & active constraints: ${this.keyDetails.join(" ; ")}`);
    }
    if (this.pendingItems.length > 0) {
      lines.push(`- Pending clarification / unfinished item: ${this.pendingItems.join(" ; ")}`);
    }
    if (this.recentTurns.length > 0) {
      lines.push("- Condensed recent turns (oldest -> newest):");
      for (const turn of this.recentTurns) {
        lines.push(`  * User: ${turn.user} => You: ${turn.assistant}`);
      }
    }

    return lines.join("\n");
  }

  private updateTopicFromUserText(userText: string): void {
    if (
      META_OR_ACKNOWLEDGEMENT_PATTERN.test(userText) ||
      isVoiceModeOnlyUtterance(userText)
    ) {
      return;
    }

    // Back-reference to an earlier topic: if a matching earlier topic exists in topicHistory, reactivate it
    if (BACK_REFERENCE_PATTERN.test(userText)) {
      const words = new Set(
        userText
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length >= 4)
      );
      const matchedEarlierIndex = this.topicHistory.findIndex((topic) =>
        topic
          .toLowerCase()
          .split(/\W+/)
          .some((w) => w.length >= 4 && words.has(w))
      );
      if (matchedEarlierIndex >= 0) {
        const restored = this.topicHistory[matchedEarlierIndex];
        this.topicHistory.splice(matchedEarlierIndex, 1);
        if (this.currentTopic && this.currentTopic !== restored) {
          this.pushTopicHistory(this.currentTopic);
        }
        this.currentTopic = restored;
      }
      return;
    }

    const hasExplicitShift = EXPLICIT_TOPIC_SHIFT_PATTERN.test(userText);
    const cleaned = stripQuestionScaffolding(userText);
    if (!cleaned || cleaned.length < 4) return;

    const startsAsFollowUp =
      !hasExplicitShift &&
      (/\b(?:that|this|it|they|them|those|these)\b/i.test(userText) ||
        /^(?:and |what about |how about |also |why |how |what if |can you explain more)/i.test(
          userText
        ) ||
        userText.split(/\s+/).length <= 4);

    if (startsAsFollowUp && this.currentTopic) {
      return;
    }

    const candidateTopic = compactText(cleaned, 72);
    if (!this.currentTopic) {
      this.currentTopic = candidateTopic;
      return;
    }

    if (
      hasExplicitShift ||
      this.isDistinctTopic(this.currentTopic, candidateTopic)
    ) {
      this.pushTopicHistory(this.currentTopic);
      this.currentTopic = candidateTopic;
      this.pendingItems = [];
    }
  }

  private pushTopicHistory(topic: string): void {
    const clean = compactText(topic, 72);
    if (!clean) return;
    this.topicHistory = [
      clean,
      ...this.topicHistory.filter(
        (existing) => existing.toLowerCase() !== clean.toLowerCase()
      ),
    ].slice(0, MAX_TOPIC_HISTORY);
  }

  private isDistinctTopic(prevTopic: string, nextTopic: string): boolean {
    const tokenize = (s: string) =>
      new Set(
        s
          .toLowerCase()
          .split(/\W+/)
          .filter(
            (w) =>
              w.length >= 4 &&
              !["what", "when", "where", "which", "would", "could", "should", "about", "there"].includes(
                w
              )
          )
      );
    const prevTokens = tokenize(prevTopic);
    const nextTokens = tokenize(nextTopic);
    if (prevTokens.size === 0 || nextTokens.size === 0) return false;
    for (const token of nextTokens) {
      if (prevTokens.has(token)) return false;
    }
    return true;
  }

  private extractKeyDetails(userText: string): void {
    const upsertPrefixedDetail = (prefix: string, value: string) => {
      const cleanVal = compactText(value, 85);
      if (!cleanVal) return;
      const entry = `${prefix}: ${cleanVal}`;
      this.keyDetails = [
        entry,
        ...this.keyDetails.filter((d) => !d.startsWith(`${prefix}: `)),
      ].slice(0, MAX_KEY_DETAILS);
    };

    const nameMatch = userText.match(/\b(?:my name is|call me|i'?m)\s+([A-Z][a-z]{1,20})\b/);
    if (nameMatch?.[1]) {
      upsertPrefixedDetail("User name", nameMatch[1]);
    }

    const budgetMatch = userText.match(
      /\b(?:around|under|max(?:imum)?|about|budget(?:\s+(?:is|of|to|around|about|at))?)\s+(?:to\s+)?((?:₹|\$|€|£)\s*[\d,]+(?:\s*(?:k|m|dollars|rupees|usd|inr))?|[\d,]+\s*(?:dollars|rupees|usd|inr|euros))/i
    );
    if (budgetMatch?.[1]) {
      upsertPrefixedDetail("Budget constraint", budgetMatch[1]);
    }

    const goalMatch = userText.match(
      /\b(?:i'?m (?:trying to|planning to|learning|preparing for|building|looking for)|i want to|i need to|my goal is to)\s+([^.?!]{4,75})/i
    );
    if (goalMatch?.[1]) {
      upsertPrefixedDetail("User goal", goalMatch[1]);
    }

    const prefMatch = userText.match(
      /\b(?:i prefer|please use|speak in|answer in|give me)\s+([^.?!]{4,60})/i
    );
    if (prefMatch?.[1] && !detectVoiceSpeedCommand(userText)) {
      upsertPrefixedDetail("Preference", prefMatch[1]);
    }

    const userLocationMatch = userText.match(
      /\b(?:living in|based in|located in|shopping (?:in|from)|staying in|moving to|visiting|i'?m in)\s+([A-Z][A-Za-z'-]{1,28}(?:\s+[A-Z][A-Za-z'-]{1,20})?)/
    );
    if (userLocationMatch?.[1]) {
      upsertPrefixedDetail("User location", userLocationMatch[1].trim());
    }

    const cityMatch = userText.match(
      /\b(?:weather|forecast|temperature|time|clock)\s+(?:in|for|at)\s+([A-Za-z][A-Za-z\s'-]{1,32}?)(?=(?:\s+(?:and|right now|today|tonight|this week|please)\b|[?.!,]|$))/i
    );
    if (cityMatch?.[1]) {
      upsertPrefixedDetail("Latest place asked", cityMatch[1].trim());
    }
  }
}
