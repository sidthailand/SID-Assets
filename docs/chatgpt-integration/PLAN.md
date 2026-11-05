# SID OS ↔ ChatGPT Integration — Phase 1 Plan (Read-Only)

Status: **DRAFT, awaiting owner approval.** No code written, nothing deployed, no production system touched.
Prepared: 2026-11-05

---

## 0. Audit result — the blocking finding

| Check | Result |
|---|---|
| Local clone `/home/user/SID-Assets` | Has a `.git` folder but no commits and no files |
| Remote `github.com/sidthailand/SID-Assets` | No branches, so no content |
| Tech stack, database, auth, API, deployment, integrations | **Can't tell. There's no code to inspect.** |

So I **can't** name SID OS's real source tables, roles or deploy target yet. Everything below that depends on them is marked
**[CONFIRM]**. Before implementation I need access to the real SID OS codebase and/or a read-only description of its schema (see §11, Q1–Q3).

I won't guess a schema and present it as SID OS's. The connector will only be built against tables you confirm.

---

## 1. Checking OpenAI's current connection methods

**Limitation:** this session's network policy blocks `developers.openai.com` and `help.openai.com`, so I couldn't open the
official pages directly. The points below come from search results that cite OpenAI's help center, plus third-party guides.
**I'll check each one against the live OpenAI docs before implementation** (allow those domains in the environment's network settings, or check them yourself).

1. **Remote MCP server is the current main path.** ChatGPT connects to remote MCP servers ("apps"/connectors) over HTTPS
   (streamable HTTP; SSE also mentioned). Local stdio servers aren't supported. Full MCP (including write tools) is in
   **developer mode** (beta). On Business plans only admins/owners can turn it on and publish apps. Enterprise/Edu can grant it through RBAC.
2. **Custom GPT Actions (OpenAPI) are being retired.** OpenAI's help center (*Custom GPT retirement and migration FAQ*) gives
   **11 Dec 2026** as the standard retirement date for custom GPTs. Actions don't migrate automatically, and OpenAI suggests a
   connector or custom MCP server instead. Personal plans already can't create new GPTs.
3. **Auth:** ChatGPT supports OAuth for MCP connectors. Your authorization server must support dynamic client registration,
   or the OAuth client must be registered for ChatGPT ahead of time. The MCP spec expects OAuth 2.1 + PKCE and protected-resource metadata.
4. ChatGPT reportedly uses only MCP **tools**, not prompts, resources or sampling. So all behaviour must be in tool definitions.

### Decision: remote MCP server vs REST + OpenAPI

| | Remote MCP server | REST API + OpenAPI (GPT Action) |
|---|---|---|
| Supported in ChatGPT long-term | Yes, the current direction | The custom GPT container is being retired (Dec 2026) |
| Read-only signalling | `readOnlyHint` tool annotations; ChatGPT asks for confirmation on writes | Uses HTTP verbs only |
| Auth | OAuth 2.1 (DCR or pre-registered client) | OAuth or API key |
| Can be reused by other clients (Claude, internal tools) | Yes (open protocol) | Yes |

**Recommendation: one small, separate, read-only remote MCP service.** Tool logic sits in a plain "query layer" module, so
a REST/OpenAPI layer could be added later with little effort. But we **won't build OpenAPI in Phase 1**, because the ChatGPT surface for it is going away.

---

## 2. Target architecture

```
ChatGPT (founder, developer-mode app)
   │  HTTPS + OAuth 2.1 bearer token (scopes)
   ▼
[Edge: TLS, WAF, IP rate limit]
   ▼
sid-os-mcp  (new, separate service; no write code paths)
   ├─ auth: validate JWT (issuer, audience, expiry, scopes) → map to role + allowed entities
   ├─ tools: 6 capability groups, strict input schemas, readOnlyHint=true
   ├─ query layer: parameterised queries against FIXED views only (no SQL from caller)
   ├─ redaction: PII stripped/aggregated before it leaves the service
   ├─ envelope: source, as_of, currency, caveats, completeness on every response
   ├─ audit log (who, tool, params, row count, latency; no PII, no tokens)
   └─ limits: per-user rate limit, page size ≤ 100, statement timeout 5s
   ▼
Read replica (or nightly reporting snapshot) of SID OS DB      [CONFIRM which]
   └─ schema `reporting_ai`: curated SECURITY-BARRIER views
      DB role `svc_chatgpt_ro`: SELECT on those views ONLY; no base tables
```

