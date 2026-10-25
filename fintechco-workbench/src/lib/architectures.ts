// Plain-language summaries of how Claude Code fits into FinTechCo: the Google Cloud reference
// architectures, a fraud-claims intake design, and three ways engineering teams run Claude Code.

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
  /** Heading shown above this section, opening a new group of sections. */
  groupIntro?: { kicker: string; title: string; lede: string };
  /** Extra panel rendered after the lanes (see src/lib/architectureExtras.ts). */
  extra?: "fraud-desk" | "review-judge";
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
  {
    id: "dashboards",
    nav: "Dashboards",
    title: "Trusted dashboards in days, not a months-long backlog",
    kicker: "One definition behind every number",
    headline: "Claude drafts the dashboard and the metric definitions behind it. Your reporting owner reviews them, and every chart and question uses the same numbers.",
    quote:
      "Dashboard requests usually wait weeks in a backlog, and the same metric ends up defined three different ways. Here Claude drafts the definitions and the dashboard in hours, the reporting owner reviews them like any other change, and everyone works from the same numbers.",
    lanes: [
      {
        label: "People",
        tone: "people",
        items: [
          { name: "Analyst", note: "Turns a stakeholder's request into a dashboard" },
          { name: "Reporting owner", note: "Approves new metrics and changes" },
          { name: "Metric owners", note: "Agree what each metric means" },
        ],
      },
      {
        label: "Building it",
        tone: "workspace",
        items: [
          { name: "Claude Code", note: "Drafts metric definitions, dashboards and charts from a plain-English request" },
          { name: "Shared glossary", note: "Approved definitions and chart standards" },
          { name: "Version history", note: "Every change reviewed before it goes live" },
        ],
      },
      {
        label: "Behind the scenes",
        tone: "platform",
        items: [
          { name: "Claude in your Google Cloud account", note: "Billed to your project" },
          { name: "Access as the signed-in person", note: "Same roles and row-level rules as the analyst" },
          { name: "Custom visuals when needed", note: "A small private app on the same definitions" },
        ],
      },
      {
        label: "Looker and BigQuery",
        tone: "data",
        items: [
          { name: "Business stakeholders", note: "Use dashboards and ask follow-ups in plain English" },
          { name: "One set of metric definitions", note: "Reused by every dashboard and question" },
          { name: "Trusted data", note: "Only approved views are exposed" },
        ],
      },
    ],
    steps: [
      "Ask. The analyst gives Claude the request in plain English, for example \"weekly churn by region, with a drill-down to each account.\"",
      "Check what exists. Claude looks at the metrics already defined, signed in as the analyst, so the same access rules apply.",
      "Build. Claude adds any new metrics using the approved glossary, drafts the dashboard in a test area, and checks it.",
      "Review and publish. The reporting owner approves the change, and it goes live. Custom visuals run as a small private app on the same definitions.",
      "Use and measure. Stakeholders explore the dashboard and ask follow-up questions in plain English. We track time from request to dashboard and how often it's used.",
    ],
    value: [
      { title: "Request to dashboard in days", detail: "Instead of weeks in a backlog", measure: "Days from request to published dashboard" },
      { title: "One definition per metric", detail: "No more three versions of \"active customer\"", measure: "Duplicate definitions retired" },
      { title: "Custom visuals without the wait", detail: "Bespoke charts built on the same numbers", measure: "Custom requests closed" },
      { title: "Self-service follow-ups", detail: "Stakeholders ask their own questions", measure: "Follow-up tickets avoided" },
      { title: "Access follows the person", detail: "Claude sees only what the user can see", measure: "Access exceptions and audit findings" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Access rules follow each user", "Usage and value tracking", "Changes tested before they go live", "Private apps that read approved data only"],
    watchouts: [
      "Protect the shared definitions. Claude can propose new metrics, but metric owners should approve changes to existing ones.",
      "Custom apps must read data as the user or through approved views. Don't give them broad access.",
      "Some of these connections are still in preview. Turn on only what each team needs.",
    ],
  },
  {
    id: "documents",
    nav: "Documents",
    title: "Turn incoming paperwork into decisions automatically",
    kicker: "Capture, check and route every document",
    headline: "Every document is sorted, read and checked within minutes of arriving. Clean ones go straight through, and people only see what needs a human.",
    quote:
      "This is the intake engine. Every document is sorted, read and checked within minutes. Clean documents go straight through, people only see the fields the system wasn't sure about, and missing items are requested the same day instead of weeks later.",
    lanes: [
      {
        label: "Arrives",
        tone: "people",
        items: [
          { name: "Email", note: "" },
          { name: "Web portal or app upload", note: "" },
          { name: "Scanned mail", note: "" },
          { name: "Partner file transfers", note: "" },
        ],
      },
      {
        label: "Understand",
        tone: "workspace",
        items: [
          { name: "Secure storage", note: "Encrypted with your own keys" },
          { name: "Sort and separate", note: "Identifies each document type in a bundle" },
          { name: "Read the fields", note: "With a confidence score for each one" },
          { name: "Read free text", note: "Notes, codes and summaries" },
        ],
      },
      {
        label: "Check and route",
        tone: "platform",
        items: [
          { name: "Check against our rules", note: "And against our existing records" },
          { name: "Confident and complete?", note: "Decides where each document goes" },
          { name: "Missing-information request", note: "Sent to the sender the same day" },
        ],
      },
      {
        label: "Act",
        tone: "data",
        items: [
          { name: "Straight through", note: "Clean documents go into our systems automatically" },
          { name: "Review screen", note: "People check only the uncertain fields, next to the original" },
          { name: "Corrections improve the system", note: "Every fix becomes training data" },
        ],
      },
    ],
    steps: [
      "Arrive. Documents come in by email, upload, scanned mail or partner transfer and are stored securely.",
      "Sort. The system identifies each document's type and splits bundles into individual documents.",
      "Read. It pulls out each field with a confidence score, and summarizes any free text.",
      "Check. Business rules and cross-checks against our records run on every document.",
      "Route. Confident, complete documents go straight into our systems. Uncertain fields go to a person, and anything missing is requested from the sender the same day.",
      "Learn and report. Reviewer corrections improve the system, and a dashboard shows how much flows through untouched, how long it takes, and the cost per document.",
    ],
    value: [
      { title: "No manual typing", detail: "Fields are captured automatically", measure: "Minutes of handling per document" },
      { title: "Right the first time", detail: "Problems and gaps are caught on arrival", measure: "Days waiting on the sender" },
      { title: "People handle exceptions only", detail: "Reviewers see just the uncertain fields", measure: "Share of documents with no human touch" },
      { title: "Better every week", detail: "Corrections feed back into the system", measure: "Accuracy over time" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Encrypted with your own keys", "Private network boundary", "Personal data masked before analytics", "Reports on speed, accuracy and cost"],
    watchouts: [
      "Set confidence thresholds by the cost of a mistake. A wrong bank account number matters more than a wrong middle initial.",
      "The review screen is your own app. Google's built-in review feature has been retired.",
      "Some newer document-reading options are in preview. Check region and encryption support before relying on them.",
    ],
  },
  {
    id: "fraud-claims",
    nav: "Fraud claims",
    title: "Every fraud report matched to the right customer in one click",
    kicker: "Reported fraud, matched to the right customer",
    headline: "App reports arrive structured. Emails don't. Claude reads every email, pulls the customer's records from the mainframe, and hands the analyst a ready-made case with the likely customer already found.",
    quote:
      "Today 12 analysts match 500 to 1,200 reports a day by hand, and emails sit in a queue while the investigation clock is already running. Here Claude does the reading, the lookup and the reformatting. The analyst confirms the match in one click, and every correction teaches the system.",
    lanes: [
      {
        label: "Arrives",
        tone: "people",
        items: [
          { name: "Bank app report", note: "Structured: claim type, card, amounts, customer ID" },
          { name: "Email to the fraud inbox", note: "Free form, attachments, forwarded threads" },
          { name: "Call center notes", note: "Typed by an agent during the call" },
        ],
      },
      {
        label: "Claude reads and shapes",
        tone: "workspace",
        items: [
          { name: "Read the message", note: "Who, what happened, when, how much, which card" },
          { name: "Classify the claim", note: "Card not present, account takeover, scam, lost card" },
          { name: "Fill the case format", note: "The exact fields the service desk expects" },
          { name: "Confidence on every field", note: "Low-confidence fields are flagged, never guessed" },
        ],
      },
      {
        label: "Matches to our records",
        tone: "platform",
        items: [
          { name: "Mainframe customer file", note: "Read-only lookup by name, email, phone, last four" },
          { name: "Card and payment history", note: "Confirms the disputed transactions exist" },
          { name: "Open and past cases", note: "Spots duplicates and repeat reporters" },
          { name: "Ranked customer matches", note: "Best CID plus related CIDs, such as joint holders" },
        ],
      },
      {
        label: "Analyst decides",
        tone: "data",
        items: [
          { name: "Case desk screen", note: "Email on the left, the prepared case on the right" },
          { name: "One-click match", note: "Confirm the CID, link a related one, or search" },
          { name: "Straight into the service desk", note: "The same queue the app reports use today" },
          { name: "Corrections feed back", note: "Every change becomes a test case" },
        ],
      },
    ],
    steps: [
      "Arrive. App reports go straight to the service desk as they do today. Emails and call notes land in a secure inbox, and card numbers are masked to the last four before anything else reads them.",
      "Read. Claude reads each email and pulls out the claim: type, dates, amounts, merchant, card, and how the customer can be reached. Each field gets a confidence score.",
      "Look up. Through read-only connections to the mainframe and card systems, it finds the customers who could have sent it and ranks them, including related customers such as a joint account holder.",
      "Shape. It converts everything into the service desk's case format, so an email case looks exactly like an app case.",
      "Decide. The analyst sees the original email next to the prepared case and the top matches, and confirms with one click. Nothing is filed without a person.",
      "Learn. Each confirmation or correction is saved as a test case. A judge model scores every day's work, and Claude proposes rule and instruction updates that only go live after they pass the tests and a lead approves them.",
    ],
    value: [
      { title: "Hours back every day", detail: "Analysts confirm instead of retyping and searching", measure: "Minutes per email case" },
      { title: "No reports left waiting", detail: "Emails are prepared as they arrive, at 500 or 1,200 a day", measure: "Time from email to case opened" },
      { title: "Fewer wrong matches", detail: "Ranked matches with the evidence shown, never a silent guess", measure: "Share of matches changed later" },
      { title: "Better every week", detail: "Corrections and the judge's scores drive each update", measure: "First-choice match accuracy" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Read-only mainframe access", "Card numbers masked to last four", "A person confirms every match", "Updates gated by tests and a lead", "Every lookup logged"],
    watchouts: [
      "The investigation clock usually starts when the bank receives the report, so an email that waits a day in a queue is a day lost. Prepare cases on arrival.",
      "Keep the match threshold strict. When two customers are close, show both and let the analyst choose; never file to a guess.",
      "Start with the mainframe's existing read APIs. If there aren't any, a read-only query service in front of it is the first piece of work.",
    ],
    extra: "fraud-desk",
  },
  {
    id: "laptops",
    nav: "Laptops",
    groupIntro: {
      kicker: "How engineers run Claude Code",
      title: "Three ways engineering teams run Claude Code every day",
      lede:
        "The same foundation, applied where engineers work: on their own laptops, on every pull request, and during incidents. Each runs through our own Google Cloud project, under our IAM and logging, and puts a person where a change becomes real.",
    },
    title: "Governed laptops: Claude Code for every engineer",
    kicker: "One set of rules on every machine",
    headline: "The everyday setup. People work in their own terminal and editor as they do today, and IT sets the rules from one place.",
    quote:
      "This is the pilot's starting point. IT installs one settings file on every laptop, engineers sign in with their existing Google identity, and every model call is made with our cloud credentials and shows up in our audit logs.",
    lanes: [
      {
        label: "People",
        tone: "people",
        items: [
          { name: "Engineers and data scientists", note: "Ask for a task in plain English" },
          { name: "Reliability engineers", note: "Scripts, runbooks and on-call tooling" },
        ],
      },
      {
        label: "On the laptop",
        tone: "workspace",
        items: [
          { name: "Claude Code", note: "In the terminal or editor; a permission check our policy sets" },
          { name: "Company settings file", note: "Rules, permissions and hooks; users can't edit it" },
          { name: "Hooks and sandbox", note: "Checks run before edits; commands reach approved hosts only" },
        ],
      },
      {
        label: "Behind the scenes",
        tone: "platform",
        items: [
          { name: "Corporate proxy", note: "Approved traffic only" },
          { name: "Claude through our Google Cloud project", note: "Our IAM and logging; not used for training" },
          { name: "Device management", note: "Installs and restores the settings file" },
        ],
      },
      {
        label: "Where the work lands",
        tone: "data",
        items: [
          { name: "Pull requests", note: "Security approves any change to the rules files" },
          { name: "Audit logs", note: "Every model call, by person" },
          { name: "Usage dashboards", note: "Cost and accepted changes per team" },
        ],
      },
    ],
    steps: [
      "Install the rules. IT's device management installs the company settings file on every laptop: permissions, hooks and the sandbox. Engineers can't change it.",
      "Ask. An engineer gives Claude Code a task. It reads the code and the team rulebook from the repository.",
      "Call the model privately. Each request leaves through the corporate proxy and reaches Claude through our own Google Cloud project, under our IAM.",
      "Check as it works. Hooks run before each edit and before Claude can say it's finished. The sandbox keeps commands off the open internet.",
      "Review. The engineer reviews the change and opens a pull request. Changes to the rules need the security team's approval.",
    ],
    value: [
      { title: "Faster everyday work", detail: "Tests, fixes and refactors done end to end", measure: "Time from ticket to merged change" },
      { title: "One rulebook", detail: "Managed settings override anything set locally", measure: "Risky actions blocked" },
      { title: "No keys on laptops", detail: "People sign in with their Google identity", measure: "Stored credentials found: zero" },
      { title: "Spend you can see", detail: "Model choice and budgets set per team", measure: "Cost per engineer per month" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Managed settings win", "Only company hooks run", "Bypass mode disabled", "Every call in audit logs"],
    watchouts: [
      "Start every team in Manual mode, set by the company policy, where Claude asks the engineer before edits and commands. Move a team to Auto mode only once the pilot data supports it.",
      "Keep the settings file in a repository with required reviews, so a rules change is a reviewed change.",
    ],
  },
  {
    id: "reviews",
    nav: "PR review",
    title: "Pull request review, graded by a second model",
    kicker: "Every change checked, and every check graded",
    headline: "Claude reviews every pull request before a person does. A separate judge model grades those reviews against a test set, so we know the reviewer is getting better, not just busier.",
    quote:
      "An automated reviewer is only useful if people trust it. So every review is graded: a judge model checks each comment against the code, a weekly test of planted bugs measures what it catches, and reviewers' thumbs up or down keep the judge honest.",
    lanes: [
      {
        label: "Trigger",
        tone: "people",
        items: [
          { name: "Engineer opens a pull request", note: "Any repository, any language" },
          { name: "Short-lived CI runner", note: "Inside our network; thrown away after each job" },
          { name: "Short-lived credential", note: "Swapped for the job's identity; no stored keys" },
        ],
      },
      {
        label: "Claude reviews",
        tone: "workspace",
        items: [
          { name: "Reads the change", note: "Plus the team rulebook and review rules" },
          { name: "Runs tests and secret scan", note: "The same checks a person would run" },
          { name: "Posts comments and fixes", note: "Plain English, with suggested changes" },
        ],
      },
      {
        label: "Judge and evaluations",
        tone: "platform",
        items: [
          { name: "Judge model grades each review", note: "Is the comment true, important and actionable?" },
          { name: "Planted-bug test set", note: "Known defects; measures what the reviewer catches" },
          { name: "Reviewer feedback", note: "Thumbs up or down on each comment" },
          { name: "Release gate", note: "A new prompt or model ships only if scores hold" },
        ],
      },
      {
        label: "Human decides",
        tone: "data",
        items: [
          { name: "Human reviewer", note: "Approves the merge; Claude never merges" },
          { name: "Quality dashboard", note: "Catch rate, false alarms and cost per review" },
        ],
      },
    ],
    steps: [
      "Trigger. Opening a pull request starts a job on a short-lived runner inside our network, with a short-lived credential.",
      "Review. Claude reads the change and the team's rules, runs the tests and secret scan, and posts comments and suggested fixes.",
      "Grade. A separate judge model, with its own instructions, scores every comment for accuracy, severity and whether it can be acted on. Comments it rates as wrong are flagged for a person, not hidden.",
      "Test. Each week the reviewer runs against a fixed set of pull requests with planted bugs. Catch rate and false alarms are tracked over time.",
      "Calibrate. Reviewers' thumbs up and down are compared with the judge's scores, so we notice if the judge drifts.",
      "Gate. Any change to the reviewer's prompt, rules or model ships only if it matches or beats the current scores.",
    ],
    value: [
      { title: "Faster reviews", detail: "Seniors review a change that already passes the checks", measure: "Time to first human review" },
      { title: "A reviewer we can trust", detail: "Every comment graded; wrong ones flagged", measure: "Share of comments rated correct" },
      { title: "Bugs caught early", detail: "Planted-bug tests measure it every week", measure: "Catch rate on the test set" },
      { title: "Safe to improve", detail: "Changes ship only if the scores hold", measure: "Score change per release" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Claude can comment, never merge", "Runner thrown away after each job", "Judge uses a separate prompt", "Every call logged to the CI identity"],
    watchouts: [
      "A judge model has blind spots too. Check a sample of its grades by hand every month, and keep the planted-bug set private so it isn't learned.",
      "Grade on a fixed rubric with written examples. Vague questions like 'is this a good review?' give noisy scores.",
    ],
    extra: "review-judge",
  },
  {
    id: "incidents",
    nav: "On-call",
    title: "On-call assistant: read-only investigation on every alert",
    kicker: "A first look at every incident in minutes",
    headline: "An alert starts an investigation that can read but not change. The on-call engineer gets a summary with evidence, and a proposed fix to accept or reject.",
    quote:
      "The first twenty minutes of an incident are spent gathering facts. Claude does that part as soon as the alert fires, with read-only access, so the on-call engineer starts from a summary instead of a blank screen.",
    lanes: [
      {
        label: "Trigger",
        tone: "people",
        items: [
          { name: "Monitoring alert", note: "For example, payment timeouts above normal" },
          { name: "Incident topic", note: "One message per alert starts a job" },
        ],
      },
      {
        label: "Claude investigates",
        tone: "workspace",
        items: [
          { name: "Headless Claude Code job", note: "Runs in Cloud Run with time and spend limits" },
          { name: "Reads logs and code", note: "Through a read-only connector; card data redacted" },
          { name: "Finds the likely cause", note: "With the evidence that supports it" },
        ],
      },
      {
        label: "Behind the scenes",
        tone: "platform",
        items: [
          { name: "Read-only service account", note: "Can read logs and code, nothing else" },
          { name: "Claude through our Google Cloud project", note: "Our IAM and logging; not used for training" },
          { name: "Full record", note: "What it read and concluded, attached to the incident" },
        ],
      },
      {
        label: "On-call decides",
        tone: "data",
        items: [
          { name: "Summary in the incident channel", note: "Likely cause, evidence, next steps" },
          { name: "Draft pull request", note: "A proposed fix and a test" },
          { name: "On-call engineer", note: "Merges through normal review, or closes it" },
        ],
      },
    ],
    steps: [
      "Alert. Monitoring fires and publishes a message that starts a short Cloud Run job.",
      "Investigate. Claude Code runs headless with read-only tools: it searches code and queries logs, but can't touch running systems.",
      "Summarize. It posts the likely cause with evidence in the incident channel.",
      "Propose. If the cause is in code, it opens a draft pull request with a fix and a test.",
      "Decide. The on-call engineer merges it through normal review, or closes it.",
    ],
    value: [
      { title: "Faster first look", detail: "Facts gathered before anyone logs in", measure: "Time to first useful summary" },
      { title: "Shorter incidents", detail: "Engineers start from evidence, not a blank screen", measure: "Time to resolve" },
      { title: "Safe by design", detail: "Read-only access; fixes go through review", measure: "Changes made without review: zero" },
      { title: "Costs capped", detail: "Time and spend limits on every job", measure: "Cost per incident" },
    ],
    guardrailsTitle: "Built-in safeguards",
    guardrails: ["Read-only access", "Card data redacted", "Time and spend limits", "Draft pull requests only"],
    watchouts: [
      "Add this after the pilot, once incident data shows where triage time actually goes.",
      "Noisy alerts will start noisy jobs. Fix alert quality first, or limit the assistant to the alerts that matter.",
    ],
  },
];
