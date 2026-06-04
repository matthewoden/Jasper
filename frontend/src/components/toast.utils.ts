/**
 * Toast context + consumer hook. Extracted from Toast.tsx so the
 * component file only exports React components — satisfies
 * react-refresh/only-export-components and restores Fast Refresh DX for
 * the toast provider/viewport rendering.
 *
 * Toast.tsx (ToastProvider) imports ToastCtx from here and provides
 * the value; consumers anywhere in the tree call useToast() from here.
 */
import { createContext, useContext } from "react";

export type ToastOptions = {
  title: string;
  description?: string;
  variant?: "error" | "info";
  durationMs?: number;
};

export interface ToastApi {
  toast: (opts: ToastOptions) => void;
}

export const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}
