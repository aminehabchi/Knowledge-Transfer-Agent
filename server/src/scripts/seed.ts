import { existsSync, rmSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { seedDemoChats, seedSynthetic } from "../seed/synthetic.ts";
import { buildServices } from "../services.ts";

const cfg = loadConfig();
if (cfg.NODE_ENV === "production") throw new Error("Refusing to seed synthetic data in production.");
if (cfg.SHAREPOINT_MODE !== "mock") throw new Error("Seeding requires SHAREPOINT_MODE=mock.");

if (process.argv.includes("--reset") && cfg.DATABASE_PATH !== ":memory:") {
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(cfg.DATABASE_PATH + suffix)) rmSync(cfg.DATABASE_PATH + suffix);
}

const services = buildServices({ ...cfg, LOG_LEVEL: "warn" });

// `--chats`: add example assistant conversations to an already-seeded demo without resetting it.
if (process.argv.includes("--chats")) {
  if (!services.users.byEmail("lina.park@example.com")) {
    console.error("No synthetic demo data found. Run `npm run seed -- --reset` first.");
    process.exit(1);
  }
  const n = await seedDemoChats(services);
  console.log(n ? `Added ${n} demo assistant question(s) and answers.` : "Demo conversations already exist; nothing added.");
  services.db.close();
  process.exit(0);
}

if (services.db.prepare("SELECT COUNT(*) AS n FROM projects").get()!.n !== 0) {
  console.error("Database already contains data. Re-run with --reset to recreate the synthetic demo.");
  process.exit(1);
}
const result = await seedSynthetic(services, { chats: true });
console.log("Synthetic demo data created (mock SharePoint, fictional people):");
console.log(`  projects: ORION (${result.projects.orion}), VEGA (${result.projects.vega})`);
console.log(`  handover draft: ${result.handoverId}`);
console.log("  demo assistant conversations: Lina, Maya and Omar (ORION), Sam (VEGA)");
console.log("  demo users: maya.chen (manager), omar.haddad (outgoing), lina.park (incoming), theo.martin (admin), priya.nair, sam.rivera");
services.db.close();