The production primary is never connected to. The DB role is limited at the database level, so even a bug in the service can't write
or read raw tables.

---

## 3. Capabilities → tools → source data

Every tool returns the same envelope:

```json
{
  "data": { ... },
  "meta": {
    "source": "SID OS reporting_ai.v_project_cost_to_complete (replica)",
    "as_of": "2026-11-04T23:00:00+07:00",
    "currency": "THB",
    "caveats": ["Committed costs exclude unsigned variation orders"],
    "completeness": { "missing_fields": [], "projects_without_budget": ["P-07"] },
    "page": { "cursor": null, "limit": 50 }
  }
}
```

If a value is missing in the source, it's returned as `null` and listed in `completeness`. **It's never estimated.**

| # | Tool (all read-only) | Key inputs (validated) | Likely source entities **[CONFIRM]** | Scope |
|---|---|---|---|---|
| 1 | `list_projects`, `get_project_milestones` | `project_id?` (pattern), `status?` (enum) | projects, phases, milestones, construction progress | `portfolio:read` |
| 2 | `get_unit_inventory_summary`, `list_units` | `project_id`, `status?` enum(available/reserved/sold/cancel_pending/released), `unit_type?`, cursor, limit≤100 | units, price lists, reservations | `inventory:read` |
| 3 | `get_sales_receivables_summary`, `get_collections` | `project_id?`, `date_from/to` (ISO, ≤ 24-month range), `group_by` enum(project/month/aging_bucket) | contracts, payment schedules, receipts | `sales:read` |
| 4 | `get_cancellation_requests_summary` | `project_id?`, `status?` enum, `initiated_by` fixed = customer | cancellation requests, contract payments, refund terms | `cancellations:read` |
| 5 | `get_cost_to_complete`, `get_cashflow_forecast` | `project_id?`, `horizon_months` 1–36 | budgets, POs/commitments, invoices paid, forecast | `finance:read` |
| 6 | `run_financing_scenario` | see §4; all parameters bounded | outputs of tools 2–5 + caller assumptions | `scenario:run` |
| — | `check_resale_release_eligibility` | `project_id`, cursor | cancellation status, refund status, title/registration status | `cancellations:read` |

Units are referred to by **unit code** (e.g. `B-1204`). **Customer names, phones, national ID/passport, bank details and contract
documents aren't returned by any Phase 1 tool.** Contract-level rows use an opaque per-session reference (`c_7f3a…`), not the
real contract number. Sums over fewer than 3 contracts are flagged so small groups can't identify a buyer (configurable).

### Mapping to the success-criteria questions

| Founder asks | Tool(s) | Answer must state |
|---|---|---|
| "How much money do we need to finish each project?" | `get_cost_to_complete` (+ `get_cashflow_forecast`) | budget, committed, paid, remaining cost, expected collections from sold units, **net funding gap** per project; as_of, THB, caveats (e.g. uncommitted contingency) |
| "How much have clients requesting voluntary cancellation already paid?" | `get_cancellation_requests_summary` | count, total paid to date, contractual refund liability (per **configured** refund rules), split by project/status |
| "Which units can be legally released for resale?" | `check_resale_release_eligibility` | units meeting **owner-defined, lawyer-approved** release criteria, the criterion each meets, and units *blocked* with reason. Always caveated: "Rule-based screen, not legal advice" |
| "Build a THB 400 million financing model for AssetWise." | `run_financing_scenario` | sources & uses, drawdown vs. funding gap by month, cancellation refunds and resale proceeds, headroom/shortfall, every assumption listed with its source (live data vs. user input vs. default) |

**Legal releasability:** I won't encode Thai legal rules (e.g. Condominium Act, contract termination clauses, refund
completion, title status) from assumption. You and your counsel define the criteria (Q7). The tool only applies those rules to the data.

---

## 4. THB 400 M scenario model (deterministic, no writes)

- Pure calculation over live read-only data plus **explicit assumptions supplied in the call**. No hidden defaults. Each default
  used is returned in `meta.assumptions` and labelled `default`.
