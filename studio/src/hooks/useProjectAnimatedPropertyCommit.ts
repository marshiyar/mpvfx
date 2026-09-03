import { useCallback, useRef } from "react";

import type { DomEditSelection } from "../components/editor/domEditingTypes";
import {
  type NativeProjectKeyframeFailure,
} from "../project/nativeProjectKeyframeCommands";
import { applyNativeProjectPropertyCommand } from "../project/nativeProjectPropertyCommands";
import type { NativeProjectDocument } from "../project/nativeProjectDocument";
import {
  createNativeProjectRepository,
  NativeProjectRevisionConflictError,
  type NativeProjectHistoryEntry,
} from "../project/nativeProjectPersistence";
import {
  planNativePropertyEdit,
  resolveNativeClipSelection,
  type NativePropertyEditPlanFailure,
} from "../project/nativePropertyEditPlan";
import { synchronizeIncomingNativeDocument } from "../project/nativeDocumentRefSync";
import type { CommitNativeTimelineFileTransaction } from "../project/nativeTimelineTransactionCommit";
import { readNativePropertyBaselines } from "../project/nativePropertyBaseline";

export type ProjectAnimatedPropertyCommitRoute = "native" | "legacy";
export type ProjectAnimatedPropertyCommitIntent = "edit" | "keyframe";

export interface ProjectAnimatedPropertyCommitOptions {
  readonly intent?: ProjectAnimatedPropertyCommitIntent;
}

export interface UseProjectAnimatedPropertyCommitOptions {
  readonly nativeDocument: NativeProjectDocument | null;
  /** Safe, fully validated candidate used only when persistence confirms no sidecar exists. */
  readonly nativeBootstrapDocument?: NativeProjectDocument | null;
  readonly readOptionalProjectFile: (path: string) => Promise<string | null | undefined>;
  readonly writeProjectFile: (
    path: string,
    content: string,
    expectedContent?: string,
  ) => Promise<void>;
  readonly recordHistory?: (entry: NativeProjectHistoryEntry) => Promise<void> | void;
  readonly commitFileTransaction?: CommitNativeTimelineFileTransaction;
  readonly onNativeDocumentCommitted?: (document: NativeProjectDocument) => void;
  readonly getPlayheadSeconds: () => number;
  /** Read at commit time so a queued gesture obeys the current editor mode. */
  readonly getAutoKeyframeEnabled?: () => boolean;
  readonly legacyCommitProperties: (
    selection: DomEditSelection,
    properties: Record<string, number | string>,
  ) => Promise<void>;
}

export interface ProjectAnimatedPropertyCommitApi {
  isNativeSelection(selection: DomEditSelection): boolean;
  commitAnimatedProperty(
    selection: DomEditSelection,
    property: string,
    value: number | string,
    options?: ProjectAnimatedPropertyCommitOptions,
  ): Promise<ProjectAnimatedPropertyCommitRoute>;
  commitAnimatedProperties(
    selection: DomEditSelection,
    properties: Record<string, number | string>,
    options?: ProjectAnimatedPropertyCommitOptions,
  ): Promise<ProjectAnimatedPropertyCommitRoute>;
}

type RoutingFailure = NativePropertyEditPlanFailure | NativeProjectKeyframeFailure;

export class NativeProjectEditRoutingError extends Error {
  readonly failure: RoutingFailure;

  constructor(failure: RoutingFailure) {
    super(failure.message);
    this.name = "NativeProjectEditRoutingError";
    this.failure = failure;
  }
}

const LEGACY_FALLBACK_CODES = new Set<NativePropertyEditPlanFailure["code"]>([
  "missing-selection-id",
  "clip-not-found",
  "unsupported-property",
]);

function selectionReference(selection: DomEditSelection) {
  const clipId = selection.element.getAttribute("data-studio-clip-id");
  return {
    id: selection.id ?? selection.element.id ?? null,
    hfId: selection.hfId ?? selection.element.getAttribute("data-hf-id"),
    sourceFile: selection.sourceFile ?? null,
    selector: selection.selector ?? null,
    selectorIndex: selection.selectorIndex ?? null,
    attributes: { "data-studio-clip-id": clipId },
    dataset: { studioClipId: selection.element.dataset.studioClipId ?? null },
  };
}

function documentOwnsSelection(
  document: NativeProjectDocument | null,
  selection: DomEditSelection,
): boolean {
  if (!document) return false;
  return resolveNativeClipSelection(document, selectionReference(selection)).ok;
}

function editLabel(
  properties: Readonly<Record<string, number | string>>,
  intent: ProjectAnimatedPropertyCommitIntent,
): string {
  const names = Object.keys(properties);
  const subject = names.length === 1 ? names[0] : `${names.length} properties`;
  return intent === "keyframe" ? `Keyframe ${subject}` : `Edit ${subject}`;
}

