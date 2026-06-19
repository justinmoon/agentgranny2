set dotenv-load := false

dev:
    nix develop -c npm run dev

dev-auth:
    AGENTGRANNY_AUTH_ENABLED=1 AGENTGRANNY_STATE_DIR=.agentgranny2-auth AGENTGRANNY_DEV_AUTH_PASSWORD=password AGENTGRANNY_DEV_AUTH_USERS='mail@justinmoon.com|Justin Moon|admin,autumndomingo@gmail.com|Autumn Domingo|user' nix develop -c npm run dev

install:
    nix develop -c npm install

build:
    nix develop -c npm run build

typecheck:
    nix develop -c npm run typecheck

smoke-auth:
    nix develop -c npm run smoke:auth

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

    me_status="$(curl -sS -o /tmp/agentgranny2-deploy-me.json -w '%{http_code}' http://127.0.0.1:7392/api/me)"
    if [[ "${me_status}" != "401" ]]; then
      echo "expected unauthenticated /api/me to return 401, got ${me_status}" >&2
      cat /tmp/agentgranny2-deploy-me.json >&2
      exit 1
    fi
    grep -q '"authEnabled":true' /tmp/agentgranny2-deploy-me.json

    echo "stage deploy ok"
    REMOTE