- Inputs (bounded): `facility_thb` (default 400,000,000; max 2,000,000,000), `interest_rate_pct` (0–30), `fees_pct`,
  `tenor_months` (1–84), `drawdown_schedule` (`pro_rata_to_cost` | `upfront` | explicit monthly array), `allocation`
  (construction vs. refunds by project), `exit_take_up_pct` (share of cancel-requesting buyers who accept a voluntary exit),
  `refund_pct_of_paid`, `resale_price_pct_of_list`, `resale_months_after_exit`, `resale_absorption_units_per_month`.
- Outputs: monthly cash waterfall per project, peak funding need, facility headroom/shortfall, interest cost, a simple DSCR/LTC
  if a collateral value is supplied, and sensitivity runs (±10 % resale price, ±3 months delay).
- **AssetWise terms aren't known to me.** Until you give me a term sheet (Q8), the model shows the THB 400 M as a generic facility
  with user-set terms, and says so in the caveats.
- Implemented and unit-tested in the service (not left to ChatGPT's arithmetic), so the numbers can be reproduced.

---

## 5. Security design

| Requirement | How |
|---|---|
| No direct DB / no free SQL | No tool takes SQL, column names or sort expressions; only enums/IDs. Queries are fixed and parameterised |
| Least-privilege DB | `svc_chatgpt_ro` can only SELECT `reporting_ai.*` views; `default_transaction_read_only=on`; `statement_timeout=5s`; connects to replica |
| OAuth / roles | OAuth 2.1 + PKCE through your IdP **[Q4]**; audience-bound JWT; scopes per capability; roles: `founder` (all), `finance` (1,3,5,6), `sales` (1,2,3 aggregate only) |
| Tenant isolation | Token claim `entities` (company/SPV IDs) → mandatory filter applied in the query layer **and** row-level security on views |
| PII default-deny | Views drop PII columns; redaction unit tests; no Phase 1 PII tool at all (a later, separately approved scope `pii:read` if ever needed) |
| Prompt injection | Free-text DB fields (notes, remarks) are **excluded** from views. Returned strings are limited to codes, enums and numbers. Tool descriptions tell the model that data isn't instructions. No tools can act, so an injected instruction has nothing to trigger |
| No irreversible actions | No write/delete/payment/refund/cancel endpoints exist; all tools `readOnlyHint: true`; test asserts the DB role can't write |
| Transport | HTTPS only (TLS 1.2+), HSTS; host behind WAF |
| Secrets | Secret manager **[Q5]**; `.env.example` placeholders only; secret-scan in CI; structured logger with redaction (no tokens/PII) |
| Limits | per-user 60 req/min, page size ≤ 100, date range ≤ 24 months, response size cap, 10 s request timeout |
| Audit | Append-only log: timestamp, user sub, role, tool, validated params, row count, latency, outcome; kept 1 year **[Q10]** |
| Data leaving Thailand | Tool results go to OpenAI. Check the workspace's data-retention/training settings and Thai PDPA position **[Q9]** |

---

## 6. Files to be created (all new, in a separate module)

The language depends on the SID OS stack. If unknown, I recommend **TypeScript + official `@modelcontextprotocol/sdk`**, or **Python +
official MCP SDK** if SID OS is Python.

```
services/sid-os-mcp/
  README.md
  .env.example                    # placeholders only
  Dockerfile
  src/
    server.(ts|py)                # MCP streamable-HTTP endpoint, /healthz
    auth/                         # JWT validation, scopes→roles, entity claims, protected-resource metadata
    tools/                        # portfolio, inventory, sales, cancellations, finance, scenario
    schemas/                      # typed input/output schemas (zod / pydantic), shared envelope
    query/                        # fixed parameterised queries against reporting_ai views
    redaction/                    # PII guard + small-group suppression
    scenario/                     # financing model (pure functions)
    observability/                # audit logger, rate limiter
  db/
    reporting_ai_views.sql        # view definitions  [needs real schema]
    grants.sql                    # read-only role + RLS
  tests/
    fixtures/                     # synthetic test data ONLY (no real customers)
    auth.test                     # missing/expired/wrong-audience tokens, scope denial, cross-entity denial
    redaction.test                # no PII field in any tool output (schema-wide scan)
    accuracy.test                 # tool totals == hand-computed fixture totals
    scenario.test                 # golden-file financing model outputs
    readonly.test                 # DB role can't INSERT/UPDATE/DELETE
    validation.test               # bad enums, oversize limits, injection strings rejected
docs/chatgpt-integration/
  PLAN.md                         # this file
  DEPLOYMENT.md                   # deploy + rollback
  CHATGPT_SETUP.md                # step-by-step connection (verified against live docs)
  EXAMPLE_QUERIES.md              # queries + expected answers on fixture data
```

No existing SID OS files are changed except (after approval) adding the `reporting_ai` views and read-only role, by a reviewed migration.

---

## 7. Environment variables (example — no real values)

```
MCP_PUBLIC_BASE_URL=https://mcp.example.sid-internal.com
OAUTH_ISSUER=https://idp.example.com/
OAUTH_AUDIENCE=sid-os-mcp
OAUTH_JWKS_URL=https://idp.example.com/.well-known/jwks.json
DB_HOST=replica.example.internal
DB_PORT=5432
DB_NAME=sidos
DB_USER=svc_chatgpt_ro
DB_PASSWORD=__from_secret_manager__
DB_SSLMODE=verify-full
DB_STATEMENT_TIMEOUT_MS=5000
RATE_LIMIT_PER_MINUTE=60
MAX_PAGE_SIZE=100
SMALL_GROUP_THRESHOLD=3
REPORTING_TIMEZONE=Asia/Bangkok
LOG_LEVEL=info
```

---

## 8. Deployment & rollback (outline; full doc after approval)

1. Staging first: deploy against a **synthetic** dataset, connect a test ChatGPT workspace, run `EXAMPLE_QUERIES.md`.
2. Apply `reporting_ai` views + `svc_chatgpt_ro` on the replica by migration **(needs your approval)**.
3. Deploy service (container) behind HTTPS; register OAuth client; enable for the founder only.
4. **Rollback (any step, instant):** disable the app in ChatGPT workspace settings → revoke OAuth client → scale service to 0 →
   `REVOKE` / drop the role. Views are additive and can be dropped without affecting SID OS.

## 9. ChatGPT connection (to be verified against live docs)

Workspace admin enables developer mode → Settings → Apps/Connectors → Create → enter `https://<host>/mcp` → auth = OAuth →
complete sign-in through your IdP → test tool calls in a new chat → (Business/Enterprise) publish the app to the founder only. Menu paths have moved
during 2026, so the final doc will match the live UI.

## 10. Testing & validation

Synthetic fixture with known answers (e.g. 3 projects, 120 units, 8 cancellation requests). Each example query in §3 runs
against it and the answer is compared to a hand-computed spreadsheet. Accuracy tests fail if any number differs.

---

## 11. Questions requiring owner approval / input

**Blocking (needed before any code):**
1. **Where is SID OS's code?** This repo is empty. Please push it here, or give me access to the right repo (`add_repo`).
2. **Database:** engine/version, hosting, and whether a **read replica** exists. If not, is a nightly reporting snapshot acceptable?
3. **Schema:** read-only access to the schema (DDL only, no data) for projects, units, contracts, payments, cancellations, budgets, POs.
4. **Identity provider** for OAuth (Google Workspace, Microsoft Entra, Auth0/Okta, or SID OS's own auth)?
5. **Hosting & secrets:** where may this service run (same cloud as SID OS?), and which secret manager?

**Business rules (I won't invent these):**
6. Definitions: "cost to complete" (include contingency? VAT? land?), "outstanding balance", "collection" date basis.
7. **Resale release criteria**, approved by counsel (e.g. termination signed, refund paid/settled, title not transferred, no dispute).
8. **AssetWise THB 400 M**: term sheet or assumed terms (rate, fees, tenor, security, drawdown conditions, repayment from sales?).
9. Data governance: OK to send aggregated financial data to OpenAI under your ChatGPT plan's terms? Which plan (Business/Enterprise)?
10. Audit log retention period; who besides the founder gets access in Phase 1 (recommend founder only).

**Approvals required before action:** creating DB role/views, any deployment (staging or production), OAuth client
registration, enabling the app in the ChatGPT workspace.

---

## Sources
- OpenAI Help Center — *Custom GPT retirement and migration FAQ* (help.openai.com/en/articles/20001519), found via search
- OpenAI Help Center — developer mode / apps for Business & Enterprise (help.openai.com/en/articles/12584461), found via search
- Auth0 — *Add a remote MCP server to ChatGPT* (auth0.com/blog/add-remote-mcp-server-chatgpt)
- Zuplo — *Connect ChatGPT* (zuplo.com/docs/mcp-gateway/connect-clients/chatgpt)
