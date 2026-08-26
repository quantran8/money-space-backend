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

## Where it lives in code

- `terraform/` — the host, network, registry and reserved IP.
- `.github/workflows/deploy.yml` — build, upload, env files, restart, verify.
- `.github/workflows/logs.yml` — on-demand `docker compose logs` over SSH; the
  pre-Grafana way of reading production, still useful for the last few minutes.
- `deploy/docker-compose.prod.yml`, `deploy/Caddyfile`.
- `DEPLOYMENT.md` — the GitHub-side setup checklist.

Related: [[logging]], [[caching]], [[database-connections]]
