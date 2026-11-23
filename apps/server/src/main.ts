import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);

// Wait for Postgres (docker compose may start us first).
for (let attempt = 1; ; attempt++) {
  try {
    await db.query("SELECT 1");
    break;
  } catch (err) {
    if (attempt >= 30) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const applied = await migrate(db);
const { app } = await buildApp(db, config, { logger: true });
if (applied.length) app.log.info({ applied }, "migrations applied");
await app.listen({ port: config.port, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal}: saving open documents`);
    void app.close().then(() => db.end()).then(() => process.exit(0));
  });
}
