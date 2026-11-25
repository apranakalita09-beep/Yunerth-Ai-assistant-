export const MEMORY_CATEGORIES = [
  "Identity",
  "Preferences",
  "Life",
  "Active",
  "Relationships",
  "Milestones",
  "Behaviors",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MemoryCategoryFilter = "All Memories" | MemoryCategory;

export const MEMORY_FILTER_TABS: readonly MemoryCategoryFilter[] = [
  "All Memories",
  ...MEMORY_CATEGORIES,
];

export type MemorySource = "Manual" | "Voice" | "Automatic";

export type MemoryImportance = "standard" | "important";

export type MemoryConfirmationStatus =
  | "manual"
  | "voice"
  | "auto_saved"
  | "user_approved";

export interface MemoryRecord {
  id: string;
  ownerId: string;
  description: string;
  category: MemoryCategory;
  source: MemorySource;
  importance: MemoryImportance;
  confirmationStatus: MemoryConfirmationStatus;
  keywords: string[];
  createdAt: number;
  updatedAt: number;
}

export type MemorySyncStatus =
  | "loading"
  | "synced"
  | "syncing"
  | "offline"
  | "unauthenticated"
  | "auth_expired"
  | "error";

export interface PendingImportantMemoryApproval {
  candidateId: string;
  description: string;
  category: MemoryCategory;
  reason: string;
  existingMatchId?: string;
  existingMatchDescription?: string;
  createdAt: number;
}

export interface MemoryAutoSaveNotice {
  id: string;
  memoryId: string;
  description: string;
  category: MemoryCategory;
  action: "created" | "updated";
  createdAt: number;
}

export interface AnalyzedMemoryCandidate {
  level: "level1_auto" | "level2_important";
  description: string;
  category: MemoryCategory;
  reason: string;
  updatesExistingId?: string;
}

export type MemoryToolAction =
  | "save_memory"
  | "update_memory"
  | "search_memories"
  | "resolve_pending_memory_approval";

export interface MemoryToolRelayRequest {
  requestId: string;
  action: MemoryToolAction;
  args: Record<string, unknown>;
}

export interface MemoryToolRelayResponse {
  requestId: string;
  result: Record<string, unknown>;
}

export interface MemoryStageTelemetry {
  detectionMs?: number;
  classificationMs?: number;
  permissionDispatchMs?: number;
  firestoreWriteMs?: number;
  totalSyncMs?: number;
  outcome?: string;
}
