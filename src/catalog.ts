import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type {
  PublicAdminUser,
  PublicInvite,
  PublicTelegramLink,
  PublicUser,
  PublicWorkspace,
  TelegramChatType,
  UserRole
} from "./types.js";

export const SESSION_COOKIE = "agentmom_session";
const SHORT_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SHORT_CODE_LENGTH = 4;
const SHORT_CODE_SPACE = SHORT_CODE_ALPHABET.length ** SHORT_CODE_LENGTH;
const SHORT_CODE_PATTERN = /^[a-z0-9]{4}$/;
const ACCESS_CODE_LABEL = "Access code";
const TELEGRAM_LINK_CODE_PATTERN = SHORT_CODE_PATTERN;

export type CatalogUser = {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  passwordHash: string;
  inviteId?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
};

export type CatalogSession = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
};

export type CatalogInvite = {
  id: string;
  code: string;
  label: string;
  kind?: "invite" | "access";
  role: UserRole;
  usedCount: number;
  active: boolean;
  createdByUserId: string;
  createdAt: number;
  disabledAt?: number;
};

export type CatalogWorkspace = {
  id: string;
  slug: string;
  displayName: string;
  ownerUserId: string;
  workspaceDirName: string;
  machineName: string;
  createdAt: number;
  updatedAt: number;
};

export type CatalogTelegramLink = {
  id: string;
  userId: string;
  workspaceId: string;
  chatId: string;
  chatType: TelegramChatType;
  title?: string;
  username?: string;
  telegramUserId?: string;
  telegramUsername?: string;
  active: boolean;
  createdAt: number;
  lastSeenAt?: number;
};

export type CatalogTelegramLinkCode = {
  code: string;
  userId: string;
  workspaceId: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
};

export type CatalogData = {
  schemaVersion: 3;
  users: CatalogUser[];
  sessions: CatalogSession[];
  invites: CatalogInvite[];
  workspaces: CatalogWorkspace[];
  telegramLinks: CatalogTelegramLink[];
  telegramLinkCodes: CatalogTelegramLinkCode[];
};

export type SignupInput = {
  email: string;
  fullName: string;
  password: string;
  inviteCode?: string;
};

export type LoginInput = {
  email: string;
  password: string;
};

export type InviteInput = {
  label?: string;
  role?: string;
};

export type SeedUserInput = {
  email: string;
  fullName: string;
  password: string;
  role?: UserRole;
};

export type AuthResult = {
  user: PublicUser;
  token: string;
  workspace: CatalogWorkspace;
};

export type TelegramLinkChatInput = {
  code: string;
  chatId: string;
  chatType: TelegramChatType;
  title?: string;
  username?: string;
  telegramUserId?: string;
  telegramUsername?: string;
};

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function base64url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function randomShortCode(): string {
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    code += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  }
  return code;
}

function shortCodeAt(index: number): string {
  let remaining = index;
  let code = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    code = SHORT_CODE_ALPHABET[remaining % SHORT_CODE_ALPHABET.length] + code;
    remaining = Math.floor(remaining / SHORT_CODE_ALPHABET.length);
  }
  return code;
}

function unusedShortCode(usedCodes: Set<string>, label: string): string {
  if (usedCodes.size >= SHORT_CODE_SPACE) {
    throw new Error(`${label} code space exhausted`);
  }

  for (let attempt = 0; attempt < 64; attempt += 1) {
    const code = randomShortCode();
    if (!usedCodes.has(code)) return code;
  }

  for (let index = 0; index < SHORT_CODE_SPACE; index += 1) {
    const code = shortCodeAt(index);
    if (!usedCodes.has(code)) return code;
  }

  throw new Error(`${label} code space exhausted`);
}

function unusedTelegramLinkCode(activeCodes: Set<string>): string {
  return unusedShortCode(activeCodes, "telegram link");
}

function isAccessInvite(invite: CatalogInvite): boolean {
  return invite.kind === "access" || (invite.kind === undefined && invite.label === ACCESS_CODE_LABEL && invite.code.startsWith("mom-"));
}

function normalizeTelegramLinkCode(code: string): string {
  return code.trim().toLowerCase();
}

function normalizeInviteCode(code: string): string {
  const trimmed = code.trim();
  return SHORT_CODE_PATTERN.test(trimmed.toLowerCase()) ? trimmed.toLowerCase() : trimmed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error("valid email is required");
  }
  return normalized;
}

