export type DeploymentRouteMode = "path" | "host";

export function deploymentPath(pathname: string): { slug: string; upstreamPath: string } | undefined {
  const prefix = "/deploy/";
  if (!pathname.startsWith(prefix)) return undefined;

  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    if (!rest) return undefined;
    return { slug: rest, upstreamPath: "/" };
  }

  const slug = rest.slice(0, slash);
  if (!slug) return undefined;
  const upstreamPath = `/${rest.slice(slash + 1)}`;
  return { slug, upstreamPath };
}

export function deploymentSlugFromHost(hostHeader: string | undefined, baseDomain: string | undefined): string | undefined {
  if (!hostHeader || !baseDomain) return undefined;

  const host = hostHeader.split(":")[0]?.toLowerCase().replace(/\.$/, "");
  const base = baseDomain.toLowerCase().replace(/\.$/, "");
  if (!host || host === base || !host.endsWith(`.${base}`)) return undefined;

  const slug = host.slice(0, -(base.length + 1));
  if (!slug || slug.includes(".")) return undefined;
  return slugify(slug) === slug ? slug : undefined;
}

export function isAllowedDeploymentDomain(domain: string | undefined, baseDomain: string | undefined): boolean {
  if (!domain || !baseDomain) return false;

  const host = domain.split(":")[0]?.toLowerCase().replace(/\.$/, "");
  const base = baseDomain.toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  return host === base || deploymentSlugFromHost(host, base) !== undefined;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
