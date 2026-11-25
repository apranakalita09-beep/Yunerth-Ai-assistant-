import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db, googleProvider, testFirestoreConnection } from "../firebase";
import { buildFirestoreErrorInfo, OperationType } from "./firestoreErrors";
import {
  MIN_MEMORY_DESCRIPTION_LENGTH,
  assessDuplicateOrConflict,
  buildMemoryId,
  buildRetrievedMemoriesBlock,
  classifyFirestoreFailure,
  coerceMemoryCategory,
  containsSensitiveSecret,
  extractMemoryKeywords,
  normalizeMemoryDescription,
  retrieveRelevantMemories,
  sanitizeMemoryRecords,
} from "../../memoryCore";
import type {
  AnalyzedMemoryCandidate,
  MemoryCategory,
  MemoryConfirmationStatus,
  MemoryImportance,
  MemoryRecord,
  MemorySource,
  MemorySyncStatus,
  MemoryToolRelayRequest,
  PendingImportantMemoryApproval,
  MemoryAutoSaveNotice,
} from "./types";

const CACHE_KEY_PREFIX = "yunerth.memory.cache.v1:";
const PENDING_QUEUE_KEY_PREFIX = "yunerth.memory.pending.v1:";
const MAX_SYNC_RETRY_ATTEMPTS = 3;

interface PendingMemoryMutation {
  op: "upsert" | "delete";
  memoryId: string;
  record?: MemoryRecord;
  queuedAt: number;
  attempts?: number;
  lastError?: string;
}

export interface MemoryMutationResult {
  ok: boolean;
  duplicate?: boolean;
  conflict?: boolean;
  cloudSynced?: boolean;
  requiresSignIn?: boolean;
  memory?: MemoryRecord;
  matchedMemory?: MemoryRecord;
  error?: string;
}

interface MemoryContextValue {
  user: User | null;
  authReady: boolean;
  memories: MemoryRecord[];
  syncStatus: MemorySyncStatus;
  syncError: string | null;
  pendingSyncCount: number;
  isDrawerOpen: boolean;
  editingMemoryId: string | null;
  pendingApproval: PendingImportantMemoryApproval | null;
  autoSaveNotice: MemoryAutoSaveNotice | null;
  declinedDescriptions: string[];
  openDrawer: (editId?: string) => void;
  closeDrawer: () => void;
  startEditingMemory: (id: string | null) => void;
  signInWithGoogle: () => Promise<void>;
  signOutUser: () => Promise<void>;
  retrySync: () => Promise<void>;
  addManualMemory: (input: {
    description: string;
    category: MemoryCategory;
    replaceExistingId?: string;
  }) => Promise<MemoryMutationResult>;
  editMemory: (input: {
    id: string;
    description: string;
    category: MemoryCategory;
  }) => Promise<MemoryMutationResult>;
  deleteMemory: (id: string) => Promise<MemoryMutationResult>;
  handleVoiceToolAction: (
    request: MemoryToolRelayRequest
  ) => Promise<Record<string, unknown>>;
  handleAsyncAutoSaveCandidate: (
    candidate: AnalyzedMemoryCandidate
  ) => Promise<void>;
  handleAsyncApprovalCandidate: (candidate: AnalyzedMemoryCandidate) => void;
  approvePendingMemory: () => Promise<MemoryMutationResult>;
  declinePendingMemory: () => string | null;
  dismissAutoSaveNotice: () => void;
  getRelevantMemoriesPayload: (queryText?: string) => {
    memories: MemoryRecord[];
    retrievedBlock: string;
  };
}

const MemoryContext = createContext<MemoryContextValue | null>(null);

function getCacheKey(uid: string | null): string {
  return `${CACHE_KEY_PREFIX}${uid || "guest"}`;
}

function getPendingKey(uid: string | null): string {
  return `${PENDING_QUEUE_KEY_PREFIX}${uid || "guest"}`;
}

function readCachedMemories(uid: string | null): MemoryRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getCacheKey(uid));
    if (!raw) return [];
    return sanitizeMemoryRecords(JSON.parse(raw));
  } catch {
    return [];
  }
}

function writeCachedMemories(
  uid: string | null,
  memories: MemoryRecord[]
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      getCacheKey(uid),
      JSON.stringify(memories.slice(0, 500))
    );
  } catch {
    // Ignore storage quota errors
  }
}

function readPendingQueue(uid: string | null): PendingMemoryMutation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getPendingKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePendingQueue(
  uid: string | null,
  queue: PendingMemoryMutation[]
): void {
  if (typeof window === "undefined") return;
  try {
    if (queue.length === 0) {
      window.localStorage.removeItem(getPendingKey(uid));
    } else {
      window.localStorage.setItem(getPendingKey(uid), JSON.stringify(queue));
    }
  } catch {
    // Ignore storage quota errors
  }
}

