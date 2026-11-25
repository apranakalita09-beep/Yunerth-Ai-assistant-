import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Brain,
  Check,
  Cloud,
  CloudOff,
  Edit3,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { searchMemoriesLocally } from "../../memoryCore";
import { useMemoryCore } from "../memory/MemoryProvider";
import {
  MEMORY_CATEGORIES,
  MEMORY_FILTER_TABS,
  type MemoryCategory,
  type MemoryCategoryFilter,
  type MemoryRecord,
} from "../memory/types";

function formatMemoryDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(ts));
  } catch {
    return "";
  }
}

export function MemoryCoreDrawer() {
  const {
    user,
    authReady,
    memories,
    syncStatus,
    syncError,
    pendingSyncCount,
    isDrawerOpen,
    editingMemoryId,
    openDrawer,
    closeDrawer,
    startEditingMemory,
    signInWithGoogle,
    signOutUser,
    retrySync,
    addManualMemory,
    editMemory,
    deleteMemory,
  } = useMemoryCore();

  const [selectedCategory, setSelectedCategory] =
    useState<MemoryCategoryFilter>("All Memories");
  const [searchQuery, setSearchQuery] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [formCategory, setFormCategory] =
    useState<MemoryCategory>("Preferences");
  const [formDescription, setFormDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const editingTarget = useMemo(
    () =>
      editingMemoryId
        ? memories.find((m) => m.id === editingMemoryId) ?? null
        : null,
    [editingMemoryId, memories]
  );

  useEffect(() => {
    if (editingTarget) {
      setIsAdding(false);
      setFormCategory(editingTarget.category);
      setFormDescription(editingTarget.description);
      setFormError(null);
      setConfirmDeleteId(null);
    }
  }, [editingTarget]);

  useEffect(() => {
    if (!isDrawerOpen) {
      setIsAdding(false);
      setFormError(null);
      setConfirmDeleteId(null);
    }
  }, [isDrawerOpen]);

  useEffect(() => {
    if (!isDrawerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDrawer();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDrawer, isDrawerOpen]);

  const filteredMemories = useMemo(
    () => searchMemoriesLocally(memories, searchQuery, selectedCategory),
    [memories, searchQuery, selectedCategory]
  );

  if (!isDrawerOpen) return null;

  const isFormOpen = isAdding || editingTarget !== null;

  const handleOpenAdd = () => {
    startEditingMemory(null);
    setFormCategory(
      selectedCategory !== "All Memories" ? selectedCategory : "Preferences"
    );
    setFormDescription("");
    setFormError(null);
    setConfirmDeleteId(null);
    setIsAdding(true);
  };

  const handleCancelForm = () => {
    setIsAdding(false);
    startEditingMemory(null);
    setFormDescription("");
    setFormError(null);
  };

  const handleSubmitForm = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    setFormError(null);
    setIsSubmitting(true);

    try {
      const result = editingTarget
        ? await editMemory({
            id: editingTarget.id,
            description: formDescription,
            category: formCategory,
          })
        : await addManualMemory({
            description: formDescription,
            category: formCategory,
          });

      if (!result.ok) {
        setFormError(
          result.error || "Unable to save this memory. Please review your text."
        );
        return;
      }

      setIsAdding(false);
      startEditingMemory(null);
      setFormDescription("");
      setFormError(null);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmDelete = async (memory: MemoryRecord) => {
    setDeletingId(memory.id);
    try {
      const res = await deleteMemory(memory.id);
      if (res.ok) {
        setConfirmDeleteId(null);
        if (editingMemoryId === memory.id) {
          handleCancelForm();
        }
      } else if (res.error) {
        setFormError(res.error);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const renderSyncBadge = () => {
    if (!authReady) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Checking account...
        </span>
      );
    }

    if (!user) {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-amber-300/90">
          <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Local mode — sign in to sync to cloud
        </span>
      );
    }

    if (syncStatus === "syncing") {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-sky-300">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Syncing{pendingSyncCount > 0 ? ` (${pendingSyncCount})` : "..."}
        </span>
      );
    }

    if (syncStatus === "offline") {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-amber-300">
          <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Offline — saved locally
          {pendingSyncCount > 0 ? ` (${pendingSyncCount} pending)` : ""}
        </span>
      );
    }

    if (syncStatus === "auth_expired") {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-rose-300">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Session expired — sign in again
        </span>
      );
    }

    if (syncStatus === "error") {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs text-rose-300">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Sync issue
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
        <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Synced to Cloud
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="memory-core-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeDrawer();
      }}
    >
      <div className="flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl border border-slate-800/90 bg-[#0B1019]/95 text-slate-100 shadow-2xl sm:rounded-3xl">
        {/* Top Header */}
        <header className="flex items-start justify-between gap-4 border-b border-slate-800/80 px-5 pt-5 pb-4 sm:px-7">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <Brain className="h-5 w-5 shrink-0 text-sky-400" aria-hidden="true" />
              <h2
                id="memory-core-title"
                className="font-display text-lg font-semibold tracking-tight text-slate-50 sm:text-xl"
              >
                Yunerth Memory Core
              </h2>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                · {memories.length}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              {renderSyncBadge()}
              {user && (
                <span className="truncate text-xs text-slate-400">
                  {user.email || user.displayName || "Signed in"}
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!isFormOpen && (
              <button
                type="button"
                onClick={handleOpenAdd}
                className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-sky-400/35 bg-sky-500/15 px-3.5 py-2 text-xs font-medium text-sky-200 transition-colors hover:bg-sky-500/25 sm:text-sm"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Add Memory</span>
              </button>
            )}
            <button
              type="button"
              onClick={closeDrawer}
              aria-label="Close Memory Core"
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-800 bg-slate-900/70 text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-100"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Cloud Auth / Sync Banner */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/70 bg-slate-900/40 px-5 py-3 sm:px-7">
          {!user ? (
            <>
              <p className="text-xs leading-relaxed text-slate-300">
                Sign in with Google to save memories privately in your cloud
                account across sessions and restarts.
              </p>
              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                className="inline-flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-xl border border-sky-400/35 bg-sky-500/20 px-4 py-2 text-xs font-medium text-sky-100 transition-colors hover:bg-sky-500/30"
              >
                <LogIn className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Sign in with Google</span>
              </button>
            </>
          ) : (
            <>
              <div className="min-w-0 flex-1 text-xs text-slate-400">
                {syncError ? (
                  <span className="text-rose-300">{syncError}</span>
                ) : (
                  <span>
                    Relevant memories automatically adapt Yunerth across your
                    conversations.
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {syncStatus === "auth_expired" && (
                  <button
                    type="button"
                    onClick={() => void signInWithGoogle()}
                    className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-sky-400/35 bg-sky-500/20 px-3 py-2 text-xs font-medium text-sky-100 transition-colors hover:bg-sky-500/30"
                  >
                    <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Sign in again</span>
                  </button>
                )}
                {(syncStatus === "error" || pendingSyncCount > 0) &&
                  syncStatus !== "auth_expired" && (
                    <button
                      type="button"
                      onClick={() => void retrySync()}
                      className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-700/80 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Retry Sync</span>
                    </button>
                  )}
                <button
                  type="button"
                  onClick={() => void signOutUser()}
                  className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-800 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-slate-100"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Sign out</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Add / Edit Memory Form */}
        {isFormOpen && (
          <form
            onSubmit={handleSubmitForm}
            className="border-b border-slate-800/80 bg-[#0E1522] px-5 py-4 sm:px-7"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-100">
                {editingTarget ? "Edit Memory" : "Add New Memory"}
              </h3>
              <span className="font-mono text-xs text-slate-400 tabular-nums">
                {formDescription.trim().length}/600
              </span>
            </div>

            <div className="mt-3">
              <label
                htmlFor="memory-category-select"
                className="block text-xs font-medium text-slate-300"
              >
                Category
              </label>
              <select
                id="memory-category-select"
                value={formCategory}
                onChange={(e) =>
                  setFormCategory(e.target.value as MemoryCategory)
                }
                className="mt-1.5 min-h-[44px] w-full rounded-xl border border-slate-700/80 bg-[#080C14] px-3 py-2 text-sm text-slate-100 focus:border-sky-400/60 focus:outline-none"
              >
                {MEMORY_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-3">
              <label
                htmlFor="memory-description-input"
                className="block text-xs font-medium text-slate-300"
              >
                Description
              </label>
              <textarea
                id="memory-description-input"
                rows={3}
                maxLength={600}
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Example: Prefer explanations in simple English"
                className="mt-1.5 w-full resize-none rounded-xl border border-slate-700/80 bg-[#080C14] px-3.5 py-2.5 text-sm leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-sky-400/60 focus:outline-none"
              />
            </div>

            {formError && (
              <div
                role="alert"
                className="mt-2.5 flex items-start gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
              >
                <AlertCircle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>{formError}</span>
              </div>
            )}

            <div className="mt-3.5 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={handleCancelForm}
                disabled={isSubmitting}
                className="inline-flex min-h-[44px] items-center justify-center whitespace-nowrap rounded-xl border border-slate-700/80 bg-slate-900/70 px-4 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 sm:text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex min-h-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-xs font-semibold text-sky-100 transition-colors hover:bg-sky-500/30 disabled:opacity-60 sm:text-sm"
              >
                {isSubmitting ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Check className="h-4 w-4" aria-hidden="true" />
                )}
                <span>
                  {editingTarget ? "Save Changes" : "Commit Memory"}
                </span>
              </button>
            </div>
          </form>
        )}

        {/* Search & Category Tabs */}
        <div className="border-b border-slate-800/70 px-5 py-3 sm:px-7">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden="true"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search saved memories..."
              aria-label="Search memories"
              className="min-h-[44px] w-full rounded-xl border border-slate-800 bg-[#080C14] pr-10 pl-10 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400/50 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear memory search"
                className="absolute top-1/2 right-1.5 inline-flex min-h-[40px] min-w-[40px] -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:text-slate-200"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>

          <div
            role="tablist"
            aria-label="Memory categories"
            className="mt-3 flex gap-1.5 overflow-x-auto pb-1"
          >
            {MEMORY_FILTER_TABS.map((tab) => {
              const active = selectedCategory === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setSelectedCategory(tab)}
                  className={`min-h-[40px] shrink-0 whitespace-nowrap rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "border-sky-400/45 bg-sky-500/20 text-sky-100"
                      : "border-slate-800/90 bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:text-slate-200"
                  }`}
                >
                  {tab}
                </button>
              );
            })}
          </div>
        </div>

        {/* Scrollable Memories List */}
        <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-7">
          {filteredMemories.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-800/80 bg-slate-900/25 px-6 py-10 text-center">
              <Brain
                className="h-8 w-8 text-slate-600"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-medium text-slate-300">
                {memories.length === 0
                  ? "No memories saved yet"
                  : "No matching memories found"}
              </p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
                {memories.length === 0
                  ? 'Add a note here or say "Yunerth, remember that..." during voice chat.'
                  : "Try a different keyword or switch back to All Memories."}
              </p>
              {memories.length === 0 && !isFormOpen && (
                <button
                  type="button"
                  onClick={handleOpenAdd}
                  className="mt-4 inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-sky-400/35 bg-sky-500/15 px-4 py-2 text-xs font-medium text-sky-200 transition-colors hover:bg-sky-500/25"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Add First Memory</span>
                </button>
              )}
            </div>
          ) : (
            <ul className="space-y-3">
              {filteredMemories.map((memory) => {
                const isConfirmingDelete = confirmDeleteId === memory.id;
                const isDeleting = deletingId === memory.id;
                return (
                  <li
                    key={memory.id}
                    className="rounded-2xl border border-slate-800/85 bg-[#0E1522]/85 p-4 transition-colors hover:border-slate-700/80"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-relaxed text-slate-100 break-words">
                          {memory.description}
                        </p>
                        <p className="mt-2 font-mono text-xs text-slate-400 tabular-nums">
                          <span className="text-sky-300">{memory.category}</span>
                          {" · "}
                          <span>{memory.source}</span>
                          {" · "}
                          <span>{formatMemoryDate(memory.updatedAt)}</span>
                          {memory.importance === "important" && (
                            <span className="text-amber-300"> · Important</span>
                          )}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {!isConfirmingDelete ? (
                          <>
                            <button
                              type="button"
                              onClick={() => openDrawer(memory.id)}
                              aria-label={`Edit memory: ${memory.description}`}
                              className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-slate-100"
                            >
                              <Edit3
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(memory.id)}
                              aria-label={`Delete memory: ${memory.description}`}
                              className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs font-medium text-rose-300 transition-colors hover:border-rose-500/40 hover:bg-rose-500/10"
                            >
                              <Trash2
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              <span>Delete</span>
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteId(null)}
                              className="inline-flex min-h-[44px] items-center whitespace-nowrap rounded-xl border border-slate-700/80 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={isDeleting}
                              onClick={() => void handleConfirmDelete(memory)}
                              className="inline-flex min-h-[44px] items-center gap-1.5 whitespace-nowrap rounded-xl border border-rose-500/50 bg-rose-500/20 px-3 py-2 text-xs font-semibold text-rose-100 hover:bg-rose-500/30 disabled:opacity-60"
                            >
                              {isDeleting ? (
                                <Loader2
                                  className="h-3.5 w-3.5 animate-spin"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Trash2
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              )}
                              <span>Confirm Delete</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
