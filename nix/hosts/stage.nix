{ self }:
{ ... }:

{
  imports = [ self.nixosModules.agentmomWeb ];

  services.agentmomWeb = {
    enable = true;
    host = "0.0.0.0";
    stateDir = "/data/agentmom-web";
    workspaceDir = "/data/agentmom-web/workspace";
    openRouterKeyFile = "/run/agenix/agentmom-openrouter-api-key";
    deploymentBaseDomain = "stage.agentmom.xyz";

    caddy = {
      enable = true;
      publicDomain = "stage.agentmom.xyz";
    };

    smolvm.name = "agentmom-web-stage";
  };
}
