# Deployment setup

What to configure in GitHub before the first deploy. The infrastructure already
exists — Terraform created it (see [terraform/README.md](terraform/README.md));
this document only covers the GitHub side.

**Status:** the VM is running with Docker installed, DNS resolves to it, and
nothing is deployed yet. The first push to `master` changes that.

```
push to master ──> build arm64 image ──> push to OCIR ──> ssh into the VM
                                                              ↓
                                                    docker compose up -d
                                                    ┌─────────┼─────────┐
                                                  Caddy    NestJS     Redis
                                                   :443     :3000
```

---

## 1. Secrets

**Settings → Secrets and variables → Actions → Secrets tab → New repository secret**

Secrets are write-only: GitHub masks them in logs and never shows them again
after saving.

Each secret is two separate fields. The tables below give the **Name** in the
left column and the **Secret** (its value) in the right:

```
Name    OCIR_USERNAME
Secret  axttup8tl3ug/quan5080@gmail.com
```

Pasting a whole `NAME=value` line into the Name field is the usual first
mistake, and GitHub answers with:

> Secret names can only contain alphanumeric characters ([a-z], [A-Z], [0-9]) or
> underscores (_).

That rule applies only to the Name. Values are unrestricted — `/`, `@`, `:`,
newlines in a private key are all fine.

### Connecting to the server

| Secret | Value |
| --- | --- |
| `OCI_HOST` | `134.185.85.59` |
| `OCI_SSH_USER` | `deploy` |
| `OCI_SSH_PRIVATE_KEY` | contents of `~/.ssh/money_space_deploy` — see below |
| `APP_DIR` | `/opt/money-space` |

For the SSH key, copy the **private** half, including both `BEGIN`/`END` lines:

```bash
cat ~/.ssh/money_space_deploy | pbcopy
```

The matching public key is already installed on the VM by Terraform. Do not use
your personal `id_ed25519` — a dedicated key can be revoked on its own if the
GitHub account is ever compromised.

### Container registry (OCIR)

| Secret | Value |
| --- | --- |
| `OCIR_REGISTRY` | `ap-singapore-1.ocir.io` |
| `OCIR_NAMESPACE` | `axttup8tl3ug` |
| `OCIR_REPOSITORY` | `money-space-backend` |
| `OCIR_USERNAME` | `axttup8tl3ug/quan5080@gmail.com` |
| `OCIR_TOKEN` | an Auth Token — see below |

`OCIR_TOKEN` is **not** your Oracle password. Generate one at
**Console → Profile → My profile → Auth tokens → Generate token**, and copy it
immediately — Oracle shows it exactly once.

If your account is federated (you sign in through an identity provider),
`OCIR_USERNAME` needs the provider prefix:
`axttup8tl3ug/oracleidentitycloudservice/quan5080@gmail.com`. If `docker login`
fails with the plain form, this is why.

### Application secrets

Copy these from your local `.env` — the same values the app already uses:

| Secret |
| --- |
| `DATABASE_URL` |
| `DIRECT_URL` |
| `SUPABASE_URL` |
| `SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` |
| `SUPABASE_JWKS_URL` |

`REDIS_URL` is deliberately **not** a secret: Compose sets it to
`redis://redis:6379` on the server, because inside the Docker network the host
is the service name.

---

## 2. Variables

**Same page → Variables tab → New repository variable**

Variables are visible in logs, which is fine — none of these are sensitive.
Putting them here rather than in secrets means you can read back what is set.

| Variable | Value | Required |
| --- | --- | --- |
| `DOMAIN_NAME` | `moneytogether.dpdns.org` | yes, for HTTPS |
| `BUILD_PLATFORM` | `linux/arm64` | yes |
| `ACME_EMAIL` | your e-mail | no |
| `APP_PORT` | `3000` | no, this is the default |
| `REDIS_MAXMEMORY` | `256mb` | no, this is the default |

Two of these matter more than they look:

**`BUILD_PLATFORM`** must match the VM's CPU. The instance is Ampere (arm64), so
`linux/arm64`. Build for the wrong architecture and the container exits
immediately with `exec format error`. Re-read it any time with
`terraform output -raw image_platform`.

**`DOMAIN_NAME`** is the on/off switch for HTTPS. Set, Caddy starts and requests
a Let's Encrypt certificate; empty, Caddy stays down and the app is served over
plain HTTP on port 3000.

---

## 3. Deploy

Push to `master`:

```bash
git push origin master
```

Only `master` deploys. The workflow can also be started by hand from
**Actions → Deploy backend to OCI → Run workflow** — useful for running
migrations or redeploying without an empty commit — but it refuses to run from
any other branch.

The first run takes longer than later ones: the arm64 build is emulated on an
x86 runner, and there is no layer cache yet. Expect 10–15 minutes; subsequent
deploys are a few minutes.

### Verifying

The workflow checks itself and fails loudly if either path is broken. By hand:

```bash
curl https://moneytogether.dpdns.org/health
curl http://134.185.85.59:3000/health          # direct, bypasses Caddy
```

A healthy response looks like:

```json
{"success":true,"statusCode":200,"data":{"status":"ok","service":"money-space-backend"}}
```

### Database migrations

Off by default, so a routine push never changes the schema. To run them, start
the workflow manually and tick **Run `prisma migrate deploy`**.

---

## 4. Point the frontend at it

The frontend reads `VITE_API_BASE_URL` (`src/shared/api/env.ts`), defaulting to
`http://localhost:3000`. For a deployed build:

```
VITE_API_BASE_URL=https://moneytogether.dpdns.org
```

Use the HTTPS URL, not the IP: a browser on an HTTPS page blocks plain-HTTP API
calls as mixed content, and the request never reaches the server.

---

## Troubleshooting

**`docker login` fails in the workflow.** Almost always `OCIR_USERNAME`. Try the
federated form with `oracleidentitycloudservice/` in the middle. Also check that
`OCIR_TOKEN` is an Auth Token and not your account password.

**`exec format error` in the container logs.** `BUILD_PLATFORM` does not match
the VM. It should be `linux/arm64` for this Ampere instance.

**HTTPS never comes up, the backend is fine.** DNS or port 80. Confirm the
record still points at the server:

```bash
dig +short moneytogether.dpdns.org     # must print 134.185.85.59
ssh deploy@134.185.85.59 'cd /opt/money-space && docker compose logs --tail 50 caddy'
```

Port 80 has to stay open permanently, not just for the first certificate —
renewals use the same HTTP-01 challenge. Closing it breaks renewal silently,
weeks after the change that looked harmless.

**Deploy succeeds but the API does not answer.**

```bash
ssh deploy@134.185.85.59
cd /opt/money-space
docker compose ps
docker compose logs --tail 80 backend
```

**Rolling back.** Images are tagged with the commit SHA, so a previous build can
be started directly:

```bash
ssh deploy@134.185.85.59
cd /opt/money-space
sed -i "s|^BACKEND_IMAGE=.*|BACKEND_IMAGE=\"ap-singapore-1.ocir.io/axttup8tl3ug/money-space-backend:<sha>\"|" .env
docker compose --profile tls up -d
```

---

## What lives where

| | |
| --- | --- |
| `.github/workflows/deploy.yml` | build, push, deploy, verify |
| `deploy/docker-compose.prod.yml` | the stack the VM runs |
| `deploy/Caddyfile` | reverse proxy and TLS |
| `terraform/` | the infrastructure, and how to change it |

Secrets live in GitHub, never in Terraform state — Terraform stores every value
it manages in plain text, so the two are kept apart deliberately.
