import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { buildServices } from "./services.ts";

const cfg = loadConfig();
const services = buildServices(cfg);
const app = await buildApp(services);

services.jobs.start(cfg.JOB_POLL_INTERVAL_MS);
const sweeper = setInterval(() => services.sessions.purgeExpired(), 15 * 60_000);
sweeper.unref();

app.log.info(
  { auth: cfg.AUTH_MODE, sharepoint: services.repo.mode, sharepointSimulated: services.repo.simulated, assistant: services.provider.id },
  "integration modes",
);

const shutdown = async () => {
  services.jobs.stop();
  await app.close();
  services.db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: cfg.PORT, host: cfg.HOST });
