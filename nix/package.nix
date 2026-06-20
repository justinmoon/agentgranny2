{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs_24,
}:

buildNpmPackage {
  pname = "agentmom";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ./..;
    filter = path: type:
      let
        base = baseNameOf path;
      in
      !(base == ".git"
        || base == ".direnv"
        || base == ".env"
        || base == ".agentmom"
        || base == ".smoke-workspace"
        || base == ".smoke-smolvm-workspace"
        || base == "dist"
        || base == "node_modules"
        || base == "projects"
        || base == "mutiny-wallet"
        || base == "index.ts"
        || base == "encode-event.ts"
        || base == "npm-debug.log");
  };

  nodejs = nodejs_24;
  npmDepsFetcherVersion = 2;
  npmDepsHash = "sha256-TlnaxvQpQoxEFM5SU6ZiCqmNTa1pOwicCbEkxdsTjes=";
  makeCacheWritable = true;

  nativeBuildInputs = [ makeWrapper ];

  npmBuildScript = "build";

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/agentmom" "$out/bin"
    cp -R dist src package.json package-lock.json node_modules "$out/share/agentmom/"

    makeWrapper ${nodejs_24}/bin/node "$out/bin/agentmom" \
      --set NODE_ENV production \
      --chdir "$out/share/agentmom" \
      --add-flags "$out/share/agentmom/node_modules/tsx/dist/cli.mjs" \
      --add-flags "$out/share/agentmom/src/server.ts"

    runHook postInstall
  '';

  meta = {
    description = "Lean Pi-backed Agent Mom web shell";
    mainProgram = "agentmom";
  };
}
