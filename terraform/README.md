# Deploying the backend to Oracle Cloud

Terraform provisions the host and network. GitHub Actions builds the image and
deploys it. The split is deliberate: application secrets stay in GitHub and
never enter Terraform state, which stores every value it manages in plain text.

```
Terraform ──> VCN + security list (22, 80, 443)
          └─> Ampere A1 instance (Docker pre-installed by cloud-init)
          └─> Reserved static public IP
          └─> OCIR container repository

GitHub Actions ──> docker build --platform linux/arm64
               ──> push to OCIR
               ──> ssh: write .env, docker compose pull && up -d

  https://moneytogether.dpdns.org
                │
             Caddy :443  ← Let's Encrypt cert, auto-renewed
                │
             NestJS :3000 ──> Redis
                │
                └──> Supabase (external)
```

DNS is the one manual step: DigitalPlat DPDNS exposes no API this configuration
can drive, so you create the A record by hand. The reserved static IP is what
keeps that a one-time job.

Everything below stays inside Oracle's Always Free tier, so it keeps running at
no cost after the Free Trial ends. The instance takes 1 OCPU / 4 GB of the
4 OCPU / 24 GB Ampere allowance, leaving room for more instances later.

---

## 1. Get OCI API credentials

No OCI CLI needed — the provider reads these from `terraform.tfvars`.

1. Sign in to the OCI Console.
2. Profile menu (top right) → **My profile** → **API keys** → **Add API key**.
3. Choose **Generate API key pair**, download the private key, click **Add**.
4. The Console then shows a configuration preview. Copy `user`, `fingerprint`,
   `tenancy` and `region` from it.
5. Move the private key somewhere stable and lock it down:

   ```bash
   mkdir -p ~/.oci && mv ~/Downloads/*.pem ~/.oci/oci_api_key.pem
   chmod 600 ~/.oci/oci_api_key.pem
   ```

## 2. Create the SSH keys

Two separate keys — yours for admin access, a dedicated one for CI:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519          -C "you@example.com"
ssh-keygen -t ed25519 -f ~/.ssh/money_space_deploy  -C "github-actions" -N ""
```

## 3. Provision

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars          # paste the values from steps 1 and 2

terraform init
terraform plan
terraform apply
```

`terraform apply` prints the values the workflow needs:

```bash
terraform output github_secrets_checklist
terraform output instance_public_ip
```

> **"Out of host capacity"** is the usual first result, and it is not a
> configuration error — free Ampere capacity is heavily contended, and in
> single-AD regions like `ap-singapore-1` there is no second AD to fall back to.
> The network resources still get created; only the instance fails.
>
> Two ways forward, and they combine well:
>
> **Retry.** Capacity frees up unpredictably when other tenants release hosts.
> Each attempt is only a few seconds once the network exists:
>
> ```bash
> ./retry-ampere.sh          # every 30s, until it succeeds
> ./retry-ampere.sh 60       # every 60s
> ./retry-ampere.sh 30 100   # every 30s, give up after 100 attempts
> ```
>
> Ctrl-C stops it cleanly — the signal is handled between attempts, never during
> one, so Terraform is not interrupted mid-apply and the state is never left
> locked or out of sync with what OCI actually created. The script also stops on
> its own if it hits an error that is *not* a capacity problem (bad credentials,
> a quota limit), since retrying those just wastes time.
>
> **Fall back to x86.** `VM.Standard.E2.1.Micro` is also Always Free and almost
> always available, at 1 OCPU / 1 GB:
>
> ```bash
> terraform apply -var-file=terraform.tfvars -var-file=x86.tfvars
> ```
>
> The stack does fit: measured at ~98 MB for Nest under load and ~33 MB for
> Redis, leaving roughly half the gigabyte free after Ubuntu and Docker. It works
> because images are built on GitHub Actions and only pulled here — building on
> a 1 GB box would not fit.
>
> Switching shapes changes the CPU architecture, so two things must follow:
>
> - set the `BUILD_PLATFORM` GitHub variable to `terraform output -raw image_platform`
>   (`linux/amd64`), otherwise the container dies with "exec format error";
> - optionally set `REDIS_MAXMEMORY` to something like `64mb`, since the default
>   256 MB is a quarter of this machine.
>
> Moving back to Ampere later is the same command without `-var-file=x86.tfvars`.
> Either switch replaces the instance, but the reserved IP is a separate
> resource and survives — DNS and the certificate are unaffected.

