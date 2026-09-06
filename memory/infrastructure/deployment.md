# Deployment

## Overview

One VM on Oracle Cloud's Always Free tier, running the app as a Docker Compose
stack behind Caddy. Terraform owns the host; GitHub Actions owns what runs on it.

```
push to master
  └─ build image (native runner, matching arch) ─→ OCIR
       └─ ssh to the VM ─→ docker compose up -d
            ├─ caddy    :80/:443   TLS, reverse proxy   (profile: tls)
            ├─ backend  :3000      NestJS
            ├─ redis               cache, not published
            └─ alloy               log shipper          (separate compose file)
```

Postgres is deliberately absent — the app talks to hosted Supabase.

## Rules / contracts

- **Terraform never holds a secret.** It provisions the host and installs the
  deploy user's key; every credential lives in GitHub and is written to the VM
  at deploy time. State files therefore carry nothing sensitive.
- **Registry coordinates are Variables, not Secrets.** GitHub redacts secret
  values wherever they appear in step outputs, so an image reference assembled
  from secrets reaches the next job as an empty string — surfacing on the VM as
  *"service backend has neither an image nor a build context"*, which points at
  the compose file rather than at the build. There is deliberately **no**
  `secrets.*` fallback: the fallback would reintroduce the same silent failure.
- **Env files are split by blast radius**, one per consumer:
  - `.env` — the app. Holds the Supabase service-role key.
  - `.env.caddy` — ACME email only. The proxy has no business holding DB keys.
  - `.env.alloy` — Grafana Cloud push credentials. Same reasoning.
- **An unset optional variable must be absent, not empty.** Code tests a key's
  truthiness to decide whether a provider is active, and `KEY=""` would also
  override a base URL default with the empty string.
- **`env_file` is parsed with dotenv rules, not shell rules.** Inside double
  quotes only `\` and `"` escape; `$` and `#` are literal. Shell-style `'\''`
  quoting makes Compose drop the line silently, so values are escaped for
  dotenv (backslash first, then quote).
- **Compose profiles gate optional services.** Caddy sits behind the `tls`
  profile and starts only when `DOMAIN_NAME` is set; without a domain there is
  nothing to request a certificate for. Alloy lives in a *second compose file*
  rather than a profile, because whether a host can afford to ship logs is a
  per-host decision — see [[logging]].
- **Version is derived, never bumped by hand.** Each build is tagged
  `vYYYY.MM.DD-<run_number>` alongside its `:<sha>`, both names for one
  manifest. The date is Asia/Ho_Chi_Minh so an early-morning local deploy is not
  stamped with the previous day; `run_number` breaks ties within a day. Nothing
  reads `package.json`'s version — it is still Nest's default `0.0.1`, and a
  number someone has to remember to bump is a number that goes stale.
- **The build stamps itself into the image.** `APP_VERSION`, `APP_COMMIT` and
  `APP_BUILT_AT` arrive as build args, become `ENV` in the runner stage, and are
  read once by `src/version.ts`. They are declared in the *last* stage after
  every `COPY`: an ARG changes on every build and invalidates every layer below
  it, so higher up they would defeat the registry layer cache entirely.
- **`/health` reports the running build, and the deploy asserts it.** A restart
  that silently kept the previous image still answers "healthy", so the workflow
  compares the version it just built against what `/health` returns and fails on
  a mismatch. That is the check that catches a pull which did not take.
- **`--remove-orphans` is what turns a variable off cleanly.** Unset
  `ENABLE_OBSERVABILITY` or `DOMAIN_NAME` and the next deploy stops the
  corresponding container instead of leaving it orphaned.

## Failure modes worth knowing

- **Architecture mismatch is silent until the container dies.** A1 is aarch64,
  E2.1.Micro is amd64; the wrong image exits immediately with *"exec format
  error"*. `BUILD_PLATFORM` both selects a native runner and is asserted against
  `uname -m` before the build.
