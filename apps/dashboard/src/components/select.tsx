import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import clsx from "clsx";
import { t } from "../i18n.js";
import "./select.css";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  hideLabel?: boolean;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  testId?: string;
  popupClassName?: string;
}

type PopupPosition = CSSProperties & {
  "--select-accent"?: string;
  "--select-accent-soft"?: string;
};

function firstEnabled(options: SelectOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabled(options: SelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function nextEnabled(options: SelectOption[], current: number, delta: 1 | -1): number {
  if (!options.length) return -1;
  for (let distance = 1; distance <= options.length; distance += 1) {
    const index = (current + delta * distance + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function Select({
  label,
  value,
  options,
  onChange,
  className,
  disabled = false,
  hideLabel = false,
  placeholder = t("Select"),
  hint,
  error,
  testId,
  popupClassName,
}: SelectProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const unavailable = disabled || firstEnabled(options) < 0;
  const [open, setOpen] = useState(false);
  const [popupPosition, setPopupPosition] = useState<PopupPosition>({});
  const [activeIndex, setActiveIndex] = useState(() =>
    selectedIndex >= 0 ? selectedIndex : firstEnabled(options),
  );
  const labelId = `${id}-label`;
  const listboxId = `${id}-listbox`;
  const valueId = `${id}-value`;
  const hintId = hint || error ? `${id}-hint` : undefined;
  const portalHost = rootRef.current?.closest("dialog[open]") ?? document.body;
  const updatePopupPosition = () => {
    const trigger = triggerRef.current;
    const root = rootRef.current;
    if (!trigger || !root) return;
    const rect = trigger.getBoundingClientRect();
    const edge = 8;
    const gap = 6;
    const preferredWidth =
      popupClassName === "project-picker-popup"
        ? 300
        : popupClassName === "console-field-popup"
          ? Math.max(200, rect.width)
          : rect.width;
    const width = Math.min(preferredWidth, window.innerWidth - edge * 2);
    const left = Math.min(Math.max(edge, rect.left), window.innerWidth - width - edge);
    const below = window.innerHeight - rect.bottom - gap - edge;
    const above = rect.top - gap - edge;
    const opensUp = below < 180 && above > below;
    const available = Math.max(80, opensUp ? above : below);
    const computed = getComputedStyle(root);
    setPopupPosition({
      position: "fixed",
      left,
      right: "auto",
      top: opensUp ? "auto" : rect.bottom + gap,
      bottom: opensUp ? window.innerHeight - rect.top + gap : "auto",
      width,
      maxHeight: Math.min(310, available),
      "--select-accent": computed.getPropertyValue("--select-accent"),
      "--select-accent-soft": computed.getPropertyValue("--select-accent-soft"),
    });
  };

  useLayoutEffect(() => {
    if (open) updatePopupPosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popupRef.current?.contains(target)) setOpen(false);
    };
    const reposition = () => updatePopupPosition();
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);

  const focusOption = (index: number) => {
    if (index < 0) return;
    setActiveIndex(index);
    optionRefs.current[index]?.focus();
  };

  const openAt = (index: number) => {
    if (unavailable) return;
    const nextIndex = index >= 0 && !options[index]?.disabled ? index : firstEnabled(options);
    setActiveIndex(nextIndex);
    setOpen(true);
    requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const commit = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (unavailable) return;
    if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Home") openAt(firstEnabled(options));
      else if (event.key === "End") openAt(lastEnabled(options));
      else if (event.key === "ArrowUp") {
        openAt(selectedIndex >= 0 ? selectedIndex : lastEnabled(options));
      } else {
        openAt(selectedIndex >= 0 ? selectedIndex : firstEnabled(options));
      }
    }
  };

  return (
    <div
      className={clsx("custom-select", open && "is-open", error && "has-error", className)}
      ref={rootRef}
      data-testid={testId}
    >
      <span id={labelId} className={clsx("custom-select-label", hideLabel && "sr-only")}>
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className="custom-select-trigger"
        aria-labelledby={`${labelId} ${valueId}`}
        aria-describedby={hintId}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        disabled={unavailable}
        onClick={() => (open ? close() : openAt(selectedIndex))}
        onKeyDown={onTriggerKeyDown}
      >
        <span
          id={valueId}
          className={clsx("custom-select-value", !selected && "is-placeholder")}
          title={selected?.label ?? placeholder}
        >
          {selected?.label ?? placeholder}
        </span>
        <CaretDown className="custom-select-caret" size={15} weight="bold" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={listboxId}
            className={clsx("custom-select-list", "is-portal", popupClassName)}
            style={popupPosition}
            role="listbox"
            aria-labelledby={labelId}
          >
            {options.map((option, index) => (
              <button
                key={option.value}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                id={`${id}-option-${index}`}
                type="button"
                className={clsx("custom-select-option", index === activeIndex && "is-active")}
                role="option"
                tabIndex={index === activeIndex ? 0 : -1}
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                disabled={option.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(option)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    close(true);
                  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    focusOption(nextEnabled(options, index, event.key === "ArrowDown" ? 1 : -1));
                  } else if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    focusOption(
                      event.key === "Home" ? firstEnabled(options) : lastEnabled(options),
                    );
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    commit(option);
                  } else if (event.key === "Tab") {
                    triggerRef.current?.focus();
                    setOpen(false);
                  }
                }}
              >
                <span className="custom-select-option-copy">
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
                <Check className="custom-select-check" size={15} weight="bold" aria-hidden="true" />
              </button>
            ))}
          </div>,
          portalHost,
        )}
      {(hint || error) && (
        <span
          id={hintId}
          className={clsx("custom-select-hint", error && "is-error")}
          role={error ? "alert" : undefined}
        >
          {error ?? hint}
        </span>
      )}
    </div>
  );
}
