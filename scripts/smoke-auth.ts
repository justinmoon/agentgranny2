import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";

const root = mkdtempSync(join(tmpdir(), "agentmom-auth-"));

process.env.AGENTMOM_AUTH_ENABLED = "1";
process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_WORKSPACE_ROOT = join(root, "workspace-root");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "local";

try {
  const catalog = new CatalogStore(loadConfig());

  const dev = catalog.ensureDevUser();
  assert.equal(dev.user.email, "dev@agentmom.local");
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

  const adminUser = catalog.currentUser(`agentmom_session=${admin.token}`)!;
  const invite = catalog.createInvite(adminUser, { label: "team", role: "user" });
  assert.match(invite.code, /^[a-z0-9]{4}$/);
  assert.equal(catalog.read().invites[0].code, invite.code);
  assert.equal(catalog.invites(adminUser)[0].code, invite.code);
  const adminInvite = catalog.createInvite(adminUser, { label: "admins", role: "admin" });
  const lookalikeInvite = catalog.createInvite(adminUser, { label: "Access code", role: "user" });

  const userOne = catalog.signup({
    email: "user1@example.com",
    fullName: "User One",
    password: "password123",
    inviteCode: invite.code.toUpperCase()
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

  const legacyAccessData = catalog.read();
  legacyAccessData.invites.push({
    id: "legacy-access",
    code: "mom-legacy-access",
    label: "Access code",
    role: "user",
    usedCount: 0,
    active: true,
    createdByUserId: adminUser.id,
    createdAt: Math.floor(Date.now() / 1000)
  });
  catalog.write(legacyAccessData);

  const accessCode = catalog.accessCode(adminUser);
  assert.match(accessCode.code, /^[a-z0-9]{4}$/);
  assert.equal(accessCode.label, "Access code");
  assert.equal(accessCode.role, "user");
  assert.notEqual(accessCode.code, invite.code);
  assert.notEqual(accessCode.code, adminInvite.code);
  assert.notEqual(accessCode.code, lookalikeInvite.code);
  assert.equal(catalog.accessCode(adminUser).id, accessCode.id);
  assert.equal(catalog.read().invites.find((candidate) => candidate.id === "legacy-access")?.active, false);

  const accessUser = catalog.signup({
    email: "access@example.com",
    fullName: "Access User",
    password: "password123",
    inviteCode: accessCode.code
  });
  assert.equal(accessUser.user.role, "user");
  assert.equal(accessUser.user.inviteId, accessCode.id);

  const regeneratedAccessCode = catalog.regenerateAccessCode(adminUser);
  assert.match(regeneratedAccessCode.code, /^[a-z0-9]{4}$/);
  assert.notEqual(regeneratedAccessCode.id, accessCode.id);
  const afterRegenerate = catalog.read();
  assert.equal(afterRegenerate.invites.find((candidate) => candidate.id === accessCode.id)?.active, false);
  assert.equal(afterRegenerate.invites.find((candidate) => candidate.id === invite.invite.id)?.active, true);
  assert.equal(afterRegenerate.invites.find((candidate) => candidate.id === adminInvite.invite.id)?.active, true);
  assert.equal(afterRegenerate.invites.find((candidate) => candidate.id === lookalikeInvite.invite.id)?.active, true);

  const legacyData = catalog.read();
  legacyData.invites.push({
    id: "legacy-invite",
    code: "mom-AbCd1234",
    label: "legacy",
    role: "user",
    usedCount: 0,
    active: true,
    createdByUserId: adminUser.id,
    createdAt: Math.floor(Date.now() / 1000)
  });
  catalog.write(legacyData);
  const legacyUser = catalog.signup({
    email: "legacy@example.com",
    fullName: "Legacy User",
    password: "password123",
    inviteCode: "mom-AbCd1234"
  });
  assert.equal(legacyUser.user.role, "user");

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

  const normalUser = catalog.currentUser(`agentmom_session=${userOne.token}`)!;
  assert.throws(() => catalog.createInvite(normalUser, { role: "user" }), /admin required/);
  assert.throws(() => catalog.setUserRole(adminUser, adminUser.id, "user"), /you cannot change your own role/);
  assert.equal(catalog.setUserRole(adminUser, normalUser.id, "admin").role, "admin");
  assert.equal(catalog.login({ email: "user1@example.com", password: "password123" }).user.role, "admin");

  const seed = catalog.ensureSeedUser({
    email: "admin@bitcoin.com",
    fullName: "Admin User",
    password: "password",
    role: "admin"
  });
  assert.equal(seed.user.email, "admin@bitcoin.com");
  assert.equal(catalog.login({ email: "admin@bitcoin.com", password: "password" }).user.role, "admin");

  const secondSeed = catalog.ensureSeedUser({
    email: "user@bitcoin.com",
    fullName: "Normal User",
    password: "password",
    role: "user"
  });
  assert.equal(secondSeed.user.email, "user@bitcoin.com");
  assert.equal(catalog.login({ email: "user@bitcoin.com", password: "password" }).user.role, "user");

  console.log("auth smoke ok");
} finally {
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(root, { recursive: true, force: true });
  }
}
