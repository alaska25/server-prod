// This file's only job is to load .env as early as possible.
// Import it FIRST in server.js (and any entry script) — before any other
// local imports — so env vars are available when those modules load,
// since ES modules execute all their imports before the importing file's
// own body runs.
import dotenv from "dotenv";
dotenv.config();