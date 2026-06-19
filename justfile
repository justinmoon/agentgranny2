set dotenv-load := false

dev:
    nix develop -c npm run dev

install:
    nix develop -c npm install

build:
    nix develop -c npm run build

typecheck:
    nix develop -c npm run typecheck

smoke-local:
    nix develop -c npm run smoke:local

smoke-smolvm:
    nix develop -c npm run smoke:smolvm

smoke-deploy:
    nix develop -c npm run smoke:deploy

start:
    nix develop -c npm run start

deploy-stage:
    #!/usr/bin/env bash
    set -euo pipefail

    branch="$(git branch --show-current)"
    if [[ "${branch}" != "master" ]]; then
      echo "deploy-stage expects master; current branch is ${branch}" >&2
      exit 1
    fi

    if ! git diff --quiet || ! git diff --cached --quiet; then
      echo "commit or stash local changes before deploy-stage" >&2
      exit 1
    fi

    git push origin master

    ssh mom-stage-1 'bash -se' <<'REMOTE'
    set -euo pipefail

    cd /srv/agentgranny2
    git fetch origin master
    git reset --hard origin/master
    npm ci
    npm run build
    sudo systemctl restart agentgranny2

    for attempt in $(seq 1 60); do
      health_json="$(curl -fsS http://127.0.0.1:7392/api/health || true)"
      if [[ "${health_json}" == *'"commit"'* ]]; then
        echo "${health_json}"
        break
      fi
      if [[ "${attempt}" == "60" ]]; then
        echo "agentgranny2 health check failed" >&2
        [[ -n "${health_json}" ]] && echo "${health_json}" >&2
        sudo systemctl status agentgranny2 --no-pager -n 80 >&2 || true
        exit 1
      fi
      sleep 1
    done

    curl -fsS -X POST http://127.0.0.1:7392/api/messages \
      -H 'Content-Type: application/json' \
      --data-binary '{"content":"Reply with exactly GRANNY_OK. Do not use tools."}' \
      | tee /tmp/agentgranny2-deploy-smoke.json \
      | grep -q 'GRANNY_OK'

    echo "stage deploy ok"
    REMOTE
