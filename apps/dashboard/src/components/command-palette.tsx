import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { Task } from "@crossagent/protocol";
import { useUi, type PageName } from "../store.js";
import { t } from "../i18n.js";

export function CommandPalette({ tasks }: { tasks: Task[] }) {
  const open = useUi((state) => state.commandOpen);
  const setOpen = useUi((state) => state.setCommandOpen);
  const [query, setQuery] = useState("");
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const setPage = useUi((state) => state.setPage);
  const setSelectedTaskId = useUi((state) => state.setSelectedTaskId);
  const pages: Array<{ title: string; page: PageName }> = [
    { title: t("Open overview"), page: "overview" },
    { title: t("Inspect live agents"), page: "agents" },
    { title: t("Review communications"), page: "communications" },
    { title: t("Open audit stream"), page: "audit" },
  ];
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return tasks
      .filter((task) =>
        `${task.title} ${task.description} ${task.id} ${task.status} ${task.ownerAgentId ?? ""}`
          .toLowerCase()
          .includes(normalized),
      )
      .slice(0, 6);
  }, [query, tasks]);
  const itemCount = query ? results.length : pages.length;
  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, [setOpen]);
  const focusResult = (index: number) => {
    if (!itemCount) return;
    const normalized = (index + itemCount) % itemCount;
    resultRefs.current[normalized]?.focus();
  };
  const handleResultKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusResult(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusResult(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusResult(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusResult(itemCount - 1);
    }
  };

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) {
        wasOpen.current = false;
        const focusTarget = previouslyFocused.current;
        window.setTimeout(() => {
          const target = focusTarget?.isConnected
            ? focusTarget
            : document.querySelector<HTMLElement>(".search-trigger");
          target?.focus();
        }, 0);
      }
      return;
    }
    wasOpen.current = true;
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!activeElement?.closest(".palette")) {
      previouslyFocused.current =
        activeElement && activeElement !== document.body
          ? activeElement
          : document.querySelector<HTMLElement>(".search-trigger");
    }
    searchInputRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePalette();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closePalette, open]);

  if (!open) return null;
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("Command palette")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input">
          <MagnifyingGlass size={20} aria-hidden="true" />
          <input
            ref={searchInputRef}
            aria-label={t("Search tasks and Dashboard surfaces")}
            aria-controls="command-palette-results"
            placeholder={t("Find a task or jump to a surface")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusResult(0);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusResult(itemCount - 1);
              }
            }}
          />
          <button type="button" onClick={closePalette} aria-label={t("Close command palette")}>
            <X size={18} />
          </button>
        </div>
        <div className="palette-results" id="command-palette-results" aria-live="polite">
          <span className="eyebrow">{query ? t("Matching tasks") : t("Quick jumps")}</span>
          {query ? (
            results.length ? (
              results.map((task, index) => (
                <button
                  key={task.id}
                  ref={(element) => {
                    resultRefs.current[index] = element;
                  }}
                  type="button"
                  onKeyDown={(event) => handleResultKeyDown(event, index)}
                  onClick={() => {
                    setPage("tasks");
                    setSelectedTaskId(task.id);
                    closePalette();
                  }}
                >
                  <span>
                    <strong>{task.title}</strong>
                    <small>
                      {task.id} · {task.status}
                    </small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))
            ) : (
              <div className="empty-state">
                <strong>{t("No matching tasks")}</strong>
                <span>{t("Search by title, description, ID, status, or owner.")}</span>
              </div>
            )
          ) : (
            pages.map((entry, index) => (
              <button
                key={entry.page}
                ref={(element) => {
                  resultRefs.current[index] = element;
                }}
                type="button"
                onKeyDown={(event) => handleResultKeyDown(event, index)}
                onClick={() => {
                  setPage(entry.page);
                  closePalette();
                }}
              >
                <strong>{entry.title}</strong>
                <ArrowRight size={16} />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
