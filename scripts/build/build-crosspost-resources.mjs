import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const source = new URL("../../Crosspost/", import.meta.url);
const output = new URL("../../studio/.build/Crosspost/", import.meta.url);
mkdirSync(output, { recursive: true });
// Only contributor source is packaged; local credentials and OAuth tokens never are.
for (const name of ["gui.py", "UploadYoutube.py", "UploadFacebook.py", "requirements.txt", "README.md"]) {
  copyFileSync(fileURLToPath(new URL(name, source)), fileURLToPath(new URL(name, output)));
}
