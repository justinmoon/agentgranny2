import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig } from "./config.js";
import type { CatalogWorkspace } from "./catalog.js";
import { PiBridge } from "./pi-bridge.js";
import { PreviewManager } from "./previews.js";

export type WorkspaceRuntime = {
  config: AppConfig;
  previews: PreviewManager;
  bridge: PiBridge;
};

export class WorkspaceRuntimeManager {
  private readonly runtimes = new Map<string, Promise<WorkspaceRuntime>>();

  constructor(private readonly baseConfig: AppConfig) {}

  async get(workspace: CatalogWorkspace): Promise<WorkspaceRuntime> {
    let runtime = this.runtimes.get(workspace.id);
    if (!runtime) {
      runtime = this.create(workspace).catch((error) => {
        if (this.runtimes.get(workspace.id) === runtime) this.runtimes.delete(workspace.id);
        throw error;
      });
      this.runtimes.set(workspace.id, runtime);
    }
    return runtime;
  }

  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      void runtime.then(({ bridge }) => bridge.dispose()).catch(() => undefined);
    }
    this.runtimes.clear();
  }

  private async create(workspace: CatalogWorkspace): Promise<WorkspaceRuntime> {
    const config = workspaceConfig(this.baseConfig, workspace);
    mkdirSync(config.workspace, { recursive: true });
    mkdirSync(config.projectsDir, { recursive: true });
    mkdirSync(config.agentDir, { recursive: true });
    mkdirSync(config.sessionDir, { recursive: true });

    const previews = new PreviewManager(config);
    const bridge = new PiBridge(config, previews);
    await bridge.init();
    return { config, previews, bridge };
  }
}

export function workspaceConfig(base: AppConfig, workspace: CatalogWorkspace): AppConfig {
  const workspacePath = resolve(base.workspaceRoot, workspace.workspaceDirName);
  const workspaceStateDir = resolve(base.stateDir, "workspaces", workspace.id);
  return {
    ...base,
    workspace: workspacePath,
    projectsDir: resolve(workspacePath, "projects"),
    agentCwd: resolve(workspacePath, "projects"),
    agentDir: resolve(workspaceStateDir, "pi"),
    sessionDir: resolve(workspaceStateDir, "sessions"),
    previewBasePath: `/w/${encodeURIComponent(workspace.id)}/preview`,
    smolvm: {
      ...base.smolvm,
      name: workspace.machineName
    }
  };
}