/**
 * Project-level property router.
 *
 * The native document is authoritative when an exact clip binding and a fully
 * supported atomic edit exist. The legacy callback remains an all-or-nothing
 * compatibility fallback; a batch can never write both authorities.
 */
export function useProjectAnimatedPropertyCommit(
  options: UseProjectAnimatedPropertyCommitOptions,
): ProjectAnimatedPropertyCommitApi {
  const latestDocumentRef = useRef<NativeProjectDocument | null>(options.nativeDocument);
  const incomingDocumentRef = useRef<NativeProjectDocument | null>(options.nativeDocument);
  synchronizeIncomingNativeDocument(
    incomingDocumentRef,
    latestDocumentRef,
    options.nativeDocument,
  );

  const dependenciesRef = useRef(options);
  dependenciesRef.current = options;
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const commitAnimatedProperties = useCallback(
    (
      selection: DomEditSelection,
      properties: Record<string, number | string>,
      commitOptions: ProjectAnimatedPropertyCommitOptions = {},
    ): Promise<ProjectAnimatedPropertyCommitRoute> => {
      const run = queueRef.current.then(async (): Promise<ProjectAnimatedPropertyCommitRoute> => {
        const dependencies = dependenciesRef.current;
        const persistedDocument = latestDocumentRef.current;
        const document = persistedDocument ?? dependencies.nativeBootstrapDocument ?? null;
        if (!document) {
          await dependencies.legacyCommitProperties(selection, properties);
          return "legacy";
        }

        const request = {
          selectedElement: selectionReference(selection),
          playheadSeconds: dependencies.getPlayheadSeconds(),
          properties,
          selectionBounds: {
            width: selection.boundingBox.width,
            height: selection.boundingBox.height,
          },
          propertyBaselines: readNativePropertyBaselines({
            computedStyles: selection.computedStyles,
            boundingBox: selection.boundingBox,
          }),
          intent: commitOptions.intent ?? "edit",
          autoKeyframeEnabled: dependencies.getAutoKeyframeEnabled?.() ?? false,
        } as const;
        const initialPlan = planNativePropertyEdit(document, request);
        if (!initialPlan.ok) {
          if (LEGACY_FALLBACK_CODES.has(initialPlan.failure.code)) {
            await dependencies.legacyCommitProperties(selection, properties);
            return "legacy";
          }
          throw new NativeProjectEditRoutingError(initialPlan.failure);
        }

        const repository = createNativeProjectRepository({
          readOptionalProjectFile: dependencies.readOptionalProjectFile,
          writeProjectFile: dependencies.writeProjectFile,
          recordHistory: dependencies.recordHistory,
          commitFileTransaction: dependencies.commitFileTransaction,
        });
        const intent = request.intent;
        const applyPlannedEdit = (draft: NativeProjectDocument): NativeProjectDocument => {
          // Re-plan against the exact bytes the repository just read so a
          // valid concurrent revision cannot redirect a stale clip address.
          const plan = planNativePropertyEdit(draft, request);
          if (!plan.ok) throw new NativeProjectEditRoutingError(plan.failure);
          const result = applyNativeProjectPropertyCommand(draft, plan.command);
          if (!result.ok) throw new NativeProjectEditRoutingError(result.failure);
          return result.document;
        };
        const label = editLabel(properties, intent);
        let committed;
        try {
          committed = persistedDocument
            ? await repository.transaction(
                { expectedRevision: persistedDocument.revision, label },
                applyPlannedEdit,
              )
            : await repository.save(applyPlannedEdit(document), {
                expectedRevision: null,
                label,
              });
        } catch (error) {
          if (!(error instanceof NativeProjectRevisionConflictError)) throw error;
          const latest = await repository.load();
          if (!latest || latest.document.id !== document.id) throw error;
          latestDocumentRef.current = latest.document;
          committed = await repository.transaction(
            { expectedRevision: latest.document.revision, label },
            applyPlannedEdit,
          );
        }
        latestDocumentRef.current = committed.document;
        dependencies.onNativeDocumentCommitted?.(committed.document);
        return "native";
      });
      queueRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [],
  );

  const commitAnimatedProperty = useCallback(
    (
      selection: DomEditSelection,
      property: string,
      value: number | string,
      commitOptions?: ProjectAnimatedPropertyCommitOptions,
    ) => commitAnimatedProperties(selection, { [property]: value }, commitOptions),
    [commitAnimatedProperties],
  );

  const isNativeSelection = useCallback(
    (selection: DomEditSelection) => {
      const document =
        latestDocumentRef.current ?? dependenciesRef.current.nativeBootstrapDocument ?? null;
      return documentOwnsSelection(document, selection);
    },
    [],
  );

  return { isNativeSelection, commitAnimatedProperty, commitAnimatedProperties };
}
