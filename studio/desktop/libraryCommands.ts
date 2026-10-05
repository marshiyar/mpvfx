import { dialog, shell } from "electron";
import { basename, extname } from "node:path";
import type { LibraryCommand, LibraryResult } from "../shared/library/library";
import type { LibraryService } from "../runtime/index";
import type { StudioRuntime } from "../runtime/index";

export async function dispatchLibraryCommand(
  service: LibraryService,
  runtime: StudioRuntime,
  command: LibraryCommand,
): Promise<LibraryResult> {
  if (!command || typeof command.type !== "string")
    throw new Error("Invalid library command");
  let projectId: string | undefined;
  let path: string | undefined;
  const errors: string[] = [];
  switch (command.type) {
    case "list":
      break;
    case "create": {
      const selected = await dialog.showSaveDialog({
        title: "Create Library",
        defaultPath: "Untitled.mpvfxlibrary",
        buttonLabel: "Create Library",
        filters: [{ name: "MpVFX Library", extensions: ["mpvfxlibrary"] }],
      });
      if (!selected.canceled && selected.filePath) {
        const root = selected.filePath.endsWith(".mpvfxlibrary")
          ? selected.filePath
          : `${selected.filePath}.mpvfxlibrary`;
        const libraryId = await service.create(root);
        const view = (await service.views()).find((l) => l.id === libraryId)!;
        projectId = await service.createProject(
          libraryId,
          view.events[0]!.id,
          "Untitled Project",
        );
      }
      break;
    }
    case "open": {
      const selected = await dialog.showOpenDialog({
        title: "Open Library",
        properties: ["openDirectory", "treatPackageAsDirectory"],
      });
      if (!selected.canceled && selected.filePaths[0]) {
        const libraryId = await service.open(selected.filePaths[0]);
        projectId = (await service.views())
          .find((l) => l.id === libraryId)
          ?.projects.find((p) => p.state === "ready")?.id;
      }
      break;
    }
    case "event":
      await service.createEvent(command.libraryId, command.name);
      break;
    case "project":
      projectId = await service.createProject(
        command.libraryId,
        command.eventId,
        command.name,
      );
      break;
    case "import": {
      if (!["managed", "linked"].includes(command.mode))
        throw new Error("Invalid import mode");
      const selected = await dialog.showOpenDialog({
        title:
          command.mode === "linked"
            ? "Link Media"
            : "Import Media into Library",
        properties: ["openFile", "multiSelections"],
      });
      if (!selected.canceled) {
        const operation = () =>
          service.import(
            command.libraryId,
            command.eventId,
            selected.filePaths,
            command.mode,
            command.projectId,
          );
        const result = command.projectId
          ? await runtime.withProject(command.projectId, operation)
          : await operation();
        errors.push(...result.invalid.map((e) => `${e.name}: ${e.reason}`));
      }
      break;
    }
    case "attach":
      path = await runtime.withProject(command.projectId, () =>
        service.attach(command.libraryId, command.projectId, command.assetId),
      );
      break;
    case "relink": {
      const selected = await dialog.showOpenDialog({
        title: "Locate Original Media",
        properties: ["openFile"],
      });
      if (!selected.canceled && selected.filePaths[0])
        await service.relink(
          command.libraryId,
          command.assetId,
          selected.filePaths[0],
        );
      break;
    }
    case "reveal":
      await shell.openPath(service.root(command.libraryId));
      break;
    case "saveOutput": {
      const job = (await service.views())
        .find((l) => l.id === command.libraryId)
        ?.jobs.find((j) => j.id === command.jobId);
      if (!job || job.status !== "complete")
        throw new Error("Export is not complete");
      const selected = await dialog.showSaveDialog({
        title: "Save Export As",
        defaultPath: basename(job.output),
        filters: [
          {
            name: "Rendered media",
            extensions: [extname(job.output).slice(1)],
          },
        ],
      });
      if (!selected.canceled && selected.filePath)
        await service.saveOutput(
          command.libraryId,
          command.jobId,
          selected.filePath,
          true, // The native save dialog already handles the user's Replace decision.
        );
      break;
    }
    default:
      throw new Error("Unknown library command");
  }
  return { libraries: await service.views(), projectId, path, errors };
}