function normalizeName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("full name is required");
  return normalized;
}

function normalizePassword(password: string): string {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  return password;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

function machineNameFor(id: string, slug: string): string {
  return `agentmom-${slug}-${id.slice(0, 8)}`.slice(0, 63);
}

function passwordHash(password: string): string {
  const salt = base64url(16);
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString("base64url"));
  const expected = Buffer.from(hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function emptyCatalog(): CatalogData {
  return {
    schemaVersion: 3,
    users: [],
    sessions: [],
    invites: [],
    workspaces: [],
    telegramLinks: [],
    telegramLinkCodes: []
  };
}

function publicUser(user: CatalogUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    inviteId: user.inviteId,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt
  };
}

function publicWorkspace(workspace: CatalogWorkspace): PublicWorkspace {
  return {
    id: workspace.id,
    slug: workspace.slug,
    displayName: workspace.displayName,
    ownerUserId: workspace.ownerUserId,
    machineName: workspace.machineName,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt
  };
}

function publicInvite(invite: CatalogInvite): PublicInvite {
  return {
    id: invite.id,
    code: invite.code,
    label: invite.label,
    role: invite.role,
    usedCount: invite.usedCount,
    active: invite.active,
    createdByUserId: invite.createdByUserId,
    createdAt: invite.createdAt,
    disabledAt: invite.disabledAt
  };
}

function publicAdminUser(user: CatalogUser, data: CatalogData): PublicAdminUser {
  const workspace = data.workspaces.find((candidate) => candidate.ownerUserId === user.id);
  const invite = user.inviteId ? data.invites.find((candidate) => candidate.id === user.inviteId) : undefined;
  return {
    ...publicUser(user),
    workspace: workspace ? publicWorkspace(workspace) : undefined,
    invite: invite ? publicInvite(invite) : undefined
  };
}

function publicTelegramLink(link: CatalogTelegramLink): PublicTelegramLink {
  return {
    id: link.id,
    userId: link.userId,
    workspaceId: link.workspaceId,
    chatId: link.chatId,
    chatType: link.chatType,
    title: link.title,
    username: link.username,
    telegramUserId: link.telegramUserId,
    telegramUsername: link.telegramUsername,
    active: link.active,
    createdAt: link.createdAt,
    lastSeenAt: link.lastSeenAt
  };
}

export class CatalogStore {
  private readonly path: string;

  constructor(private readonly config: AppConfig) {
    this.path = resolve(config.stateDir, "catalog.json");
  }

  read(): CatalogData {
    mkdirSync(this.config.stateDir, { recursive: true });
    if (!existsSync(this.path)) return emptyCatalog();
    const data = JSON.parse(readFileSync(this.path, "utf8")) as CatalogData;
    if (data.schemaVersion !== 3) {
      throw new Error(`catalog schema version ${data.schemaVersion} is not supported; reset ${this.path}`);
    }
    return data;
  }

  write(data: CatalogData): void {
    mkdirSync(this.config.stateDir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  currentUser(cookieHeader: string | undefined): CatalogUser | null {
    const token = parseCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = sha256(token);
    const data = this.read();
    const session = data.sessions.find((candidate) => candidate.tokenHash === tokenHash);
    if (!session) return null;
    const user = data.users.find((candidate) => candidate.id === session.userId);
    if (!user) return null;
    const seenAt = now();
    session.lastSeenAt = seenAt;
    user.lastSeenAt = seenAt;
    this.write(data);
    return user;
  }

  ensureDevUser(): { user: CatalogUser; workspace: CatalogWorkspace } {
    const data = this.read();
    let user = data.users.find((candidate) => candidate.email === "dev@agentmom.local");
    const timestamp = now();
    if (!user) {
      user = {
        id: "dev-user",
        email: "dev@agentmom.local",
        fullName: "Dev User",
        role: "admin",
        passwordHash: "auth-disabled",
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp
      };
      data.users.push(user);
    }
    let workspace = data.workspaces.find((candidate) => candidate.ownerUserId === user.id);
    if (!workspace) {
      workspace = {
        id: "dev-workspace",
        slug: "dev",
        displayName: "Dev workspace",
        ownerUserId: user.id,
        workspaceDirName: "dev",
        machineName: this.config.smolvm.name,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      data.workspaces.push(workspace);
    }
    user.lastSeenAt = timestamp;
    this.write(data);
    return { user, workspace };
  }

  me(user: CatalogUser): {
    user: PublicUser;
    workspace: PublicWorkspace;
    workspaces: PublicWorkspace[];
  } {
    const workspace = this.workspaceForUser(user);
    return {
      user: publicUser(user),
      workspace: publicWorkspace(workspace),
      workspaces: this.visibleWorkspaces(user).map(publicWorkspace)
    };
  }

  signup(input: SignupInput): AuthResult {
    const email = normalizeEmail(input.email);
    const fullName = normalizeName(input.fullName);
    const password = normalizePassword(input.password);
    const data = this.read();
    if (data.users.some((user) => user.email === email)) throw new Error("email is already registered");

    const firstUser = data.users.every((user) => user.passwordHash === "auth-disabled");
    let role: UserRole = "admin";
    let inviteId: string | undefined;
    if (!firstUser) {
      const code = input.inviteCode ? normalizeInviteCode(input.inviteCode) : "";
      if (!code) throw new Error("invite code is required");
      const invite = data.invites.find((candidate) => candidate.code === code);
      if (!invite || !invite.active) throw new Error("invite code is invalid");
      role = invite.role;
      invite.usedCount += 1;
      inviteId = invite.id;
    }

    const timestamp = now();
    const user: CatalogUser = {
      id: randomUUID(),
      email,
      fullName,
      role,
      passwordHash: passwordHash(password),
      inviteId,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp
    };
    data.users.push(user);
    const workspace = this.createWorkspaceInData(data, user);
    const token = this.createSessionInData(data, user.id);
    this.write(data);
    return { user: publicUser(user), token, workspace };
  }

  ensureSeedUser(input: SeedUserInput): { user: PublicUser; workspace: PublicWorkspace } {
    const email = normalizeEmail(input.email);
    const fullName = normalizeName(input.fullName);
    const password = normalizePassword(input.password);
    const role: UserRole = input.role === "user" ? "user" : "admin";
    const timestamp = now();
    const data = this.read();

    let user = data.users.find((candidate) => candidate.email === email);
    if (user) {
      user.fullName = fullName;
      user.role = role;
      user.passwordHash = passwordHash(password);
      user.updatedAt = timestamp;
    } else {
      user = {
        id: randomUUID(),
        email,
        fullName,
        role,
        passwordHash: passwordHash(password),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      data.users.push(user);
    }

    const workspace =
      data.workspaces.find((candidate) => candidate.ownerUserId === user.id) ??
      this.createWorkspaceInData(data, user);
    this.write(data);
    return { user: publicUser(user), workspace: publicWorkspace(workspace) };
  }

  login(input: LoginInput): AuthResult {
    const email = normalizeEmail(input.email);
    const data = this.read();
    const user = data.users.find((candidate) => candidate.email === email);
    if (!user || !passwordMatches(input.password, user.passwordHash)) {
      throw new Error("invalid email or password");
    }
    user.lastSeenAt = now();
    const workspace =
      data.workspaces.find((candidate) => candidate.ownerUserId === user.id) ??
      this.createWorkspaceInData(data, user);
    const token = this.createSessionInData(data, user.id);
    this.write(data);
    return { user: publicUser(user), token, workspace };
  }

  logout(cookieHeader: string | undefined): void {
    const token = parseCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return;
    const tokenHash = sha256(token);
    const data = this.read();
    data.sessions = data.sessions.filter((session) => session.tokenHash !== tokenHash);
    this.write(data);
  }

  createInvite(user: CatalogUser, input: InviteInput): { invite: PublicInvite; code: string } {
    if (user.role !== "admin") throw new Error("admin required");
    const role: UserRole = input.role === "admin" ? "admin" : "user";
    const data = this.read();
    const code = unusedShortCode(new Set(data.invites.map((invite) => invite.code)), "invite");
    const invite: CatalogInvite = {
      id: randomUUID(),
      code,
      label: input.label?.trim() || `${role} invite`,
      kind: "invite",
      role,
      usedCount: 0,
      active: true,
      createdByUserId: user.id,
      createdAt: now()
    };
    data.invites.push(invite);
    this.write(data);
    return { invite: publicInvite(invite), code };
  }

  disableInvite(user: CatalogUser, inviteId: string): PublicInvite {
    if (user.role !== "admin") throw new Error("admin required");
    const data = this.read();
    const invite = data.invites.find((candidate) => candidate.id === inviteId);
    if (!invite) throw new Error("invite not found");
    invite.active = false;
    invite.disabledAt = now();
    this.write(data);
    return publicInvite(invite);
  }

  invites(user: CatalogUser): PublicInvite[] {
    if (user.role !== "admin") throw new Error("admin required");
    return this.read().invites.map(publicInvite);
  }

  private createSharedAccessCodeInData(data: CatalogData, user: CatalogUser): CatalogInvite {
    const invite: CatalogInvite = {
      id: randomUUID(),
      code: unusedShortCode(new Set(data.invites.map((candidate) => candidate.code)), "access"),
      label: ACCESS_CODE_LABEL,
      kind: "access",
      role: "user",
      usedCount: 0,
      active: true,
      createdByUserId: user.id,
      createdAt: now()
    };
    data.invites.push(invite);
    return invite;
  }

  // The single shared access code: the one active invite everyone signs up with.
  accessCode(user: CatalogUser): PublicInvite {
    if (user.role !== "admin") throw new Error("admin required");
    const data = this.read();
    let invite = data.invites.find((candidate) => candidate.active && candidate.kind === "access");
    if (!invite) {
      const timestamp = now();
      for (const candidate of data.invites) {
        if (candidate.active && isAccessInvite(candidate)) {
          candidate.active = false;
          candidate.disabledAt = timestamp;
        }
      }
      invite = this.createSharedAccessCodeInData(data, user);
      this.write(data);
    }
    return publicInvite(invite);
  }

  // Regenerate: invalidate every existing code and mint a fresh shared one.
  regenerateAccessCode(user: CatalogUser): PublicInvite {
    if (user.role !== "admin") throw new Error("admin required");
    const data = this.read();
    const timestamp = now();
    for (const invite of data.invites) {
      if (invite.active && isAccessInvite(invite)) {
        invite.active = false;
        invite.disabledAt = timestamp;
      }
    }
    const invite = this.createSharedAccessCodeInData(data, user);
    this.write(data);
    return publicInvite(invite);
  }

  users(user: CatalogUser): PublicAdminUser[] {
    if (user.role !== "admin") throw new Error("admin required");
    const data = this.read();
    return data.users.map((candidate) => publicAdminUser(candidate, data));
  }

  setUserRole(actor: CatalogUser, targetUserId: string, role: string): PublicAdminUser {
    if (actor.role !== "admin") throw new Error("admin required");
    if (targetUserId === actor.id) throw new Error("you cannot change your own role");
    const nextRole: UserRole = role === "admin" ? "admin" : "user";
    const data = this.read();
    const target = data.users.find((candidate) => candidate.id === targetUserId);
    if (!target) throw new Error("user not found");
    target.role = nextRole;
    target.updatedAt = now();
    this.write(data);
    return publicAdminUser(target, data);
  }

  createTelegramLinkCode(user: CatalogUser): CatalogTelegramLinkCode {
    const workspace = this.workspaceForUser(user);
    const data = this.read();
    const timestamp = now();
    data.telegramLinkCodes = data.telegramLinkCodes.filter((candidate) => {
      if (!TELEGRAM_LINK_CODE_PATTERN.test(candidate.code)) return false;
      if (candidate.usedAt || candidate.expiresAt <= timestamp) return false;
      return candidate.userId !== user.id;
    });
    const activeCodes = new Set(data.telegramLinkCodes.map((candidate) => candidate.code));
    const code: CatalogTelegramLinkCode = {
      code: unusedTelegramLinkCode(activeCodes),
      userId: user.id,
      workspaceId: workspace.id,
      createdAt: timestamp,
      expiresAt: timestamp + 15 * 60
    };
    data.telegramLinkCodes.push(code);
    this.write(data);
    return code;
  }

  currentTelegramLinkCode(user: CatalogUser): CatalogTelegramLinkCode | undefined {
    const timestamp = now();
    return this.read()
      .telegramLinkCodes.filter(
        (code) =>
          code.userId === user.id &&
          TELEGRAM_LINK_CODE_PATTERN.test(code.code) &&
          !code.usedAt &&
          code.expiresAt > timestamp
      )
      .sort((left, right) => right.createdAt - left.createdAt)[0];
  }

  telegramLinks(user: CatalogUser): PublicTelegramLink[] {
    return this.read()
      .telegramLinks.filter((link) => link.userId === user.id && link.active)
      .map(publicTelegramLink);
  }

  unlinkTelegram(user: CatalogUser, linkId: string): PublicTelegramLink {
    const data = this.read();
    const link = data.telegramLinks.find((candidate) => candidate.id === linkId);
    if (!link || link.userId !== user.id) throw new Error("telegram link not found");
    link.active = false;
    this.write(data);
    return publicTelegramLink(link);
  }

  linkTelegramChat(input: TelegramLinkChatInput): { link: PublicTelegramLink; workspace: CatalogWorkspace } {
    const data = this.read();
    const timestamp = now();
    const inputCode = normalizeTelegramLinkCode(input.code);
    const code = data.telegramLinkCodes.find(
      (candidate) => TELEGRAM_LINK_CODE_PATTERN.test(candidate.code) && candidate.code === inputCode
    );
    if (!code || code.usedAt || code.expiresAt <= timestamp) throw new Error("telegram link code is invalid");

    const user = data.users.find((candidate) => candidate.id === code.userId);
    if (!user) throw new Error("telegram link user not found");
    const workspace = data.workspaces.find((candidate) => candidate.id === code.workspaceId);
    if (!workspace) throw new Error("telegram link workspace not found");

    for (const link of data.telegramLinks) {
      if (link.chatId === input.chatId && link.active) {
        link.active = false;
      }
    }

    const link: CatalogTelegramLink = {
      id: randomUUID(),
      userId: code.userId,
      workspaceId: code.workspaceId,
      chatId: input.chatId,
      chatType: input.chatType,
      title: input.title,
      username: input.username,
      telegramUserId: input.telegramUserId,
      telegramUsername: input.telegramUsername,
      active: true,
      createdAt: timestamp,
      lastSeenAt: timestamp
    };
    code.usedAt = timestamp;
    data.telegramLinks.push(link);
    this.write(data);
    return { link: publicTelegramLink(link), workspace };
  }

  telegramWorkspaceForChat(chatId: string): { link: CatalogTelegramLink; workspace: CatalogWorkspace } | undefined {
    const data = this.read();
    const link = data.telegramLinks.find((candidate) => candidate.chatId === chatId && candidate.active);
    if (!link) return undefined;
    const workspace = data.workspaces.find((candidate) => candidate.id === link.workspaceId);
    if (!workspace) throw new Error("telegram workspace not found");
    link.lastSeenAt = now();
    this.write(data);
    return { link, workspace };
  }

  visibleWorkspaces(user: CatalogUser): CatalogWorkspace[] {
    const data = this.read();
    if (user.role === "admin") return data.workspaces;
    return data.workspaces.filter((workspace) => workspace.ownerUserId === user.id);
  }

  workspaceForUser(user: CatalogUser): CatalogWorkspace {
    const workspace = this.read().workspaces.find((candidate) => candidate.ownerUserId === user.id);
    if (!workspace) throw new Error("workspace not found for user");
    return workspace;
  }

  authorizeWorkspace(user: CatalogUser, workspaceId: string): CatalogWorkspace {
    const workspace = this.read().workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error("workspace not found");
    if (user.role !== "admin" && workspace.ownerUserId !== user.id) throw new Error("forbidden");
    return workspace;
  }

  createSessionInData(data: CatalogData, userId: string): string {
    const token = base64url(32);
    const timestamp = now();
    data.sessions.push({
      id: randomUUID(),
      userId,
      tokenHash: sha256(token),
      createdAt: timestamp,
      lastSeenAt: timestamp
    });
    return token;
  }

  private createWorkspaceInData(data: CatalogData, user: CatalogUser): CatalogWorkspace {
    const slug = slugify(`${user.fullName}-${user.email.split("@")[0]}`);
    const id = randomUUID();
    const workspace: CatalogWorkspace = {
      id,
      slug,
      displayName: `${user.fullName}'s workspace`,
      ownerUserId: user.id,
      workspaceDirName: `user-${slug}-${id.slice(0, 8)}`,
      machineName: machineNameFor(id, slug),
      createdAt: now(),
      updatedAt: now()
    };
    data.workspaces.push(workspace);
    return workspace;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
