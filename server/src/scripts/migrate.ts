import { loadConfig } from "../config.ts";
import { migrate, openDatabase } from "../db/database.ts";

const cfg = loadConfig();
const db = openDatabase(cfg.DATABASE_PATH);
const ran = migrate(db);
console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Database is up to date.");
db.close();
