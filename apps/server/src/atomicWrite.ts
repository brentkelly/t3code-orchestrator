import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

// T3o: mode-preserving (0600 default), fsynced temp write + directory sync (#139).
import { syncDirectory, writePrivateTempFile } from "./privateStateFiles.ts";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      // T3o: was `fs.writeFileString`, which created the temp file at 0644 and never
      // fsynced it, so the rename widened a 0600 target and was not crash-durable (#139).
      yield* writePrivateTempFile({
        tempPath,
        targetPath: input.filePath,
        contents: input.contents,
      });
      yield* fs.rename(tempPath, input.filePath);
      // T3o: make the rename itself durable (#139).
      yield* syncDirectory(targetDirectory);
    }),
  );
