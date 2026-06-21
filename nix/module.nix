{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.agentmomWeb;
  proxyHost = if cfg.host == "0.0.0.0" then "127.0.0.1" else cfg.host;
  proxyAddress = "${proxyHost}:${toString cfg.port}";
  proxyUrl = "http://${proxyAddress}";
  startScript = pkgs.writeShellScript "agentmom-start" ''
    set -eu
    runtime_dir="/run/user/$(${pkgs.coreutils}/bin/id -u)"
    if [ ! -d "$runtime_dir" ]; then
      runtime_dir="/run/${cfg.serviceName}"
    fi
    export XDG_RUNTIME_DIR="$runtime_dir"
    ${lib.optionalString (cfg.envFile != null) ''
      export AGENTMOM_ENV_FILE="$CREDENTIALS_DIRECTORY/app-env"
    ''}
    exec ${lib.getExe cfg.package}
  '';
  uidmapWrappers = pkgs.runCommand "agentmom-uidmap-wrappers" { } ''
    mkdir -p "$out/bin"
    ln -s /run/wrappers/bin/newuidmap "$out/bin/newuidmap"
    ln -s /run/wrappers/bin/newgidmap "$out/bin/newgidmap"
  '';
in
{
  options.services.agentmomWeb = {
    enable = lib.mkEnableOption "Agent Mom web app";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.agentmom;
      description = "Agent Mom package to run.";
    };

    serviceName = lib.mkOption {
      type = lib.types.str;
      default = "agentmom";
      description = "systemd unit name for the web service.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "agentmom";
      description = "User that runs Agent Mom.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "agentmom";
      description = "Group that runs Agent Mom.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "HTTP bind host.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7392;
      description = "HTTP bind port.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/agentmom";
      description = "Persistent service state directory.";
    };

    workspaceDir = lib.mkOption {
      type = lib.types.path;
      default = "${cfg.stateDir}/workspace";
      description = "Workspace root mounted into the agent runtime.";
    };

    envFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Env file containing OPENROUTER_API_KEY, AGENTMOM_TELEGRAM_BOT_TOKEN,
        and BRAVE_API_KEY.
        The service reads this through systemd credentials, so the source file can remain root-only.
      '';
    };

    authEnabled = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether the web app requires login.";
    };

    deploymentBaseDomain = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional base domain for slug-based deployment hosts.";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "anthropic/claude-sonnet-4.5";
      description = "OpenRouter model id.";
    };

    caddy = {
      enable = lib.mkEnableOption "same-host Caddy reverse proxy for Agent Mom";

      publicDomain = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "agentmom.xyz";
        description = "Main public hostname served by Caddy.";
      };

      openFirewall = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Open TCP ports 80 and 443 when same-host Caddy is enabled.";
      };
    };

    smolvm = {
      package = lib.mkOption {
        type = lib.types.package;
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.smolvm;
        description = "smolvm package used for command execution.";
      };

      name = lib.mkOption {
        type = lib.types.str;
        default = "agentmom-default";
        description = "Persistent smolvm machine name.";
      };

      image = lib.mkOption {
        type = lib.types.str;
        default = "node:24-bookworm";
        description = "Default smolvm guest image.";
      };

      cpus = lib.mkOption {
        type = lib.types.ints.positive;
        default = 4;
        description = "smolvm vCPU count.";
      };

      memoryMb = lib.mkOption {
        type = lib.types.ints.positive;
        default = 8192;
        description = "smolvm memory in MiB.";
      };

      storageGib = lib.mkOption {
        type = lib.types.ints.positive;
        default = 20;
        description = "smolvm storage disk size in GiB.";
      };

      overlayGib = lib.mkOption {
        type = lib.types.ints.positive;
        default = 10;
        description = "smolvm overlay disk size in GiB.";
      };
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      virtualisation.podman.enable = true;

      assertions = [
        {
          assertion = cfg.envFile != null;
          message = "services.agentmomWeb.envFile must point to an env file with OPENROUTER_API_KEY, AGENTMOM_TELEGRAM_BOT_TOKEN, and BRAVE_API_KEY.";
        }
      ];

      environment.systemPackages = [
        cfg.package
        cfg.smolvm.package
      ];

      users.manageLingering = true;
      users.groups.${cfg.group} = { };
      users.users.${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
        extraGroups = [ "kvm" ];
        home = cfg.stateDir;
        createHome = true;
        linger = true;
        subUidRanges = [{ startUid = 200000; count = 65536; }];
        subGidRanges = [{ startGid = 200000; count = 65536; }];
      };

      systemd.tmpfiles.rules = [
        "d ${cfg.stateDir} 0750 ${cfg.user} ${cfg.group} - -"
        "d ${cfg.workspaceDir} 0750 ${cfg.user} ${cfg.group} - -"
        "d ${cfg.workspaceDir}/projects 0750 ${cfg.user} ${cfg.group} - -"
        "d ${cfg.stateDir}/app 0750 ${cfg.user} ${cfg.group} - -"
        "d ${cfg.stateDir}/xdg-cache 0750 ${cfg.user} ${cfg.group} - -"
        "d ${cfg.stateDir}/xdg-data 0750 ${cfg.user} ${cfg.group} - -"
      ];

      systemd.services.${cfg.serviceName} = {
        description = "Agent Mom web app";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];
        path = [
          cfg.smolvm.package
          uidmapWrappers
          pkgs.curl
          pkgs.e2fsprogs
          pkgs.file
          pkgs.git
          pkgs.go-containerregistry
          pkgs.gnutar
          pkgs.podman
        ];
        environment =
          {
            AGENTMOM_AGENT_DIR = "${cfg.stateDir}/app/pi";
            AGENTMOM_AUTH_ENABLED = if cfg.authEnabled then "1" else "0";
            AGENTMOM_EXECUTOR = "smolvm";
            AGENTMOM_HOST = cfg.host;
            AGENTMOM_OPENROUTER_MODEL = cfg.model;
            AGENTMOM_PODMAN_COMMAND = lib.getExe pkgs.podman;
            AGENTMOM_PORT = toString cfg.port;
            AGENTMOM_SESSION_DIR = "${cfg.stateDir}/app/sessions";
            AGENTMOM_SMOLVM_COMMAND = lib.getExe cfg.smolvm.package;
            AGENTMOM_SMOLVM_CPUS = toString cfg.smolvm.cpus;
            AGENTMOM_SMOLVM_IMAGE = cfg.smolvm.image;
            AGENTMOM_SMOLVM_MEMORY_MB = toString cfg.smolvm.memoryMb;
            AGENTMOM_SMOLVM_NAME = cfg.smolvm.name;
            AGENTMOM_SMOLVM_OVERLAY_GIB = toString cfg.smolvm.overlayGib;
            AGENTMOM_SMOLVM_STORAGE_GIB = toString cfg.smolvm.storageGib;
            AGENTMOM_STATE_DIR = "${cfg.stateDir}/app";
            AGENTMOM_WORKSPACE = cfg.workspaceDir;
            HOME = cfg.stateDir;
            NODE_ENV = "production";
            XDG_CACHE_HOME = "${cfg.stateDir}/xdg-cache";
            XDG_DATA_HOME = "${cfg.stateDir}/xdg-data";
          }
          // lib.optionalAttrs (cfg.deploymentBaseDomain != null) {
            AGENTMOM_DEPLOYMENT_BASE_DOMAIN = cfg.deploymentBaseDomain;
          };
        serviceConfig =
          {
            Delegate = true;
            ExecStart = startScript;
            Group = cfg.group;
            KillMode = "process";
            Restart = "on-failure";
            RestartSec = 3;
            RuntimeDirectory = cfg.serviceName;
            RuntimeDirectoryMode = "0700";
            Type = "simple";
            User = cfg.user;
            WorkingDirectory = cfg.workspaceDir;
          }
          // lib.optionalAttrs (cfg.envFile != null) {
            LoadCredential = [ "app-env:${toString cfg.envFile}" ];
          };
      };
    }

    (lib.mkIf cfg.caddy.enable {
      services.caddy.enable = true;
      services.caddy.globalConfig = lib.mkIf (cfg.deploymentBaseDomain != null) ''
        on_demand_tls {
          ask ${proxyUrl}/api/tls-ask
        }
      '';
      services.caddy.virtualHosts =
        lib.optionalAttrs (cfg.caddy.publicDomain != null) {
          "${cfg.caddy.publicDomain}".extraConfig = ''
            reverse_proxy ${proxyAddress}
          '';
        }
        // lib.optionalAttrs (cfg.deploymentBaseDomain != null) {
          "https://" = {
            logFormat = "output file /var/log/caddy/access-deployments.log";
            extraConfig = ''
              tls {
                on_demand
              }
              @agentmom_reserved host mom.${cfg.deploymentBaseDomain}
              handle @agentmom_reserved {
                abort
              }
              @agentmom_deployment host *.${cfg.deploymentBaseDomain}
              handle @agentmom_deployment {
                reverse_proxy ${proxyAddress}
              }
              abort
            '';
          };
        };

      networking.firewall.allowedTCPPorts = lib.mkIf cfg.caddy.openFirewall [ 80 443 ];
    })
  ]);
}