## 4. Point the domain at the instance

`moneytogether.dpdns.org` is registered but has no A record yet, so create one
before deploying — Caddy cannot obtain a certificate for a name that does not
resolve here.

1. Read the address Terraform reserved:

   ```bash
   terraform output -raw instance_public_ip
   terraform output dns_record_to_create     # the record, spelled out
   ```

2. Sign in at <https://dash.domain.digitalplat.org> → your domain → **DNS**.
3. Add:

   | Type | Name | Value | TTL |
   | --- | --- | --- | --- |
   | `A` | `@` | the IP from step 1 | 300 |

   **Name is `@`, not `moneytogether`.** The zone you manage on DigitalPlat is
   already `moneytogether.dpdns.org`, so `@` means the zone itself. Entering the
   subdomain again asks for `moneytogether.moneytogether.dpdns.org` and the
   dashboard rejects it with "Record names must stay inside this DNS zone". Some
   dashboards accept an empty Name or the full FQDN for the same thing.

   If DigitalPlat offers a proxy/cloud toggle, leave it **off** — a proxy
   intercepts the ACME HTTP-01 challenge and issuance fails.

4. Wait for it to propagate, then confirm:

   ```bash
   dig +short moneytogether.dpdns.org
   ```

   It must print exactly the IP from step 1 before you deploy. This is normally
   a minute or two; the record is new, so there is no stale cache to expire.

Because the IP is reserved, this survives instance stop/start and even
`terraform destroy` of the instance alone — you will not need to touch DNS again.

## 5. Configure GitHub

Repository → **Settings** → **Secrets and variables** → **Actions**.

**Secrets** — infrastructure:

| Secret | Where it comes from |
| --- | --- |
| `OCI_HOST` | `terraform output instance_public_ip` |
| `OCI_SSH_USER` | `deploy` |
| `OCI_SSH_PRIVATE_KEY` | contents of `~/.ssh/money_space_deploy` (the private half) |
| `APP_DIR` | `terraform output app_dir` → `/opt/money-space` |
| `OCIR_REGISTRY` | `terraform output ocir_endpoint` |
| `OCIR_NAMESPACE` | `terraform output ocir_namespace` |
| `OCIR_REPOSITORY` | `money-space-backend` |
| `OCIR_USERNAME` | `<namespace>/<oci-username>` — for federated logins, `<namespace>/oracleidentitycloudservice/<username>` |
| `OCIR_TOKEN` | Console → Profile → **Auth Tokens** → Generate. Not your password. |

**Secrets** — application, copied from your local `.env`:

`DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWKS_URL`

**Variables** (Settings → Variables tab, not Secrets — these are not sensitive):

| Variable | Value |
| --- | --- |
| `DOMAIN_NAME` | `moneytogether.dpdns.org` — leaving it empty disables Caddy and serves plain HTTP |
| `BUILD_PLATFORM` | `terraform output -raw image_platform` — `linux/arm64` on Ampere, `linux/amd64` on E2.1.Micro. Must match the instance or the container will not start |
| `ACME_EMAIL` | optional, for Let's Encrypt expiry notices |
| `APP_PORT` | optional, defaults to `3000` |
| `REDIS_MAXMEMORY` | optional, defaults to `256mb`; use `64mb` on the 1 GB x86 shape |

`DOMAIN_NAME` is what switches TLS on: the workflow starts Caddy under the `tls`
compose profile only when it is set, and the HTTPS verification step is skipped
when it is not.

## 6. Deploy

Push to `main`, or run **Actions → Deploy backend to OCI → Run workflow**.

The workflow waits for cloud-init to finish on the first run, so the initial
deploy takes a few minutes longer than later ones.

The workflow verifies both paths itself and fails loudly if either is broken.
To check by hand:

```bash
curl https://moneytogether.dpdns.org/health          # through Caddy, with TLS
curl http://$(terraform output -raw instance_public_ip):3000/health   # direct
```