function toMillis(value: unknown, fallback: number): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof (value as { toMillis?: unknown }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

export function MemoryProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [memories, setMemories] = useState<MemoryRecord[]>(() =>
    readCachedMemories(null)
  );
  const [syncStatus, setSyncStatus] = useState<MemorySyncStatus>("loading");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(
    () => readPendingQueue(null).length
  );
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] =
    useState<PendingImportantMemoryApproval | null>(null);
  const [autoSaveNotice, setAutoSaveNotice] =
    useState<MemoryAutoSaveNotice | null>(null);
  const [declinedDescriptions, setDeclinedDescriptions] = useState<string[]>(
    []
  );

  const userRef = useRef<User | null>(null);
  const memoriesRef = useRef<MemoryRecord[]>(memories);
  const pendingApprovalRef = useRef<PendingImportantMemoryApproval | null>(
    pendingApproval
  );
  const userRootEnsuredForUidRef = useRef<string | null>(null);
  const flushingQueueRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const autoToastTimerRef = useRef<number | null>(null);

  memoriesRef.current = memories;
  pendingApprovalRef.current = pendingApproval;

  const clearScheduledRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const showAutoSaveNotice = useCallback(
    (notice: Omit<MemoryAutoSaveNotice, "id" | "createdAt">) => {
      if (autoToastTimerRef.current !== null) {
        window.clearTimeout(autoToastTimerRef.current);
      }
      setAutoSaveNotice({
        ...notice,
        id: `notice_${Date.now().toString(36)}`,
        createdAt: Date.now(),
      });
      autoToastTimerRef.current = window.setTimeout(() => {
        autoToastTimerRef.current = null;
        setAutoSaveNotice(null);
      }, 6500);
    },
    []
  );

  const dismissAutoSaveNotice = useCallback(() => {
    if (autoToastTimerRef.current !== null) {
      window.clearTimeout(autoToastTimerRef.current);
      autoToastTimerRef.current = null;
    }
    setAutoSaveNotice(null);
  }, []);

  const ensureUserRootDocument = useCallback(
    async (activeUser: User): Promise<void> => {
      if (userRootEnsuredForUidRef.current === activeUser.uid) {
        return;
      }
      const userDocPath = `users/${activeUser.uid}`;
      const ref = doc(db, "users", activeUser.uid);
      const safeDisplayName = activeUser.displayName?.trim().slice(0, 80);

      try {
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          await setDoc(ref, {
            uid: activeUser.uid,
            ...(safeDisplayName ? { displayName: safeDisplayName } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          const existingName = snap.data()?.displayName;
          if (safeDisplayName && safeDisplayName !== existingName) {
            await updateDoc(ref, {
              displayName: safeDisplayName,
              updatedAt: serverTimestamp(),
            });
          }
        }
        userRootEnsuredForUidRef.current = activeUser.uid;
      } catch (err) {
        const errInfo = buildFirestoreErrorInfo(
          err,
          OperationType.WRITE,
          userDocPath
        );
        console.error("Firestore Error: ", JSON.stringify(errInfo));
        throw err;
      }
    },
    []
  );

  const writeMemoryToFirestore = useCallback(
    async (
      activeUser: User,
      record: MemoryRecord,
      isUpdate: boolean
    ): Promise<number> => {
      const startedAt = performance.now();
      await ensureUserRootDocument(activeUser);
      const memPath = `users/${activeUser.uid}/memories/${record.id}`;
      const memRef = doc(db, "users", activeUser.uid, "memories", record.id);
      const keywords = extractMemoryKeywords(record.description).slice(0, 16);

      try {
        if (isUpdate) {
          await updateDoc(memRef, {
            description: record.description,
            category: record.category,
            source: record.source,
            importance: record.importance,
            confirmationStatus: record.confirmationStatus,
            keywords,
            updatedAt: serverTimestamp(),
          });
        } else {
          await setDoc(memRef, {
            id: record.id,
            ownerId: activeUser.uid,
            description: record.description,
            category: record.category,
            source: record.source,
            importance: record.importance,
            confirmationStatus: record.confirmationStatus,
            keywords,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        const firestoreWriteMs = Math.round(performance.now() - startedAt);
        console.log(
          `[MemoryTelemetry] stage=firestore_write op=${isUpdate ? "update" : "create"} firestoreWriteMs=${firestoreWriteMs}`
        );
        return firestoreWriteMs;
      } catch (err) {
        const errInfo = buildFirestoreErrorInfo(
          err,
          isUpdate ? OperationType.UPDATE : OperationType.CREATE,
          memPath
        );
        console.error("Firestore Error: ", JSON.stringify(errInfo));
        throw err;
      }
    },
    [ensureUserRootDocument]
  );

  const deleteMemoryFromFirestore = useCallback(
    async (activeUser: User, memoryId: string): Promise<void> => {
      const memPath = `users/${activeUser.uid}/memories/${memoryId}`;
      const memRef = doc(db, "users", activeUser.uid, "memories", memoryId);
      try {
        await deleteDoc(memRef);
      } catch (err) {
        const errInfo = buildFirestoreErrorInfo(
          err,
          OperationType.DELETE,
          memPath
        );
        console.error("Firestore Error: ", JSON.stringify(errInfo));
        throw err;
      }
    },
    []
  );

  const enqueueMutation = useCallback(
    (uid: string | null, mutation: PendingMemoryMutation) => {
      const currentQueue = readPendingQueue(uid).filter(
        (item) => item.memoryId !== mutation.memoryId
      );
      currentQueue.push(mutation);
      writePendingQueue(uid, currentQueue);
      setPendingSyncCount(currentQueue.length);
    },
    []
  );

  const flushPendingQueueRef = useRef<
    (activeUser: User) => Promise<boolean>
  >(async () => false);

  const flushPendingQueue = useCallback(
    async (activeUser: User): Promise<boolean> => {
      clearScheduledRetry();
      if (flushingQueueRef.current) return false;
      const isOnline =
        typeof navigator === "undefined" ? true : navigator.onLine;
      if (!isOnline) {
        setSyncStatus("offline");
        return false;
      }

      const guestPending = readPendingQueue(null);
      const userPending = readPendingQueue(activeUser.uid);
      const mergedMap = new Map<string, PendingMemoryMutation>();
      for (const item of [...guestPending, ...userPending]) {
        const migratedRecord = item.record
          ? { ...item.record, ownerId: activeUser.uid }
          : undefined;
        mergedMap.set(item.memoryId, { ...item, record: migratedRecord });
      }

      const combined = Array.from(mergedMap.values()).sort(
        (a, b) => a.queuedAt - b.queuedAt
      );
      if (combined.length === 0) {
        setPendingSyncCount(0);
        return true;
      }

      const runnable = combined.filter(
        (item) => (item.attempts ?? 0) < MAX_SYNC_RETRY_ATTEMPTS
      );
      const alreadyExhausted = combined.filter(
        (item) => (item.attempts ?? 0) >= MAX_SYNC_RETRY_ATTEMPTS
      );

      if (runnable.length === 0) {
        setPendingSyncCount(alreadyExhausted.length);
        return false;
      }

      flushingQueueRef.current = true;
      setSyncStatus("syncing");
      const remaining: PendingMemoryMutation[] = [...alreadyExhausted];
      let haltNonRetryable: ReturnType<typeof classifyFirestoreFailure> | null =
        null;
      let highestRetryableAttempts = 0;

      try {
        for (let idx = 0; idx < runnable.length; idx += 1) {
          const item = runnable[idx];
          if (haltNonRetryable) {
            remaining.push(item);
            continue;
          }
          try {
            if (item.op === "delete") {
              await deleteMemoryFromFirestore(activeUser, item.memoryId);
            } else if (item.record) {
              const existingSnap = await getDoc(
                doc(db, "users", activeUser.uid, "memories", item.memoryId)
              );
              await writeMemoryToFirestore(
                activeUser,
                item.record,
                existingSnap.exists()
              );
            }
          } catch (err) {
            const classified = classifyFirestoreFailure(
              err,
              typeof navigator === "undefined" ? true : navigator.onLine
            );
            if (!classified.retryable) {
              haltNonRetryable = classified;
              remaining.push({
                ...item,
                attempts: MAX_SYNC_RETRY_ATTEMPTS,
                lastError: classified.userMessage,
              });
              setSyncError(classified.userMessage);
              setSyncStatus(
                classified.kind === "auth_expired" ? "auth_expired" : "error"
              );
            } else {
              const nextAttempts = (item.attempts ?? 0) + 1;
              highestRetryableAttempts = Math.max(
                highestRetryableAttempts,
                nextAttempts
              );
              remaining.push({
                ...item,
                attempts: nextAttempts,
                lastError: classified.userMessage,
              });
              setSyncError(
                nextAttempts >= MAX_SYNC_RETRY_ATTEMPTS
                  ? "Cloud sync paused after 3 failed attempts. Tap Retry Sync when ready."
                  : classified.userMessage
              );
              setSyncStatus(
                classified.kind === "transient_offline" ? "offline" : "error"
              );
            }
          }
        }
      } finally {
        flushingQueueRef.current = false;
      }

      // Clear guest pending & guest cache once migrated to signed-in account
      if (guestPending.length > 0 && remaining.length === 0) {
        writePendingQueue(null, []);
        writeCachedMemories(null, []);
      } else {
        writePendingQueue(null, []);
      }
      writePendingQueue(activeUser.uid, remaining);
      setPendingSyncCount(remaining.length);

      if (remaining.length === 0) {
        setSyncError(null);
        setSyncStatus("synced");
        return true;
      }

      if (
        !haltNonRetryable &&
        highestRetryableAttempts > 0 &&
        highestRetryableAttempts < MAX_SYNC_RETRY_ATTEMPTS &&
        (typeof navigator === "undefined" || navigator.onLine)
      ) {
        const backoffMs = 2000 * Math.pow(2, highestRetryableAttempts - 1);
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          const current = userRef.current;
          if (current) {
            void flushPendingQueueRef.current(current);
          }
        }, backoffMs);
      }

      return false;
    },
    [clearScheduledRetry, deleteMemoryFromFirestore, writeMemoryToFirestore]
  );

  flushPendingQueueRef.current = flushPendingQueue;

  // Boot Firestore reachability check
  useEffect(() => {
    void testFirestoreConnection();
  }, []);

  // Auth & Firestore realtime snapshot subscription
  useEffect(() => {
    let unsubscribeSnapshot: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (nextUser) => {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }
      userRef.current = nextUser;
      setUser(nextUser);
      setAuthReady(true);
      userRootEnsuredForUidRef.current = null;

      if (!nextUser) {
        clearScheduledRetry();
        const guestMemories = readCachedMemories(null);
        setMemories(guestMemories);
        setPendingSyncCount(readPendingQueue(null).length);
        setSyncError(null);
        setSyncStatus("unauthenticated");
        return;
      }

      // Signed-in user: load scoped local cache first, then stream live Firestore updates
      const scopedCache = readCachedMemories(nextUser.uid);
      const guestCache = readCachedMemories(null);
      if (scopedCache.length > 0) {
        setMemories(scopedCache);
      } else if (guestCache.length > 0) {
        setMemories(
          guestCache.map((m) => ({ ...m, ownerId: nextUser.uid }))
        );
      } else {
        setMemories([]);
      }

      setSyncStatus("syncing");
      setSyncError(null);

      // Pre-warm user root document so first memory write avoids extra setup round-trip
      void ensureUserRootDocument(nextUser).catch(() => undefined);

      // Move any unauthenticated offline memories into pending queue to sync cleanly
      if (guestCache.length > 0) {
        const guestPending = readPendingQueue(null);
        const existingPendingIds = new Set(
          guestPending.map((item) => item.memoryId)
        );
        const extraUpserts: PendingMemoryMutation[] = guestCache
          .filter((m) => !existingPendingIds.has(m.id))
          .map((m) => ({
            op: "upsert",
            memoryId: m.id,
            record: { ...m, ownerId: nextUser.uid },
            queuedAt: m.updatedAt,
          }));
        if (extraUpserts.length > 0) {
          writePendingQueue(null, [...guestPending, ...extraUpserts]);
        }
      }

      const memCollectionPath = `users/${nextUser.uid}/memories`;
      const q = query(
        collection(db, "users", nextUser.uid, "memories"),
        where("ownerId", "==", nextUser.uid)
      );

      unsubscribeSnapshot = onSnapshot(
        q,
        { includeMetadataChanges: true },
        (snapshot) => {
          const now = Date.now();
          const rawList: MemoryRecord[] = snapshot.docs.map((docSnap) => {
            const data = docSnap.data();
            return {
              id: docSnap.id,
              ownerId:
                typeof data.ownerId === "string"
                  ? data.ownerId
                  : nextUser.uid,
              description:
                typeof data.description === "string" ? data.description : "",
              category: coerceMemoryCategory(
                data.category,
                String(data.description || "")
              ),
              source:
                data.source === "Manual" ||
                data.source === "Voice" ||
                data.source === "Automatic"
                  ? data.source
                  : "Manual",
              importance:
                data.importance === "important" ? "important" : "standard",
              confirmationStatus:
                data.confirmationStatus === "manual" ||
                data.confirmationStatus === "voice" ||
                data.confirmationStatus === "auto_saved" ||
                data.confirmationStatus === "user_approved"
                  ? data.confirmationStatus
                  : "manual",
              keywords: Array.isArray(data.keywords)
                ? data.keywords.filter(
                    (k): k is string => typeof k === "string"
                  )
                : [],
              createdAt: toMillis(data.createdAt, now),
              updatedAt: toMillis(data.updatedAt, now),
            };
          });

          const sanitized = sanitizeMemoryRecords(rawList);
          setMemories(sanitized);
          writeCachedMemories(nextUser.uid, sanitized);

          const pendingLen =
            readPendingQueue(nextUser.uid).length +
            readPendingQueue(null).length;
          setPendingSyncCount(pendingLen);

          if (typeof navigator !== "undefined" && !navigator.onLine) {
            setSyncStatus("offline");
          } else if (pendingLen > 0) {
            setSyncStatus("syncing");
          } else if (snapshot.metadata.fromCache) {
            setSyncStatus("syncing");
          } else {
            setSyncError(null);
            setSyncStatus("synced");
          }
        },
        (error) => {
          const errInfo = buildFirestoreErrorInfo(
            error,
            OperationType.LIST,
            memCollectionPath
          );
          console.error("Firestore Error: ", JSON.stringify(errInfo));
          const classified = classifyFirestoreFailure(
            error,
            typeof navigator === "undefined" ? true : navigator.onLine
          );
          if (classified.kind === "transient_offline") {
            setSyncStatus("offline");
          } else if (classified.kind === "auth_expired") {
            setSyncStatus("auth_expired");
            setSyncError(classified.userMessage);
          } else {
            setSyncStatus("error");
            setSyncError(classified.userMessage);
          }
        }
      );

      void flushPendingQueue(nextUser);
    });

    const handleOnline = () => {
      const currentUser = userRef.current;
      if (currentUser) {
        void flushPendingQueue(currentUser);
      } else {
        setSyncStatus("unauthenticated");
      }
    };

    const handleOffline = () => {
      clearScheduledRetry();
      setSyncStatus("offline");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      clearScheduledRetry();
      unsubscribeAuth();
      if (unsubscribeSnapshot) unsubscribeSnapshot();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [clearScheduledRetry, ensureUserRootDocument, flushPendingQueue]);

  const signInWithGoogle = useCallback(async () => {
    setSyncError(null);
    setSyncStatus("syncing");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Google Sign-In was cancelled.";
      setSyncError(message);
      setSyncStatus(userRef.current ? "error" : "unauthenticated");
    }
  }, []);

  const signOutUser = useCallback(async () => {
    clearScheduledRetry();
    await signOut(auth);
    setPendingApproval(null);
    dismissAutoSaveNotice();
  }, [clearScheduledRetry, dismissAutoSaveNotice]);

  const retrySync = useCallback(async () => {
    const activeUser = userRef.current;
    if (!activeUser) return;
    clearScheduledRetry();
    setSyncError(null);
    const resetUserQueue = readPendingQueue(activeUser.uid).map((item) => ({
      ...item,
      attempts: 0,
      lastError: undefined,
    }));
    writePendingQueue(activeUser.uid, resetUserQueue);
    const resetGuestQueue = readPendingQueue(null).map((item) => ({
      ...item,
      attempts: 0,
      lastError: undefined,
    }));
    writePendingQueue(null, resetGuestQueue);
    await flushPendingQueue(activeUser);
  }, [clearScheduledRetry, flushPendingQueue]);

  const persistMemoryRecord = useCallback(
    async (options: {
      description: string;
      category: MemoryCategory;
      source: MemorySource;
      importance: MemoryImportance;
      confirmationStatus: MemoryConfirmationStatus;
      targetId?: string;
      allowConflict?: boolean;
      requireCloudSuccess?: boolean;
    }): Promise<MemoryMutationResult> => {
      const description = normalizeMemoryDescription(options.description);
      if (description.length < MIN_MEMORY_DESCRIPTION_LENGTH) {
        return {
          ok: false,
          error: "Memory description is too short. Please enter a clear note.",
        };
      }

      const secretCheck = containsSensitiveSecret(description);
      if (secretCheck.blocked) {
        return {
          ok: false,
          error:
            secretCheck.reason ||
            "Sensitive credentials or secrets cannot be saved.",
        };
      }

      const category = coerceMemoryCategory(options.category, description);
      const currentList = memoriesRef.current;

      const dupCheck = assessDuplicateOrConflict(
        description,
        category,
        currentList,
        options.targetId
      );

      if (!options.targetId && dupCheck.kind === "exact_duplicate") {
        return {
          ok: false,
          duplicate: true,
          matchedMemory: dupCheck.matchedMemory,
          error: "That memory is already saved.",
        };
      }

      if (
        !options.targetId &&
        !options.allowConflict &&
        dupCheck.kind === "update_or_conflict" &&
        dupCheck.matchedMemory
      ) {
        return {
          ok: false,
          conflict: true,
          matchedMemory: dupCheck.matchedMemory,
          error: `Similar memory already exists: "${dupCheck.matchedMemory.description}"`,
        };
      }

      const activeUser = userRef.current;
      const now = Date.now();
      const targetExisting = options.targetId
        ? currentList.find((m) => m.id === options.targetId)
        : undefined;
      const isUpdate = Boolean(targetExisting);
      const id = targetExisting ? targetExisting.id : buildMemoryId();
      const ownerId = activeUser ? activeUser.uid : "guest";

      const record: MemoryRecord = {
        id,
        ownerId,
        description,
        category,
        source: options.source,
        importance: options.importance,
        confirmationStatus: options.confirmationStatus,
        keywords: extractMemoryKeywords(description),
        createdAt: targetExisting ? targetExisting.createdAt : now,
        updatedAt: now,
      };

      const isBrowserOffline =
        typeof navigator !== "undefined" && !navigator.onLine;

      if (!activeUser || isBrowserOffline) {
        if (options.requireCloudSuccess && activeUser && isBrowserOffline) {
          // Offline queue still persists locally and syncs later
        }
        const nextList = sanitizeMemoryRecords([
          record,
          ...currentList.filter((m) => m.id !== id),
        ]);
        memoriesRef.current = nextList;
        setMemories(nextList);
        writeCachedMemories(activeUser?.uid ?? null, nextList);
        enqueueMutation(activeUser?.uid ?? null, {
          op: "upsert",
          memoryId: id,
          record,
          queuedAt: now,
        });
        setSyncStatus(activeUser ? "offline" : "unauthenticated");
        return {
          ok: true,
          cloudSynced: false,
          requiresSignIn: !activeUser,
          memory: record,
        };
      }

      // Signed in and online: commit directly to Firestore first!
      const syncStartMs = performance.now();
      setSyncStatus("syncing");
      try {
        const firestoreWriteMs = await writeMemoryToFirestore(
          activeUser,
          record,
          isUpdate
        );
        const nextList = sanitizeMemoryRecords([
          record,
          ...currentList.filter((m) => m.id !== id),
        ]);
        memoriesRef.current = nextList;
        setMemories(nextList);
        writeCachedMemories(activeUser.uid, nextList);

        const remainingPending = readPendingQueue(activeUser.uid).filter(
          (item) => item.memoryId !== id
        );
        writePendingQueue(activeUser.uid, remainingPending);
        setPendingSyncCount(
          remainingPending.length + readPendingQueue(null).length
        );

        setSyncError(null);
        setSyncStatus(remainingPending.length > 0 ? "syncing" : "synced");
        console.log(
          `[MemoryTelemetry] stage=sync_complete firestoreWriteMs=${firestoreWriteMs} totalSyncMs=${Math.round(performance.now() - syncStartMs)}`
        );
        return {
          ok: true,
          cloudSynced: true,
          memory: record,
        };
      } catch (err) {
        const classified = classifyFirestoreFailure(
          err,
          typeof navigator === "undefined" ? true : navigator.onLine
        );
        if (classified.kind === "auth_expired") {
          setSyncStatus("auth_expired");
          setSyncError(classified.userMessage);
          return {
            ok: false,
            cloudSynced: false,
            error: classified.userMessage,
          };
        }
        if (!classified.retryable) {
          setSyncStatus("error");
          setSyncError(classified.userMessage);
          return {
            ok: false,
            cloudSynced: false,
            error: classified.userMessage,
          };
        }

        const nextList = sanitizeMemoryRecords([
          record,
          ...currentList.filter((m) => m.id !== id),
        ]);
        memoriesRef.current = nextList;
        setMemories(nextList);
        writeCachedMemories(activeUser.uid, nextList);
        enqueueMutation(activeUser.uid, {
          op: "upsert",
          memoryId: id,
          record,
          queuedAt: now,
          attempts: 1,
          lastError: classified.userMessage,
        });
        setSyncStatus(
          classified.kind === "transient_offline" ? "offline" : "error"
        );
        setSyncError(classified.userMessage);
        return {
          ok: !options.requireCloudSuccess,
          cloudSynced: false,
          memory: record,
          error: options.requireCloudSuccess
            ? classified.userMessage
            : undefined,
        };
      }
    },
    [enqueueMutation, writeMemoryToFirestore]
  );

  const addManualMemory = useCallback(
    async (input: {
      description: string;
      category: MemoryCategory;
      replaceExistingId?: string;
    }): Promise<MemoryMutationResult> => {
      return persistMemoryRecord({
        description: input.description,
        category: input.category,
        source: "Manual",
        importance: "standard",
        confirmationStatus: "manual",
        targetId: input.replaceExistingId,
        allowConflict: true,
      });
    },
    [persistMemoryRecord]
  );

  const editMemory = useCallback(
    async (input: {
      id: string;
      description: string;
      category: MemoryCategory;
    }): Promise<MemoryMutationResult> => {
      const existing = memoriesRef.current.find((m) => m.id === input.id);
      if (!existing) {
        return { ok: false, error: "Memory record was not found." };
      }
      return persistMemoryRecord({
        description: input.description,
        category: input.category,
        source: existing.source,
        importance: existing.importance,
        confirmationStatus: existing.confirmationStatus,
        targetId: existing.id,
        allowConflict: true,
      });
    },
    [persistMemoryRecord]
  );

  const deleteMemory = useCallback(
    async (id: string): Promise<MemoryMutationResult> => {
      const activeUser = userRef.current;
      const prevList = memoriesRef.current;
      const target = prevList.find((m) => m.id === id);
      if (!target) {
        return { ok: false, error: "Memory not found." };
      }

      const nextList = prevList.filter((m) => m.id !== id);
      memoriesRef.current = nextList;
      setMemories(nextList);
      writeCachedMemories(activeUser?.uid ?? null, nextList);

      const isBrowserOffline =
        typeof navigator !== "undefined" && !navigator.onLine;

      if (!activeUser || isBrowserOffline) {
        enqueueMutation(activeUser?.uid ?? null, {
          op: "delete",
          memoryId: id,
          queuedAt: Date.now(),
        });
        setSyncStatus(activeUser ? "offline" : "unauthenticated");
        return { ok: true, cloudSynced: false };
      }

      setSyncStatus("syncing");
      try {
        await deleteMemoryFromFirestore(activeUser, id);
        const remainingPending = readPendingQueue(activeUser.uid).filter(
          (item) => item.memoryId !== id
        );
        writePendingQueue(activeUser.uid, remainingPending);
        setPendingSyncCount(
          remainingPending.length + readPendingQueue(null).length
        );
        setSyncError(null);
        setSyncStatus("synced");
        return { ok: true, cloudSynced: true };
      } catch (err) {
        const classified = classifyFirestoreFailure(
          err,
          typeof navigator === "undefined" ? true : navigator.onLine
        );
        if (classified.kind === "transient_offline") {
          enqueueMutation(activeUser.uid, {
            op: "delete",
            memoryId: id,
            queuedAt: Date.now(),
            attempts: 1,
            lastError: classified.userMessage,
          });
          setSyncStatus("offline");
          setSyncError(classified.userMessage);
          return { ok: true, cloudSynced: false };
        }
        // Revert local delete on hard permission/auth/backend failure
        memoriesRef.current = prevList;
        setMemories(prevList);
        writeCachedMemories(activeUser.uid, prevList);
        setSyncStatus(
          classified.kind === "auth_expired" ? "auth_expired" : "error"
        );
        setSyncError(classified.userMessage);
        return { ok: false, error: classified.userMessage };
      }
    },
    [deleteMemoryFromFirestore, enqueueMutation]
  );

  const approvePendingMemory = useCallback(async (): Promise<MemoryMutationResult> => {
    const pending = pendingApprovalRef.current;
    if (!pending) {
      return { ok: false, error: "No pending memory approval found." };
    }
    const res = await persistMemoryRecord({
      description: pending.description,
      category: pending.category,
      source: "Automatic",
      importance: "important",
      confirmationStatus: "user_approved",
      targetId: pending.existingMatchId,
      allowConflict: true,
    });
    if (res.ok) {
      pendingApprovalRef.current = null;
      setPendingApproval(null);
    }
    return res;
  }, [persistMemoryRecord]);

  const declinePendingMemory = useCallback((): string | null => {
    const pending = pendingApprovalRef.current;
    if (!pending) return null;
    const declinedText = pending.description;
    setDeclinedDescriptions((prev) =>
      prev.includes(declinedText) ? prev : [...prev.slice(-15), declinedText]
    );
    pendingApprovalRef.current = null;
    setPendingApproval(null);
    return declinedText;
  }, []);

  const handleVoiceToolAction = useCallback(
    async (
      request: MemoryToolRelayRequest
    ): Promise<Record<string, unknown>> => {
      const { action, args } = request;
      const currentList = memoriesRef.current;

      if (action === "search_memories") {
        const queryText =
          typeof args.query === "string" ? args.query.trim() : "";
        const matches = retrieveRelevantMemories(currentList, queryText, 6).map(
          (m) => ({
            id: m.id,
            category: m.category,
            description: m.description,
            source: m.source,
            importance: m.importance,
          })
        );
        return {
          status: "ok",
          count: matches.length,
          memories: matches,
        };
      }

      if (action === "resolve_pending_memory_approval") {
        const decision =
          args.decision === "approve" ? "approve" : "decline";
        if (!pendingApprovalRef.current) {
          return {
            status: "no_pending_proposal",
            saved: false,
            message: "There is no pending memory approval waiting right now.",
          };
        }
        if (decision === "approve") {
          const result = await approvePendingMemory();
          return result.ok
            ? {
                status: "approved_and_saved",
                saved: true,
                cloudSynced: result.cloudSynced ?? false,
                memory: result.memory,
              }
            : {
                status: "error",
                saved: false,
                message:
                  result.error || "Could not save approved memory right now.",
              };
        }
        const declined = declinePendingMemory();
        return {
          status: "declined",
          saved: false,
          declinedDescription: declined,
        };
      }

      if (action === "update_memory") {
        const description =
          typeof args.description === "string" ? args.description : "";
        const targetId =
          typeof args.memoryId === "string" ? args.memoryId : undefined;
        const category = coerceMemoryCategory(args.category, description);

        let resolvedTargetId =
          targetId && currentList.some((m) => m.id === targetId)
            ? targetId
            : undefined;
        if (!resolvedTargetId) {
          const dup = assessDuplicateOrConflict(
            description,
            category,
            currentList
          );
          if (dup.matchedMemory) {
            resolvedTargetId = dup.matchedMemory.id;
          }
        }

        const result = await persistMemoryRecord({
          description,
          category,
          source: "Voice",
          importance:
            args.importance === "important" ? "important" : "standard",
          confirmationStatus: "voice",
          targetId: resolvedTargetId,
          allowConflict: true,
          requireCloudSuccess: true,
        });

        if (!result.ok) {
          return {
            status: "error",
            saved: false,
            message: result.error || "Failed to update memory.",
          };
        }
        return {
          status: resolvedTargetId ? "updated" : "saved",
          saved: true,
          cloudSynced: result.cloudSynced ?? false,
          requiresSignIn: result.requiresSignIn ?? false,
          memory: result.memory,
        };
      }

      // Default: save_memory
      const description =
        typeof args.description === "string" ? args.description : "";
      const category = coerceMemoryCategory(args.category, description);
      const isExplicitUpdate = Boolean(args.isUpdate);
      const explicitTargetId =
        typeof args.updateTargetId === "string" &&
        currentList.some((m) => m.id === args.updateTargetId)
          ? args.updateTargetId
          : undefined;

      const dupCheck = assessDuplicateOrConflict(
        description,
        category,
        currentList,
        explicitTargetId
      );

      if (!explicitTargetId && dupCheck.kind === "exact_duplicate") {
        return {
          status: "already_saved",
          saved: false,
          duplicate: true,
          matchedMemory: dupCheck.matchedMemory
            ? {
                id: dupCheck.matchedMemory.id,
                description: dupCheck.matchedMemory.description,
                category: dupCheck.matchedMemory.category,
              }
            : undefined,
          message: "This detail is already stored in your Memory Core.",
        };
      }

      if (
        dupCheck.kind === "update_or_conflict" &&
        dupCheck.matchedMemory &&
        !isExplicitUpdate &&
        !explicitTargetId
      ) {
        return {
          status: "conflict_needs_clarification",
          saved: false,
          existingMemory: {
            id: dupCheck.matchedMemory.id,
            description: dupCheck.matchedMemory.description,
            category: dupCheck.matchedMemory.category,
          },
          proposedDescription: description,
          message:
            "A related memory already exists. Ask the user whether to update the existing memory or keep both.",
        };
      }

      const targetIdToUpdate =
        explicitTargetId ||
        (isExplicitUpdate && dupCheck.matchedMemory
          ? dupCheck.matchedMemory.id
          : undefined);

      const result = await persistMemoryRecord({
        description,
        category,
        source: "Voice",
        importance:
          args.importance === "important" ? "important" : "standard",
        confirmationStatus: "voice",
        targetId: targetIdToUpdate,
        allowConflict: true,
        requireCloudSuccess: true,
      });

      if (!result.ok) {
        return {
          status: "error",
          saved: false,
          message: result.error || "Could not save memory to storage.",
        };
      }

      return {
        status: targetIdToUpdate ? "updated" : "saved",
        saved: true,
        cloudSynced: result.cloudSynced ?? false,
        requiresSignIn: result.requiresSignIn ?? false,
        memory: result.memory,
      };
    },
    [
      approvePendingMemory,
      declinePendingMemory,
      persistMemoryRecord,
    ]
  );

  const handleAsyncAutoSaveCandidate = useCallback(
    async (candidate: AnalyzedMemoryCandidate): Promise<void> => {
      if (candidate.level !== "level1_auto") return;

      let targetId = candidate.updatesExistingId;
      if (!targetId) {
        const dupCheck = assessDuplicateOrConflict(
          candidate.description,
          candidate.category,
          memoriesRef.current
        );
        if (dupCheck.kind === "exact_duplicate") {
          return;
        }
        if (
          dupCheck.kind === "update_or_conflict" &&
          dupCheck.matchedMemory
        ) {
          targetId = dupCheck.matchedMemory.id;
        }
      }

      const result = await persistMemoryRecord({
        description: candidate.description,
        category: candidate.category,
        source: "Automatic",
        importance: "standard",
        confirmationStatus: "auto_saved",
        targetId,
        allowConflict: true,
      });

      if (result.ok && result.memory) {
        showAutoSaveNotice({
          memoryId: result.memory.id,
          description: result.memory.description,
          category: result.memory.category,
          action: targetId ? "updated" : "created",
        });
      }
    },
    [persistMemoryRecord, showAutoSaveNotice]
  );

  const handleAsyncApprovalCandidate = useCallback(
    (candidate: AnalyzedMemoryCandidate): void => {
      if (candidate.level !== "level2_important") return;
      const startedAt = performance.now();
      const normalized = normalizeMemoryDescription(candidate.description);
      if (normalized.length < MIN_MEMORY_DESCRIPTION_LENGTH) return;
      if (containsSensitiveSecret(normalized).blocked) return;

      const lower = normalized.toLowerCase();
      if (
        declinedDescriptions.some(
          (d) =>
            d.toLowerCase() === lower ||
            (d.length > 10 &&
              (lower.includes(d.toLowerCase()) ||
                d.toLowerCase().includes(lower)))
        )
      ) {
        return;
      }

      const dup = assessDuplicateOrConflict(
        normalized,
        candidate.category,
        memoriesRef.current
      );
      if (dup.kind === "exact_duplicate") return;

      setPendingApproval({
        candidateId: `prop_${Date.now().toString(36)}`,
        description: normalized,
        category: candidate.category,
        reason: candidate.reason,
        existingMatchId:
          candidate.updatesExistingId ?? dup.matchedMemory?.id,
        existingMatchDescription: dup.matchedMemory?.description,
        createdAt: Date.now(),
      });
      console.log(
        `[MemoryTelemetry] stage=permission_dispatch permissionDispatchMs=${Math.round(performance.now() - startedAt)}`
      );
    },
    [declinedDescriptions]
  );

  const getRelevantMemoriesPayload = useCallback(
    (queryText = "") => {
      const relevant = retrieveRelevantMemories(
        memoriesRef.current,
        queryText,
        8
      );
      return {
        memories: relevant,
        retrievedBlock: buildRetrievedMemoriesBlock(relevant),
      };
    },
    []
  );

  const openDrawer = useCallback((editId?: string) => {
    setIsDrawerOpen(true);
    setEditingMemoryId(editId ?? null);
  }, []);

  const closeDrawer = useCallback(() => {
    setIsDrawerOpen(false);
    setEditingMemoryId(null);
  }, []);

  const value = useMemo<MemoryContextValue>(
    () => ({
      user,
      authReady,
      memories,
      syncStatus,
      syncError,
      pendingSyncCount,
      isDrawerOpen,
      editingMemoryId,
      pendingApproval,
      autoSaveNotice,
      declinedDescriptions,
      openDrawer,
      closeDrawer,
      startEditingMemory: setEditingMemoryId,
      signInWithGoogle,
      signOutUser,
      retrySync,
      addManualMemory,
      editMemory,
      deleteMemory,
      handleVoiceToolAction,
      handleAsyncAutoSaveCandidate,
      handleAsyncApprovalCandidate,
      approvePendingMemory,
      declinePendingMemory,
      dismissAutoSaveNotice,
      getRelevantMemoriesPayload,
    }),
    [
      user,
      authReady,
      memories,
      syncStatus,
      syncError,
      pendingSyncCount,
      isDrawerOpen,
      editingMemoryId,
      pendingApproval,
      autoSaveNotice,
      declinedDescriptions,
      openDrawer,
      closeDrawer,
      signInWithGoogle,
      signOutUser,
      retrySync,
      addManualMemory,
      editMemory,
      deleteMemory,
      handleVoiceToolAction,
      handleAsyncAutoSaveCandidate,
      handleAsyncApprovalCandidate,
      approvePendingMemory,
      declinePendingMemory,
      dismissAutoSaveNotice,
      getRelevantMemoriesPayload,
    ]
  );

  return (
    <MemoryContext.Provider value={value}>{children}</MemoryContext.Provider>
  );
}

export function useMemoryCore(): MemoryContextValue {
  const ctx = useContext(MemoryContext);
  if (!ctx) {
    throw new Error("useMemoryCore must be used within MemoryProvider.");
  }
  return ctx;
}
