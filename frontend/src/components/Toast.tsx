/**
 * Surface 5 chassis — Radix Toast provider + viewport + imperative helper.
 *
 * UI-SPEC §Surface 5 + §Forward-Compatibility Asserts: this provider is
 * mounted EXACTLY ONCE at App.tsx root. Phase 4 (deletion-in-another-session
 * toast — UX-05) and Phase 5 (stale-write conflict — SYNC-05) reuse it
 * without re-instantiating. The imperative `toast()` helper from useToast()
 * is callable from anywhere inside the provider tree.
 *
 * Phase 2 only fires error-variant toasts (via the variant default + the
 * logs-path-copied confirmation, which is rendered as the same single line
 * with the destructive border treatment). The "info" variant is reserved
 * but unused this phase.
 */

import * as Toast from "@radix-ui/react-toast";
import { AlertCircle, X } from "lucide-react";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: "error" | "info";
  durationMs?: number;
};

interface ToastEntry extends ToastOptions {
  id: number;
}

interface ToastApi {
  toast: (opts: ToastOptions) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const DEFAULT_DURATION_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const idCounter = useRef(0);

  const enqueue = useCallback((opts: ToastOptions) => {
    const id = ++idCounter.current;
    setItems((prev) => [...prev, { ...opts, id }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastCtx.Provider value={{ toast: enqueue }}>
      <Toast.Provider duration={DEFAULT_DURATION_MS} swipeDirection="right">
        {children}
        {items.map((item) => (
          <Toast.Root
            key={item.id}
            duration={item.durationMs ?? DEFAULT_DURATION_MS}
            onOpenChange={(open) => {
              if (!open) dismiss(item.id);
            }}
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              borderLeft: `4px solid var(${
                item.variant === "info"
                  ? "--color-accent"
                  : "--color-destructive"
              })`,
              borderRadius: 6,
              padding: "var(--spacing-md-tight) 16px",
              display: "flex",
              gap: 12,
              alignItems: "flex-start",
              maxWidth: 420,
              color: "var(--color-fg)",
              listStyle: "none",
            }}
          >
            <AlertCircle
              size={16}
              aria-hidden="true"
              style={{
                color:
                  item.variant === "info"
                    ? "var(--color-accent)"
                    : "var(--color-destructive)",
                flexShrink: 0,
                marginTop: 2,
              }}
            />
            <div style={{ flex: 1 }}>
              <Toast.Title
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--color-fg)",
                  lineHeight: 1.4,
                }}
              >
                {item.title}
              </Toast.Title>
              {item.description && (
                <Toast.Description
                  style={{
                    fontSize: 14,
                    color: "var(--color-muted)",
                    marginTop: 4,
                    lineHeight: 1.5,
                  }}
                >
                  {item.description}
                </Toast.Description>
              )}
            </div>
            <Toast.Close
              aria-label="Dismiss notification"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--color-muted)",
                cursor: "pointer",
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <X size={14} aria-hidden="true" />
            </Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport
          style={{
            position: "fixed",
            bottom: 16,
            right: 16,
            display: "flex",
            flexDirection: "column-reverse",
            gap: 8,
            maxWidth: 420,
            zIndex: 50,
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        />
      </Toast.Provider>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