The first certificate is issued a few seconds after Caddy starts. If HTTPS fails,
the usual cause is DNS: confirm `dig +short moneytogether.dpdns.org` matches
`terraform output -raw instance_public_ip`, then check `docker compose logs caddy`.

### Point the frontend at it

The frontend reads `VITE_API_BASE_URL` (see `src/shared/api/env.ts`), defaulting
to `http://localhost:3000`. Set it for the deployed build:

```
VITE_API_BASE_URL=https://moneytogether.dpdns.org
```

Use the HTTPS URL, not the bare IP: a browser on an HTTPS page blocks plain-HTTP
API calls as mixed content.

### Locking down port 3000

Once HTTPS is confirmed, close the direct route so everything goes through TLS:

```bash
terraform apply -var expose_app_port=false
```

Or set `expose_app_port = false` in `terraform.tfvars`. Nothing needs
redeploying — this only changes the security list.

### Database migrations

Off by default, so a routine push never mutates the schema. To run them, trigger
the workflow manually and tick **Run `prisma migrate deploy`**.

---

## Operating notes

**Logs and status**

```bash
ssh deploy@<ip>
cd /opt/money-space
docker compose ps
docker compose logs -f backend
```

**Bootstrap problems** — check cloud-init, not the app:

```bash
ssh ubuntu@<ip> 'sudo tail -50 /var/log/cloud-init-output.log'
ssh ubuntu@<ip> 'cloud-init status --long'
```

**Build time.** The A1 instance is aarch64, so the image is built for arm64. On
a free x86 runner that means QEMU emulation — slow. If your account has arm64
runners, change `runs-on: ubuntu-latest` to `runs-on: ubuntu-24.04-arm` in the
`build` job and it gets several times faster.

**Certificates.** Caddy renews automatically, roughly a month before expiry, and
stores everything in the `caddy_data` volume — so a redeploy reuses the existing
certificate rather than re-issuing. Keep port 80 open: renewal uses the same
HTTP-01 challenge as first issue, and closing it breaks renewals silently, weeks
after the deploy that closed it looked fine.

Let's Encrypt allows 5 duplicate certificates per name per week. Deleting the
volume (`docker compose down -v`) forces re-issue, so avoid it during debugging.

```bash
ssh deploy@<ip> 'cd /opt/money-space && docker compose logs --tail 50 caddy'
```

**Changing the domain.** Update the `DOMAIN_NAME` GitHub variable and
`domain_name` in `terraform.tfvars`, add the new A record, then redeploy. Caddy
requests the new certificate on startup.

**Resizing.** The instance runs on 1 OCPU / 4 GB, a quarter of the free Ampere
allowance. To give it more, raise `instance_ocpus` and `instance_memory_gbs`
together (A1 permits up to 64 GB per OCPU) and re-apply. Terraform replaces the
instance, so the app is down for a few minutes and the next deploy has to run —
but the reserved IP is a separate resource and survives, so DNS and the
certificate are untouched.

**Teardown.**

```bash
terraform destroy
```

## What is in this directory

| File | Purpose |
| --- | --- |
| `versions.tf` | Provider requirements and OCI authentication |
| `variables.tf` | Every input, with defaults |
| `main.tf` | Locals, image lookup, the Ampere A1 instance |
| `network.tf` | VCN, internet gateway, route table, security list, subnet |
| `cloudinit.tf` | Host bootstrap — Docker and the deploy user only |
| `registry.tf` | OCIR repository for the backend image |
| `reserved_ip.tf` | Static public IP, so the DNS record never needs updating |
| `x86.tfvars` | Fallback sizing for when Ampere capacity is unobtainable |
| `retry-ampere.sh` | Retry loop for the "Out of host capacity" wait |
| `checks.tf` | Preconditions that fail early with actionable messages |
| `outputs.tf` | IPs, registry coordinates, the GitHub secrets checklist |
| `templates/` | cloud-init template |

Deployment files live in [`../deploy/`](../deploy): `docker-compose.prod.yml`
(the stack the VM runs) and `Caddyfile` (the reverse proxy). The workflow copies
both to the instance and writes two env files next to them — `.env` for the app
and `.env.caddy` for the proxy, kept apart so Caddy never holds Supabase keys.
