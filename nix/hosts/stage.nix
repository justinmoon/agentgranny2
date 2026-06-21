{ self }:
{ ... }:

{
  imports = [ self.nixosModules.agentmomWeb ];

  services.agentmomWeb = {
    enable = true;
    host = "0.0.0.0";
    stateDir = "/data/agentmom-web";
    workspaceDir = "/data/agentmom-web/workspace";
    envFile = "/run/agenix/agentmom-secrets";
    deploymentBaseDomain = "stage.agentmom.xyz";

    caddy = {
      enable = true;
      publicDomain = "stage.agentmom.xyz";
    };

    smolvm.name = "agentmom-web-stage";
  };
}
