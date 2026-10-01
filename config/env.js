// This file's only job is to load .env as early as possible.
// Import it FIRST in server.js (and any entry script) — before any other
// local imports — so env vars are available when those modules load,
// since ES modules execute all their imports before the importing file's
// own body runs.
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// backend/.env, located relative to THIS file, so it is found no matter which
// folder the command is run from (e.g. `node backend/server.js` from the project
// root, or a script started from somewhere else).
//
// Variables already set by the host (Render, Docker, your shell) are never
// overridden, and on a host without a .env file this simply does nothing.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env"), quiet: true });