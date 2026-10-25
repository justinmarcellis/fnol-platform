// Content for the "How this was built" page. Line counts and commits are from this repository's git history.

export const LANGUAGES = [
  { name: "TypeScript", lines: 2675, share: 79, use: "The website and its server: Next.js 15, React 19, Tailwind CSS" },
  { name: "Python", lines: 283, share: 8, use: "The demo code Claude fixes, and the automated checks that prove each fix" },
  { name: "Go", lines: 61, share: 2, use: "The payment health check in the card-leak scenario" },
  { name: "Shell + Docker", lines: 103, share: 3, use: "One-command deploy script and the container recipe" },
  { name: "Markdown + JSON", lines: 256, share: 8, use: "The rules Claude follows, its permissions, and the presenter script" },
];

export const SPRINTS = [
  {
    name: "Sprint 1 · Build",
    when: "Hour 1",
    cards: [
      { title: "Three scenarios with real automated checks", tag: "Feature" },
      { title: "Terminal, change view and business-impact panels", tag: "Feature" },
      { title: "Live mode with automatic fallback to replay", tag: "Reliability" },
      { title: "Container builds and passes all checks", tag: "Quality" },
    ],
  },
  {
    name: "Sprint 2 · Ship",
    when: "Hour 2",
    cards: [
      { title: "One-click controls, header cleaned up", tag: "Design" },
      { title: "Published at fintechco-workbench.web.app", tag: "Deploy" },
      { title: "Line-by-line playback at reading speed", tag: "Design" },
      { title: "Deploy script checks itself", tag: "Reliability" },
    ],
  },
  {
    name: "Sprint 3 · Story",
    when: "Hour 3",
    cards: [
      { title: "\"How it fits together\" page, five architectures", tag: "Feature" },
      { title: "Every word rewritten in plain English", tag: "Design" },
      { title: "Board scenario swapped for pull request review", tag: "Feature" },
      { title: "Presenter script and deck updated", tag: "Content" },
    ],
  },
  {
    name: "Sprint 4 · Harden",
    when: "Hour 4",
    cards: [
      { title: "Private workspace for every visitor", tag: "Reliability" },
      { title: "Chrome-only crash found and fixed", tag: "Quality" },
      { title: "Works on iPhone", tag: "Design" },
      { title: "Guided tour, permission tester and audit log", tag: "Security" },
      { title: "Real hooks and sandbox: blocked edits, required checks", tag: "Security" },
    ],
  },
];

export const ASKS = [
  "A one-click demo URL",
  "It must never fail live",
  "It all loads at once",
  "The Board demo is a trap",
  "Use plain human language",
  "What if many people use it?",
  "Chrome throws an error",
  "Make it work on an iPhone",
  "Show security, not just say it",
  "Keep costs low",
];

export const OUTCOMES = ["Reliable demo", "Clear story", "Safe and governed", "Cheap to run"];

/** Each decision links one ask (by index) to the outcomes (by index) it served. */
export const DECISIONS = [
  { ask: 0, decision: "One container on Cloud Run", why: "A real server can run real code and real checks. A slide or video can't.", outcomes: [0, 3] },
  { ask: 1, decision: "Replay with automatic fallback", why: "If the live model is slow or unavailable, a reviewed recording takes over mid-run, so the demo never stalls.", outcomes: [0] },
  { ask: 2, decision: "Pace playback in the browser", why: "Firebase delivered the whole stream at once, so the browser now plays it back line by line.", outcomes: [1] },
  { ask: 3, decision: "Swap in pull request review", why: "Present what you know. Code review is a pain every CTO has, and it backs up the 35% target.", outcomes: [1] },
  { ask: 4, decision: "Rewrite every label and line", why: "Executives buy outcomes, not acronyms. F2, PAN and MTTR became plain sentences.", outcomes: [1] },
  { ask: 5, decision: "Private workspace per visitor", why: "Each browser gets its own copy of the files, so nobody's clicks affect anyone else.", outcomes: [0, 2] },
  { ask: 6, decision: "Find the root cause, not a workaround", why: "Newer Chrome returns a value React treated as cleanup code. A one-line fix stopped the crash.", outcomes: [0] },
  { ask: 7, decision: "Stack the columns on small screens", why: "Same content, one column, and Run scrolls you to the terminal.", outcomes: [1] },
  { ask: 8, decision: "Permission tester and audit log", why: "Let people try a blocked action and see the record, instead of reading a policy.", outcomes: [2] },
  { ask: 9, decision: "One instance, no database, replay by default", why: "No always-on extras. A run costs cents, and idle workspaces delete themselves.", outcomes: [3] },
];
