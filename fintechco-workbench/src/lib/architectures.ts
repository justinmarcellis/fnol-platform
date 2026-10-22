// Executive summaries of the reference architectures from the Google Cloud deck (slides 17, 18, 20).

export interface Lane {
  label: string;
  tone: "people" | "workspace" | "platform" | "data";
  items: { name: string; note: string }[];
}

export interface Architecture {
  id: string;
  code: string;
  title: string;
  valueStatement: string;
  headline: string;
  quote: string;
  lanes: Lane[];
  steps: string[];
  value: { code: string; title: string; metric: string }[];
  guardrails: string[];
  watchouts: string[];
}

export const ARCHITECTURES: Architecture[] = [
  {
    id: "foundation",
    code: "F2",
    title: "Claude Code on Google Cloud: Shared Foundation",
    valueStatement: "Set up once",
    headline: "Every team inherits model access, approved tools, guardrails, telemetry, and cost controls.",
    quote:
      "This foundation is built once. The platform team sets up model access, the approved tools, guardrails, telemetry, and cost controls, and every team that uses Claude Code inherits them.",
    lanes: [
      {
        label: "Builders",
        tone: "people",
        items: [
          { name: "Engineers", note: "" },
          { name: "Data analysts", note: "" },
          { name: "BI developers", note: "" },
          { name: "PMs & designers", note: "" },
        ],
      },
      {
        label: "Workspace",
        tone: "workspace",
        items: [
          { name: "Claude Code CLI", note: "Headless runs in CI" },
          { name: "Cloud Workstations", note: "Managed dev environments" },
          { name: "CLAUDE.md templates", note: "Team conventions" },
          { name: "Skills · subagents · plan mode", note: "Repeatable workflows" },
        ],
      },
      {
        label: "Models & tools",
        tone: "platform",
        items: [
          { name: "Claude on Agent Platform", note: "Opus · Sonnet · Haiku" },
          { name: "Global or regional endpoint", note: "Data residency" },
          { name: "MCP: BigQuery · Looker · Toolbox", note: "IAM + audit logs" },
          { name: "Agent Registry", note: "Approved tool catalog" },
        ],
      },
      {
        label: "Data & delivery",
        tone: "data",
        items: [
          { name: "BigQuery · Dataform · Looker", note: "" },
          { name: "Git + pull requests", note: "Every change reviewed" },
          { name: "Cloud Build", note: "" },
          { name: "Cloud Run + IAP", note: "Private delivery" },
        ],
      },
    ],
    steps: [
      "Model access: enable Claude in Model Garden. Usage bills to the Google Cloud project, so there's no separate Anthropic account.",
      "Admin control: managed settings, which users can't override, fix the allowed tools, commands and MCP servers. Hooks block risky commands before they run.",
      "Tools: Google Cloud MCP servers use IAM and write audit logs, managed in Agent Registry.",
      "Telemetry: Claude Code OpenTelemetry sends sessions, tokens, cost and code changes to Cloud Monitoring or BigQuery, joined with billing.",
      "Cost: Sonnet by default and Opus for the hardest problems, with budgets and quotas per team.",
    ],
    value: [
      { code: "Security & policy", title: "Admin-managed settings, hooks, IAM read-prod / write-sandbox, VPC-SC · CMEK, keys in Secret Manager", metric: "Blocked risky actions" },
      { code: "Quality & review", title: "Plan mode before code, PR review by an owner, tests and assertions, shared skills and CLAUDE.md", metric: "Review coverage" },
      { code: "Observability", title: "OpenTelemetry → Cloud Monitoring / BigQuery, billing export by team, value dashboard", metric: "Baseline vs. pilot" },
      { code: "Cost to serve", title: "Sonnet by default, prompt-cache hit rate watched, budgets and quotas per team", metric: "Cost per team / use case" },
    ],
    guardrails: ["Baseline first", "Instrument every session", "Compare pilot vs. control", "Convert to hours, cycle time, cost", "Monthly value review"],
    watchouts: [
      "The Cloud CLI MCP server can change resources. Keep it out of sandboxes and read-only roles.",
      "Watch the prompt-cache hit rate, because it drives much of the cost in long sessions.",
      "Gemini CLI and Antigravity can use the same MCP servers, so the patterns still hold if a customer standardizes on Google's own agents.",
    ],
  },
  {
    id: "prototyping",
    code: "RA7",
    title: "Rapid Prototyping with Claude Code",
    valueStatement: "Value statement 3 · Prove ideas with working prototypes",
    headline: "Build it in days, try it, then fund or retire it.",
    quote:
      "This is how an idea becomes something people can click on in days. The idea owner writes a one-page brief, a builder pairs with Claude Code to build it, and stakeholders use a private preview. Then the business decides with evidence: fund it, iterate, or retire it.",
    lanes: [
      {
        label: "People",
        tone: "people",
        items: [
          { name: "Idea owner", note: "Writes a one-page brief" },
          { name: "Builder", note: "Pairs with Claude Code" },
        ],
      },
      {
        label: "Cloud Workstations",
        tone: "workspace",
        items: [
          { name: "Claude Code", note: "Plan mode first, then app, tests, deploy config" },
          { name: "CLAUDE.md + brief", note: "Conventions and the success test" },
          { name: "Git repository", note: "Branch per prototype" },
        ],
      },
      {
        label: "Agent Platform, tools & build",
        tone: "platform",
        items: [
          { name: "Claude on Agent Platform", note: "Billed to your project" },
          { name: "Read-only MCP servers", note: "BigQuery schemas, docs" },
          { name: "Cloud Build → Artifact Registry", note: "Builds and scans" },
          { name: "BigQuery sample data", note: "Synthetic or masked only" },
        ],
      },
      {
        label: "Preview & decide",
        tone: "data",
        items: [
          { name: "Cloud Run preview", note: "Tagged URL behind IAP" },
          { name: "Stakeholders", note: "Try it on real tasks" },
          { name: "Fund · iterate · retire", note: "Decide on evidence" },
        ],
      },
    ],
    steps: [
      "Brief: the idea owner writes the problem, the users, and the test that proves it works.",
      "Plan and build: in plan mode, Claude Code proposes the approach. After approval it writes the app, the tests, and the deployment config.",
      "Ground: allow-listed, read-only MCP servers give realistic data shapes without production access.",
      "Preview: Cloud Build deploys a tagged Cloud Run revision behind IAP. It scales to zero when idle.",
      "Decide: stakeholders try it on real tasks, then the sponsor funds, iterates on, or retires it.",
    ],
    value: [
      { code: "P1", title: "Idea to demo in days", metric: "Days from brief to first demo" },
      { code: "P2", title: "Cheap, disposable previews", metric: "Cost per prototype" },
      { code: "P3", title: "Decide on evidence", metric: "Time from first demo to decision" },
      { code: "P4", title: "Safe by default", metric: "Blocked tool calls" },
      { code: "P5", title: "Reusable starting point", metric: "Setup time for the next prototype" },
    ],
    guardrails: ["Managed settings + hooks", "Value telemetry", "Sandbox project + budget", "IAP · VPC-SC · Secret Manager"],
    watchouts: [
      "A prototype is not a product. Promotion goes through the normal delivery process: security review, threat model, load tests, and an owning team.",
      "Keep production out of the sandbox: synthetic or masked data, a separate project, read-only tools.",
      "Put a budget and an expiry label on every sandbox, so abandoned previews don't linger.",
    ],
  },
  {
    id: "data",
    code: "RA8",
    title: "Data Cleansing and Exploration with Claude Code",
    valueStatement: "Value statement 4 · Trusted data in hours",
    headline: "Explore in a sandbox, then ship cleaning rules as reviewed, tested code.",
    quote:
      "Analysts usually spend more time preparing data than analyzing it, and the cleaning logic ends up in notebooks nobody reviews. Here Claude Code does the profiling and the drafting, but every cleaning rule ships as reviewed, tested code, and production data stays protected.",
    lanes: [
      {
        label: "People",
        tone: "people",
        items: [
          { name: "Analyst", note: "Asks what needs fixing" },
          { name: "Data owner", note: "Reviews and approves the PR" },
          { name: "Data steward", note: "Owns the data dictionary" },
        ],
      },
      {
        label: "Cloud Workstations",
        tone: "workspace",
        items: [
          { name: "Claude Code", note: "Profiles tables, proposes rules in plan mode" },
          { name: "Dataform repository", note: "SQLX + assertions in Git" },
          { name: "CLAUDE.md + data dictionary", note: "Meanings, PII rules, SQL style" },
        ],
      },
      {
        label: "Agent Platform, MCP & Dataform",
        tone: "platform",
        items: [
          { name: "BigQuery MCP server", note: "Runs as the analyst; masked stays masked" },
          { name: "Dataform", note: "Dev writes sandbox; release writes curated" },
          { name: "Cost controls", note: "Max bytes billed, quotas" },
        ],
      },
      {
        label: "BigQuery",
        tone: "data",
        items: [
          { name: "Raw datasets", note: "Read-only for people and agents" },
          { name: "Sandbox dataset", note: "Scratch tables expire in 7 days" },
          { name: "Curated datasets", note: "Only the release run writes here" },
          { name: "Policy tags + masking", note: "PII stays masked" },
        ],
      },
    ],
    steps: [
      "Ask: the analyst asks in plain language, for example \"profile the orders tables and tell me what needs fixing.\"",
      "Explore: Claude Code reads schemas, samples and quality profiles through the BigQuery MCP server, as the analyst's own identity.",
      "Propose and codify: in plan mode it proposes cleaning rules with evidence, then writes each one as Dataform SQL with assertions, tested in a sandbox.",
      "Review and release: the data owner approves the pull request, and only the release service account writes curated tables.",
      "Monitor and measure: Knowledge Catalog scans quality and lineage, and telemetry feeds the value dashboard.",
    ],
    value: [
      { code: "C1", title: "Minutes to first look", metric: "Time from access to first profile" },
      { code: "C2", title: "Cleaning as reviewed code", metric: "Assertion failures caught in sandbox" },
      { code: "C3", title: "Visible quality", metric: "Quality score trend" },
      { code: "C4", title: "Safe exploration", metric: "Production writes blocked (target zero)" },
    ],
    guardrails: ["Managed settings + hooks", "Value telemetry", "IAM: read raw, write sandbox", "Audit logs + lineage"],
    watchouts: [
      "The agent sees what the analyst sees. Fix over-broad dataset access first, and keep PII behind policy tags.",
      "Cap exploration cost with maximum bytes billed and custom quotas, because an agent can issue many queries quickly.",
      "Enforce \"no production writes\" in IAM, not just in prompts. Hooks are a second layer.",
    ],
  },
];
