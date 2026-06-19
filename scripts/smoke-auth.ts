import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { workspaceConfig } from "../src/workspace-runtime.js";

const root = mkdtempSync(join(tmpdir(), "agentgranny2-auth-"));

process.env.AGENTGRANNY_AUTH_ENABLED = "1";
process.env.AGENTGRANNY_WORKSPACE = join(root, "workspace");
process.env.AGENTGRANNY_WORKSPACE_ROOT = join(root, "workspace-root");
process.env.AGENTGRANNY_STATE_DIR = join(root, "state");
process.env.AGENTGRANNY_EXECUTOR = "local";

try {
  const config = loadConfig();
  const catalog = new CatalogStore(config);

  const dev = catalog.ensureDevUser();
  assert.equal(dev.user.email, "dev@agentgranny.local");
  assert.equal(dev.workspace.id, "dev-workspace");

  const admin = catalog.signup({
    email: "admin@example.com",
    fullName: "Admin User",
    password: "password123"
  });
  assert.equal(admin.user.role, "admin");
  assert.equal(catalog.read().sessions[0].tokenHash === admin.token, false);

  assert.throws(
    () =>
      catalog.signup({
        email: "user@example.com",
        fullName: "Normal User",
        password: "password123"
      }),
    /invite code is required/
  );

  const adminUser = catalog.currentUser(`granny_session=${admin.token}`)!;
  const invite = catalog.createInvite(adminUser, { label: "team", role: "user" });
  assert.equal(catalog.read().invites[0].code, invite.code);
  assert.equal(catalog.invites(adminUser)[0].code, invite.code);

  const userOne = catalog.signup({
    email: "user1@example.com",
    fullName: "User One",
    password: "password123",
    inviteCode: invite.code
  });
  const userTwo = catalog.signup({
    email: "user2@example.com",
    fullName: "User Two",
    password: "password123",
    inviteCode: invite.code
  });
  assert.equal(userOne.user.role, "user");
  assert.equal(userTwo.user.inviteId, userOne.user.inviteId);
  assert.equal(catalog.invites(adminUser)[0].usedCount, 2);
  assert.equal(catalog.users(adminUser).some((user) => user.email === "user1@example.com" && user.invite?.code === invite.code), true);

  catalog.disableInvite(adminUser, invite.invite.id);
  assert.throws(
    () =>
      catalog.signup({
        email: "blocked@example.com",
        fullName: "Blocked User",
        password: "password123",
        inviteCode: invite.code
      }),
    /invite code is invalid/
  );

  const normalUser = catalog.currentUser(`granny_session=${userOne.token}`)!;
  assert.throws(() => catalog.createInvite(normalUser, { role: "user" }), /admin required/);

  const adminWorkspace = catalog.workspaceForUser(adminUser);
  const userWorkspace = catalog.workspaceForUser(normalUser);
  assert.equal(catalog.authorizeWorkspace(adminUser, userWorkspace.id).id, userWorkspace.id);
  assert.throws(() => catalog.authorizeWorkspace(normalUser, adminWorkspace.id), /forbidden/);

  const runtimeConfig = workspaceConfig(config, userWorkspace);
  assert.equal(runtimeConfig.workspace.startsWith(config.workspaceRoot), true);
  assert.equal(runtimeConfig.smolvm.name, userWorkspace.machineName);
  assert.equal(runtimeConfig.previewBasePath, `/w/${encodeURIComponent(userWorkspace.id)}/preview`);

  const seed = catalog.ensureSeedUser({
    email: "mail@justinmoon.com",
    fullName: "Justin Moon",
    password: "password",
    role: "admin"
  });
  assert.equal(seed.user.email, "mail@justinmoon.com");
  assert.equal(catalog.login({ email: "mail@justinmoon.com", password: "password" }).user.role, "admin");

  const secondSeed = catalog.ensureSeedUser({
    email: "autumndomingo@gmail.com",
    fullName: "Autumn Domingo",
    password: "password",
    role: "user"
  });
  assert.equal(secondSeed.user.email, "autumndomingo@gmail.com");
  assert.equal(catalog.login({ email: "autumndomingo@gmail.com", password: "password" }).user.role, "user");

  console.log("auth smoke ok");
} finally {
  if (process.env.AGENTGRANNY_KEEP_SMOKE !== "1") {
    rmSync(root, { recursive: true, force: true });
  }
}
