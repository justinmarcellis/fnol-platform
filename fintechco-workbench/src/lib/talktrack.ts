export interface TalkTrack {
  scenario: number;
  minutes: string;
  title: string;
  beats: string[];
}

/** About 11 minutes in total. The word-for-word version is DEMO_SCRIPT.md. */
export const TALK_TRACKS: TalkTrack[] = [
  {
    scenario: 1,
    minutes: "3½ min",
    title: "Find and fix leaked card numbers",
    beats: [
      "Open Governance. \"These are the rules Claude follows, kept in the repo and reviewed like code. Rule 1: never log a full card number.\" Switch to Permissions: \"Green is allowed, red is blocked. Claude can't send data out even if someone asks it to.\"",
      "Click Run. When the first checks fail: \"Before touching anything, it runs our checks. They fail. A full card number is reaching our logs today.\"",
      "When it finds the leaks: \"It found them in two systems written in two languages. One rule, applied everywhere.\"",
      "What changed: \"A small, readable fix: only the last four digits show, and the logs are now searchable. It didn't touch the checks themselves.\"",
      "Scorecard: \"Three leaks down to zero, proven by tests. And consistent logs are why we expect incidents to be resolved in half the time.\"",
    ],
  },
  {
    scenario: 2,
    minutes: "3½ min",
    title: "Turn a fraud model into a production service",
    beats: [
      "Set up: \"A data scientist builds a fraud model as an experiment. Turning it into something production can rely on usually takes engineers weeks.\"",
      "Click Run. When the score of 1.44 appears: \"It tested the model first, and the fraud probability came back as 1.44. That's impossible, and today it would ship.\"",
      "What changed: \"The score now stays between 0 and 1, every payment gets a clear approve, review or decline, bad inputs are rejected, and other teams get one shared definition.\"",
      "Try it: click Check this payment. \"This is the service Claude just built, running live. $4,500 from overseas: declined.\" Pick the $25 coffee: \"Approved.\"",
      "Impact: \"Experiment to production in hours, not weeks. Across 160 people, that's our 35% faster target.\"",
    ],
  },
  {
    scenario: 3,
    minutes: "3½ min",
    title: "Interest-rate stress test for the Board",
    beats: [
      "Set up: \"This one isn't for engineers. The risk team owes the Board an interest-rate analysis by Friday.\"",
      "Click Run. \"Our rules say Board numbers must be reproducible from the data we keep on record, so Claude writes the analysis itself, and tests check the math.\"",
      "Chart: hover across 2022. \"When the Fed raised rates, our late payments followed. That 0.91 is calculated live, not typed onto a slide.\"",
      "Read the three Board points aloud. \"The last one is something a risk officer can act on.\"",
      "Close: \"Three teams, one set of rules, a few cents per run.\" Click ROI Calculator to model FinTechCo's own numbers.",
    ],
  },
];

export interface Objection {
  topic: string;
  question: string;
  answer: string;
}

export const OBJECTIONS: Objection[] = [
  {
    topic: "Security",
    question: "\"Our code and customer data can't leave our cloud.\"",
    answer:
      "It doesn't. Claude runs inside your own Google Cloud or AWS account, under your existing access controls and audit logs, and the model provider keeps nothing. Your code isn't used to train models. The rules you saw are enforced by the software itself, not just written in a prompt.",
  },
  {
    topic: "Existing tools",
    question: "\"We already pay for Copilot. Why add this?\"",
    answer:
      "Autocomplete suggests the next line. Claude Code takes on a whole task: it reads the code, makes the change, runs the checks and keeps going until they pass, as you just saw. It also works for security, data and risk teams, not just people writing code in an editor. Keep both. They do different jobs.",
  },
  {
    topic: "Cost",
    question: "\"How do we stop costs running away?\"",
    answer:
      "Each run you saw cost a few cents, and the cost is shown every time. You set budgets per team, choose which models people can use, and see spend in the dashboards you already have. Even ten times this usage is small next to the $3.8M of engineering time we expect to free up.",
  },
  {
    topic: "Adoption",
    question: "\"How do we make sure people actually use it?\"",
    answer:
      "Start with 25 volunteers across engineering, data and security, and measure where they start. Give them shared rules and ready-made workflows for their five most common tasks, so day one is useful. Report progress weekly, and expand to all 180 only once the pilot hits its numbers.",
  },
];
