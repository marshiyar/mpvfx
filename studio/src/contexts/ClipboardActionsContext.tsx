import { createContext, useContext, type ReactNode } from "react";
export interface ClipboardActions {
  copy: () => boolean;
  cut: () => Promise<boolean>;
  paste: () => Promise<void>;
  duplicate: () => Promise<void>;
  selectAll: () => void;
}
const Context = createContext<ClipboardActions | null>(null);
export const useClipboardActions = () => useContext(Context);
export function ClipboardActionsProvider({
  value,
  children,
}: {
  value: ClipboardActions;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