- **QEMU emulation is not an acceptable fallback.** Building arm64 on an x86
  runner crashed the Node/Prisma layers with *"uncaught target signal 4 (Illegal
  instruction)"* and, when it survived, took 10–15 minutes. Hence the explicit
  check that fails rather than silently emulating.
- **An SSH key copied through a browser loses its trailing newline**, and
  OpenSSH rejects it with the opaque *"error in libcrypto"*. The workflow
  normalises the newline and strips CRLF, then validates with `ssh-keygen -y`
  so the failure is readable.
- **An empty `ACME_EMAIL` is worse than a missing one.** The Caddyfile's
  `{$ACME_EMAIL:default}` applies only when the variable is *absent*; naming it
  in `environment:` makes Compose inject an empty string, leaving `email` with
  no argument — a parse error that crash-loops Caddy. This is why Caddy reads
  its own env file and the workflow omits the line entirely when unset.
- **Let's Encrypt rejects a contact address with no dot in the domain**, so
  `acme@localhost` never registers an account and no certificate is issued. The
  fallback in the Caddyfile is a real address on purpose.
- **Certificates must outlive the container.** Without the `caddy_data` volume
  every restart re-issues from scratch and trips the rate limit (5 duplicate
  certificates per week).
- **First deploy races cloud-init.** The workflow waits for
  `/var/lib/cloud/instance/provisioning-complete` before touching Docker.
- **OCIR expires nothing.** There is no lifecycle policy to configure — not in
  Terraform, not in the Console — so the registry grows by about five manifests
  per deploy and stays that way. Three of those are residue rather than builds:
  re-pushing `:latest` or `:buildcache` moves the tag and abandons the previous
  manifest, which the Console then lists as `<repo>:unknown@sha256:...`. Nothing
  can pull those. `prune-registry.yml` keeps the five newest `:<sha>` builds and
  deletes the rest weekly.
- **OCIR lists one row per tag, not per image.** A build tagged `:<sha>` and
  `:<version>` is two rows sharing one digest, and a list response carries no
  tag array at all — reading tags off the payload classified everything as
  untagged, which would have deleted `:latest`, `:buildcache` and every rollback
  target. Ask the API instead (`--is-versioned`) and group rows by digest, or
  "keep 5" counts tag rows and keeps two and a half builds. `:buildcache` is
  excluded from that ranking: it is a cache manifest with no build behind it.
- **The Console sorts by creation time, and the moving tags win.** `:latest` and
  `:buildcache` are pushed a few seconds after the build's own tags, so they head
  the list and the `:<sha>`/`:<version>` rows sit further down the page. An
  absent tag there is almost always a scrolling artefact — search for it before
  concluding the build did not push it.
- **The registry token cannot delete.** `OCIR_TOKEN` authenticates `docker
  login` against the registry v2 endpoint, which does not implement manifest
  deletion at all. Deletion is a control-plane call (`oci artifacts container
  image delete`) signed with an API key pair, so pruning needs its own set of
  credentials — see the pruning section of `DEPLOYMENT.md`.
- **Rollback depth is bounded by the prune.** Rolling back rewrites
  `BACKEND_IMAGE` in the VM's `.env` to an older `:<sha>` and restarts, which
  only works while that tag still exists. Beyond five builds back the tag is
  gone and the rollback becomes a rebuild. Migrations bound it in practice
  anyway: `prisma migrate deploy` is not reversed by starting an older image.

## Where it lives in code

- `terraform/` — the host, network, registry and reserved IP.
- `.github/workflows/deploy.yml` — build, upload, env files, restart, verify.
- `.github/workflows/logs.yml` — on-demand `docker compose logs` over SSH; the
  pre-Grafana way of reading production, still useful for the last few minutes.
- `.github/workflows/prune-registry.yml` — weekly OCIR cleanup. Deliberately not
  a step in `deploy.yml`: an expired key or a throttled API must not fail a
  rollout, and the cleanup is never urgent enough to be worth that risk.
- `deploy/docker-compose.prod.yml`, `deploy/Caddyfile`.
- `DEPLOYMENT.md` — the GitHub-side setup checklist.

Related: [[logging]], [[caching]], [[database-connections]]
