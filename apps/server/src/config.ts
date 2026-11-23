export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  cookieSecure: boolean;
  compileUrl: string;
  /** Write a snapshot (and trim the op log) after this many new ops on a file. */
  snapshotEvery: number;
  /** Unload a file from memory this long after the last editor left. */
  idleUnloadMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? "dev-only-secret-change-me";
  if (env.NODE_ENV === "production" && jwtSecret.startsWith("dev-only")) {
    throw new Error("Set JWT_SECRET in production");
  }
  return {
    port: Number(env.PORT ?? 8001),
    databaseUrl: env.DATABASE_URL ?? "postgres://weave:weave@localhost:5434/weave",
    jwtSecret,
    cookieSecure: env.COOKIE_SECURE === "true",
    compileUrl: env.COMPILE_URL ?? "http://localhost:7000",
    snapshotEvery: Number(env.SNAPSHOT_EVERY ?? 300),
    idleUnloadMs: Number(env.IDLE_UNLOAD_MS ?? 60_000),
  };
}
