import type { useFileManager } from "../hooks/useFileManager";
import { useContext, type ReactNode } from "react";
import { createStableContext } from "../utils/hmrStableContext";

type FileManagerValue = ReturnType<typeof useFileManager>;

const FileManagerContext = createStableContext<FileManagerValue | null>("FileManagerContext", null);

export function useFileManagerContext(): FileManagerValue {
  const ctx = useContext(FileManagerContext);
  if (!ctx) throw new Error("useFileManagerContext must be used within FileManagerProvider");
  return ctx;
}

export function useFileManagerContextOptional(): FileManagerValue | null {
  return useContext(FileManagerContext);
}

export function FileManagerProvider({
  value,
  children,
}: {
  value: FileManagerValue;
  children: ReactNode;
}) {
  return <FileManagerContext value={value}>{children}</FileManagerContext>;
}
