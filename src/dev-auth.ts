import type { CatalogStore } from "./catalog.js";

export function seedDevAuthUsers(catalog: CatalogStore, authEnabled: boolean, isProduction: boolean): void {
  if (!authEnabled || isProduction || !process.env.AGENTMOM_DEV_AUTH_PASSWORD) return;

  const seedUsers =
    process.env.AGENTMOM_DEV_AUTH_USERS ??
    (process.env.AGENTMOM_DEV_AUTH_EMAIL
      ? `${process.env.AGENTMOM_DEV_AUTH_EMAIL}|${process.env.AGENTMOM_DEV_AUTH_NAME ?? "Local Admin"}|admin`
      : "");

  for (const rawUser of seedUsers.split(",")) {
    const [email, fullName, rawRole] = rawUser.split("|").map((part) => part.trim());
    if (!email) continue;
    const role: "admin" | "user" = rawRole === "user" ? "user" : "admin";
    catalog.ensureSeedUser({
      email,
      fullName: fullName || email,
      password: process.env.AGENTMOM_DEV_AUTH_PASSWORD,
      role
    });
  }
}
