// The entry module the frame shell imports. `npm run build` bundles it, with the
// SDK's browser build inside, into the main.mjs at the repository root.
import { createPlugin } from "./plugin.ts";

await createPlugin().run();
