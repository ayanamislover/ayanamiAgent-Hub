import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FolderOpen, Plus, Robot, X } from "@phosphor-icons/react";
import type { RegisteredProject } from "@crossagent/client";
import { hub } from "../api.js";
import { useUi } from "../store.js";
import { t } from "../i18n.js";

function ProjectRegistrationForm({ onRegistered }: { onRegistered?: (projectId: string) => void }) {
  const [path, setPath] = useState("");
  const queryClient = useQueryClient();
  const setProjectId = useUi((state) => state.setProjectId);
  const register = useMutation({
    mutationFn: () =>
      hub.joinProject({
        cwd: path.trim(),
        allowCreate: true,
      }),
    onSuccess: async ({ project }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectId(project.id);
      setPath("");
      onRegistered?.(project.id);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (path.trim()) register.mutate();
  };
  return (
    <form className="project-register-form" onSubmit={submit} aria-busy={register.isPending}>
      <label htmlFor="project-directory">{t("Local project directory")}</label>
      <p id="project-directory-help">
        {t(
          "Enter an existing folder once. The Hub stores its stable UUID and path for future Agent sessions.",
        )}
      </p>
      <div className="project-path-entry">
        <FolderOpen size={20} />
        <input
          id="project-directory"
          aria-describedby="project-directory-help"
          value={path}
          onChange={(event) => {
            setPath(event.target.value);
            register.reset();
          }}
          placeholder="C:\Projects\my-project"
          spellCheck={false}
          autoComplete="off"
        />
        <button
          className="primary-button"
          type="submit"
          disabled={!path.trim() || register.isPending}
        >
          <Plus size={17} weight="bold" />
          {register.isPending ? t("Registering…") : t("Register project")}
        </button>
      </div>
      {register.error && (
        <span className="project-register-error" role="alert">
          {register.error.message}
        </span>
      )}
      {register.isPending && (
        <span className="muted" role="status" aria-live="polite">
          {t("Validating and registering this directory…")}
        </span>
      )}
    </form>
  );
}

export function ProjectOnboarding() {
  return (
    <div className="project-onboarding">
      <div className="project-onboarding-card">
        <div className="brand-mark large">
          <Robot size={30} weight="duotone" />
        </div>
        <span className="eyebrow">{t("Project registry")}</span>
        <h1>{t("Register your first workspace")}</h1>
        <p>
          {t(
            "Projects stay in this Dashboard. Codex and other Agents can reconnect using the stable project UUID instead of asking for the directory every time.",
          )}
        </p>
        <ProjectRegistrationForm />
      </div>
    </div>
  );
}

export function ProjectManagerDialog({
  open,
  projects,
  activeProjectId,
  onClose,
}: {
  open: boolean;
  projects: RegisteredProject[];
  activeProjectId: string | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const setProjectId = useUi((state) => state.setProjectId);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setCopiedId(null);
      setCopyError("");
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const copyId = async (projectId: string) => {
    try {
      await navigator.clipboard.writeText(projectId);
      setCopyError("");
      setCopiedId(projectId);
      window.setTimeout(
        () => setCopiedId((current) => (current === projectId ? null : current)),
        1200,
      );
    } catch (error) {
      setCopiedId(null);
      setCopyError(error instanceof Error ? error.message : t("Clipboard access was denied."));
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="project-manager-dialog"
      aria-labelledby="project-manager-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <header>
        <div>
          <span className="eyebrow">{t("Persistent workspaces")}</span>
          <h2 id="project-manager-title">{t("Project registry")}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t("Close project registry")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="project-manager-body">
        <div className="registered-projects" role="list" aria-label={t("Registered projects")}>
          {projects.map((project) => {
            const active = project.id === activeProjectId;
            return (
              <article
                className={active ? "registered-project active" : "registered-project"}
                key={project.id}
                role="listitem"
              >
                <button
                  type="button"
                  className="registered-project-select"
                  aria-current={active ? "true" : undefined}
                  aria-label={`${active ? t("Current project") : t("Switch to")} ${project.name}`}
                  onClick={() => {
                    setProjectId(project.id);
                    onClose();
                  }}
                >
                  <span className="registered-project-icon">
                    <FolderOpen size={20} weight={active ? "fill" : "regular"} />
                  </span>
                  <span>
                    <strong>{project.name}</strong>
                    <small title={project.paths[0]}>{project.paths[0] ?? t("No local path")}</small>
                  </span>
                  {active && <span className="current-project-label">{t("Active")}</span>}
                </button>
                <div className="registered-project-id" aria-live="polite">
                  <code>{project.id}</code>
                  <button
                    type="button"
                    className="icon-button compact"
                    aria-label={
                      copiedId === project.id
                        ? t("Copied UUID for {name}", { name: project.name })
                        : t("Copy UUID for {name}", { name: project.name })
                    }
                    onClick={() => void copyId(project.id)}
                  >
                    {copiedId === project.id ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
              </article>
            );
          })}
          {projects.length === 0 && (
            <div className="empty-state">
              <strong>{t("No registered projects")}</strong>
              <span>{t("Register a local directory below to create a stable project UUID.")}</span>
            </div>
          )}
        </div>
        {copyError && (
          <span className="project-register-error" role="alert">
            {t("Could not copy the project UUID: {error}", { error: copyError })}
          </span>
        )}
        <ProjectRegistrationForm onRegistered={onClose} />
      </div>
    </dialog>
  );
}
