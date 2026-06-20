import { isAbsolute, relative, resolve } from "node:path";

export function ensureWorkspaceProjectPath(projectPath: string, projectsDir: string): string {
  const resolvedPath = resolve(projectPath);
  const projectRelative = relative(resolve(projectsDir), resolvedPath);
  if (projectRelative === "" || (!projectRelative.startsWith("..") && !isAbsolute(projectRelative))) {
    return resolvedPath;
  }
  throw new Error(`Deployment path must be inside ${projectsDir}`);
}

export function workspaceApiPath(pathname: string): { workspaceId: string; rest: string } | undefined {
  const match = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  return { workspaceId: decodeURIComponent(match[1]), rest: match[2] || "" };
}

export function workspacePreviewPath(
  pathname: string
): { workspaceId: string; previewId: string; upstreamPath: string; needsSlash?: boolean } | undefined {
  const match = /^\/w\/([^/]+)\/preview\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  if (!match[3]) {
    return {
      workspaceId: decodeURIComponent(match[1]),
      previewId: decodeURIComponent(match[2]),
      upstreamPath: "/",
      needsSlash: true
    };
  }
  return {
    workspaceId: decodeURIComponent(match[1]),
    previewId: decodeURIComponent(match[2]),
    upstreamPath: match[3]
  };
}
