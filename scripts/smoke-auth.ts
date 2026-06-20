import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogStore } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { DeploymentManager } from "../src/deployments.js";
import type { DeploymentRecord } from "../src/types.js";
import { workspaceConfig } from "../src/workspace-runtime.js";

const root = mkdtempSync(join(tmpdir(), "agentmom-auth-"));

process.env.AGENTMOM_AUTH_ENABLED = "1";
process.env.AGENTMOM_WORKSPACE = join(root, "workspace");
process.env.AGENTMOM_WORKSPACE_ROOT = join(root, "workspace-root");
process.env.AGENTMOM_STATE_DIR = join(root, "state");
process.env.AGENTMOM_EXECUTOR = "local";

try {
  const config = loadConfig();
  const catalog = new CatalogStore(config);

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

  const normalUser = catalog.currentUser(`agentmom_session=${userOne.token}`)!;
  assert.throws(() => catalog.createInvite(normalUser, { role: "user" }), /admin required/);

  const adminWorkspace = catalog.workspaceForUser(adminUser);
  const userWorkspace = catalog.workspaceForUser(normalUser);
  const adminRuntimeConfig = workspaceConfig(config, adminWorkspace);
  assert.equal(catalog.authorizeWorkspace(adminUser, userWorkspace.id).id, userWorkspace.id);
  assert.throws(() => catalog.authorizeWorkspace(normalUser, adminWorkspace.id), /forbidden/);

  const runtimeConfig = workspaceConfig(config, userWorkspace);
  assert.equal(runtimeConfig.workspace.startsWith(config.workspaceRoot), true);
  assert.equal(runtimeConfig.smolvm.name, userWorkspace.machineName);
  assert.equal(runtimeConfig.previewBasePath, `/w/${encodeURIComponent(userWorkspace.id)}/preview`);
  assert.equal(runtimeConfig.workspaceId, userWorkspace.id);

  const deploymentManager = new DeploymentManager(config);
  const stoppedDeployment = (slug: string, workspaceId?: string, projectPath = join(root, slug)): DeploymentRecord => ({
    id: slug,
    workspaceId,
    slug,
    name: slug,
    projectPath,
    image: `localhost/${slug}:test`,
    container: `container-${slug}`,
    containerPort: 3000,
    hostPort: 41000,
    urlPath: `/deploy/${slug}/`,
    status: "stopped",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  });
  mkdirSync(config.deploymentDir, { recursive: true });
  writeFileSync(
    join(config.deploymentDir, "deployments.json"),
    `${JSON.stringify(
      {
        deployments: [
          stoppedDeployment("legacy-global"),
          stoppedDeployment("legacy-user-deploy", undefined, join(runtimeConfig.projectsDir, "legacy-user-deploy")),
          stoppedDeployment("user-one-deploy", userWorkspace.id),
          stoppedDeployment("admin-deploy", adminWorkspace.id)
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const userDeployments = (
    await deploymentManager.list({
      workspaceId: userWorkspace.id,
      workspaceDirName: runtimeConfig.workspaceDirName
    })
  ).map((deployment) => deployment.slug);
  assert.equal(userDeployments.includes("legacy-user-deploy"), true);
  assert.equal(userDeployments.includes("legacy-global"), false);
  assert.equal(userDeployments.includes("user-one-deploy"), true);
  assert.deepEqual(
    (
      await deploymentManager.list({
        workspaceId: adminWorkspace.id,
        workspaceDirName: adminRuntimeConfig.workspaceDirName
      })
    ).map((deployment) => deployment.slug),
    ["admin-deploy"]
  );
  await assert.rejects(
    () => deploymentManager.publish({ path: root, slug: "outside-projects", port: 3000, workspaceId: userWorkspace.id }),
    /Deployment path must be inside/
  );

  const telegramCode = catalog.createTelegramLinkCode(normalUser);
  assert.match(telegramCode.code, /^[a-z0-9]{4}$/);
  assert.equal(telegramCode.userId, normalUser.id);
  assert.equal(telegramCode.workspaceId, userWorkspace.id);
  assert.equal(catalog.currentTelegramLinkCode(normalUser)?.code, telegramCode.code);
  const telegramLink = catalog.linkTelegramChat({
    code: telegramCode.code,
    chatId: "517118295",
    chatType: "private",
    title: "Justin",
    username: "justin",
    telegramUserId: "517118295",
    telegramUsername: "justin"
  });
  assert.equal(telegramLink.workspace.id, userWorkspace.id);
  assert.equal(telegramLink.link.userId, normalUser.id);
  assert.equal(catalog.telegramLinks(normalUser)[0].chatId, "517118295");
  assert.equal(catalog.telegramWorkspaceForChat("517118295")?.workspace.id, userWorkspace.id);
  assert.throws(
    () =>
      catalog.linkTelegramChat({
        code: telegramCode.code,
        chatId: "other",
        chatType: "private"
      }),
    /telegram link code is invalid/
  );
  catalog.unlinkTelegram(normalUser, telegramLink.link.id);
  assert.equal(catalog.telegramWorkspaceForChat("517118295"), undefined);
  assert.equal(catalog.telegramLinks(normalUser).length, 0);
  assert.equal(catalog.currentTelegramLinkCode(normalUser), undefined);

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
  if (process.env.AGENTMOM_KEEP_SMOKE !== "1") {
    rmSync(root, { recursive: true, force: true });
  }
}
