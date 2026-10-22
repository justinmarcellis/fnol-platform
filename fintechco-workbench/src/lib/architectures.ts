// Plain-language summaries of the three Claude Code on Google Cloud reference architectures.

export interface Lane {
  label: string;
  tone: "people" | "workspace" | "platform" | "data";
  items: { name: string; note: string }[];
}

export interface Architecture {
  id: string;
  nav: string;
  title: string;
  kicker: string;
  headline: string;
  quote: string;
  lanes: Lane[];
  steps: string[];
  value: { title: string; detail: string; measure: string }[];
  guardrailsTitle: string;
  guardrails: string[];
  watchouts: string[];
}

export const ARCHITECTURES: Architecture[] = [
  {
    id: "foundation",
    nav: "Foundation",
    title: "One shared foundation for every team",
    kicker: "Set up once, reused everywhere",
    headline: "Your platform team sets up access, rules, monitoring and budgets one time. Every team that uses Claude gets them automatically.",
    quote:
      "This is built once. The platform team decides which models people can use, which tools Claude may touch, how usage is tracked, and what it can spend. Every team after that inherits those decisions instead of reinventing them.",
    lanes: [
      {
        label: "Who uses it",
        tone: "people",
        items: [
          { name: "Software engineers", note: "" },
          { name: "Data analysts", note: "" },
          { name: "Reporting teams", note: "" },
          { name: "Product managers and designers", note: "" },
        ],
      },
      {
        label: "Where they work",
        tone: "workspace",
        items: [
          { name: "Claude Code", note: "In the terminal, the editor, or automated pipelines" },
          { name: "Secure cloud desktops", note: "Managed by your IT team" },
          { name: "Team rulebooks", note: "Written instructions Claude follows every time" },
          { name: "Saved workflows", note: "Common tasks packaged for reuse" },
        ],
      },
      {
        label: "What powers it",
        tone: "platform",
        items: [
          { name: "Claude, inside your Google Cloud account", note: "Billed to your existing Google Cloud account" },
          { name: "Choice of region", note: "Keeps data where regulations require" },
          { name: "Approved connections", note: "To your data warehouse and dashboards, with access logged" },
          { name: "A catalog of approved tools", note: "Nothing unapproved gets connected" },
        ],
      },
      {
        label: "Where the work lands",
        tone: "data",
        items: [
          { name: "Your data warehouse and dashboards", note: "" },
          { name: "Code review", note: "Every change is reviewed by a person" },
          { name: "Automated builds", note: "" },
          { name: "Private, login-protected apps", note: "" },
        ],
      },
    ],
    steps: [
      "Turn on access. Claude runs inside your own Google Cloud account and is billed there, so there's no new vendor contract or separate login.",
      "Set the rules centrally. Administrators decide which tools and commands Claude may use. Individual users can't override this, and risky actions are blocked before they run.",
      "Connect only approved systems. Claude reaches your data through approved connections that use your existing permissions and keep a record of every request.",
      "Track usage and value. Activity, cost and output flow into the dashboards you already use, broken down by team.",
      "Control the spend. Use the standard model by default, save the most capable one for the hardest problems, and give each team its own budget.",
    ],
    value: [
      { title: "Security and policy", detail: "Central settings, blocked risky actions, read-only access to production, keys kept in a secure vault", measure: "Risky actions blocked" },
      { title: "Quality", detail: "Claude plans before it writes, a person reviews every change, and tests check the result", measure: "Share of changes reviewed and tested" },
      { title: "Visibility", detail: "Usage, cost and output by team in one dashboard", measure: "Results versus the pre-pilot baseline" },
      { title: "Cost control", detail: "Sensible defaults, budgets and limits for every team", measure: "Cost per team and per use case" },
    ],
    guardrailsTitle: "How we prove value",
    guardrails: ["Measure the starting point", "Track every session", "Compare pilot teams with the rest", "Convert to hours saved and cost", "Review monthly"],
    watchouts: [
      "Some connections can change systems as well as read them. Keep those out of test environments and read-only roles.",
      "Most of the cost in long sessions depends on how well repeated context is reused, so keep an eye on it from day one.",
      "These same rules and connections also work with Google's own AI tools, so the investment holds even if you add other assistants later.",
    ],
  },
  {
    id: "prototyping",
    nav: "Prototyping",
    title: "Turn an idea into a working prototype in days",
    kicker: "Prove ideas with something people can click",
    headline: "Build it in days, put it in front of real users, then decide to fund it, change it, or drop it.",
    quote:
      "This is how an idea becomes something people can try in days, not quarters. Someone writes a one-page brief, a builder works with Claude to build it, and stakeholders try a private version. Then the business decides with evidence.",
    lanes: [
      {
        label: "People",
        tone: "people",
        items: [
          { name: "Idea owner", note: "Writes a one-page brief" },
          { name: "Builder", note: "Works with Claude to build it" },
        ],
      },
      {
        label: "Building it",
        tone: "workspace",
        items: [
          { name: "Claude Code", note: "Proposes a plan first, then writes the app and its tests" },
          { name: "Brief and team rules", note: "What success looks like and how we build" },
          { name: "Version history", note: "Every change can be reviewed or undone" },
        ],
      },
      {
        label: "Behind the scenes",
        tone: "platform",
        items: [
          { name: "Claude in your Google Cloud account", note: "Billed to your project" },
          { name: "Read-only access to sample data", note: "Realistic, but never real customer data" },
          { name: "Automatic security checks", note: "Every version is scanned before it's shared" },
        ],
      },
      {
        label: "Try it and decide",
        tone: "data",
        items: [
          { name: "Private preview link", note: "Only invited people can open it" },
          { name: "Stakeholders try it", note: "On real tasks, with real feedback" },
          { name: "Fund, change, or drop", note: "A decision based on evidence" },
        ],
      },
    ],
    steps: [
      "Write the brief: the problem, who it's for, and how we'll know it works.",
      "Plan, then build. Claude proposes an approach, the builder approves it, and Claude writes the app and its tests.",
      "Use realistic data safely. Claude works from sample or masked data, never production.",
      "Share a private preview. Invited stakeholders get a link. It costs almost nothing while no one is using it.",
      "Decide. Stakeholders use it on real work, then the sponsor funds it, iterates, or retires it.",
    ],
    value: [
      { title: "Idea to demo in days", detail: "Not months of scoping", measure: "Days from brief to first demo" },
      { title: "Cheap to try", detail: "Previews cost little and are easy to throw away", measure: "Cost per prototype" },
      { title: "Decisions on evidence", detail: "People react to something real, not a slide", measure: "Time from first demo to decision" },
      { title: "Safe by default", detail: "No production data and no unapproved tools", measure: "Risky actions blocked" },
      { title: "Faster every time", detail: "Rules and templates carry over to the next idea", measure: "Setup time for the next prototype" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Central rules and blocked risky actions", "Usage and value tracking", "Separate budget for experiments", "Private links and secure key storage"],
    watchouts: [
      "A prototype isn't a product. Anything that gets funded still goes through security review, load testing and an owning team.",
      "Keep production data out. Use sample or masked data, in a separate project.",
      "Give every experiment a budget and an expiry date so forgotten ones don't keep costing money.",
    ],
  },
  {
    id: "data",
    nav: "Data quality",
    title: "Clean, trustworthy data in hours, not weeks",
    kicker: "Trusted data without the manual clean-up",
    headline: "Claude does the profiling and drafts the clean-up rules. People review them, and production data stays protected.",
    quote:
      "Analysts spend more time preparing data than analyzing it, and the clean-up logic usually lives in personal notebooks nobody checks. Here Claude does the legwork, but every rule is reviewed and tested before it touches real data.",
    lanes: [
      {
        label: "People",
        tone: "people",
        items: [
          { name: "Analyst", note: "Asks what needs fixing" },
          { name: "Data owner", note: "Reviews and approves changes" },
          { name: "Data steward", note: "Keeps definitions up to date" },
        ],
      },
      {
        label: "Doing the work",
        tone: "workspace",
        items: [
          { name: "Claude Code", note: "Profiles the data and proposes fixes, with evidence" },
          { name: "Clean-up rules as code", note: "Each rule saved, reviewed and tested" },
          { name: "Data dictionary", note: "What each field means and which fields are sensitive" },
        ],
      },
      {
        label: "Behind the scenes",
        tone: "platform",
        items: [
          { name: "Data access as the analyst", note: "Claude sees only what the analyst can see" },
          { name: "Scheduled releases", note: "Approved rules run on a schedule" },
          { name: "Spending limits", note: "A cap on how much data any query can scan" },
        ],
      },
      {
        label: "The data",
        tone: "data",
        items: [
          { name: "Original data", note: "Read-only for people and Claude" },
          { name: "Scratch area", note: "Test results delete themselves after 7 days" },
          { name: "Trusted data", note: "Only approved, tested rules write here" },
          { name: "Sensitive fields masked", note: "Personal data stays hidden" },
        ],
      },
    ],
    steps: [
      "Ask in plain English, for example \"Look at the orders data and tell me what needs fixing before I build a churn model.\"",
      "Claude explores the data with the analyst's own access, so anything masked stays masked.",
      "Claude proposes fixes with evidence (duplicates, wrong formats, missing values) and writes each one as a tested rule in a scratch area.",
      "The data owner reviews and approves. Only then does a scheduled release update the trusted data.",
      "Quality is monitored continuously, and the time saved shows up on the value dashboard.",
    ],
    value: [
      { title: "Minutes to first look", detail: "No waiting days for a data profile", measure: "Time from access to first profile" },
      { title: "Clean-up you can audit", detail: "Every rule is reviewed and tested", measure: "Problems caught before release" },
      { title: "Quality you can see", detail: "Scores and trends, not anecdotes", measure: "Quality score over time" },
      { title: "Safe exploration", detail: "Nothing writes to production by accident", measure: "Production changes blocked (target: zero)" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Central rules and blocked risky actions", "Usage and value tracking", "Read original data, write only to scratch", "Full record of every query and change"],
    watchouts: [
      "Claude sees what the analyst sees. Tighten over-broad data access first, and keep personal data masked.",
      "Set a spending limit per query. An assistant can run many queries quickly.",
      "Enforce \"no production changes\" with real permissions, not just instructions.",
    ],
  },
];
