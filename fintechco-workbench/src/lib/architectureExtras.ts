// Extra panels for two sections of the architectures page: the fraud-claims feedback loop and
// case desk, and the pull request review judge. All customers, CIDs and scores are fictional.

export const FRAUD_LOOP = {
  title: "The feedback loop",
  intro: "How the system learns to organize messy reports without anyone writing new rules by hand.",
  steps: [
    { name: "Analyst confirms or corrects", note: "Each decision is saved with the email and the fields" },
    { name: "Test set grows", note: "Corrections become labeled examples" },
    { name: "Judge model scores the day", note: "Field accuracy, match accuracy, missed details" },
    { name: "Claude proposes an update", note: "New instructions or matching rules, with the evidence" },
    { name: "Gate: tests pass, a lead approves", note: "Only then does the update go live" },
  ],
  back: "Back to step 1 with the next day's reports",
};

export interface DeskMatch {
  cid: string;
  name: string;
  relation: string;
  score: number;
  why: string;
  action: string;
}

export const FRAUD_DESK = {
  queued: 37,
  email: {
    from: "m.okafor.home@examplemail.com",
    received: "Today, 8:14 am",
    subject: "Fwd: charges I did NOT make!!",
    body: "Hi, I'm writing because I saw two charges on my debit card ending 4417 that I never made. One was $389.20 at ELECTROMART ONLINE on Tuesday the 20th and another $412.75 the same night. I still have my card. My wife Ada is also on the account, she didn't make them either. Please call me on 920-555-0148. Michael Okafor",
  },
  /** Fields below this confidence are flagged for the analyst. */
  flagBelow: 0.8,
  fields: [
    { name: "Claim type", value: "Card not present, unauthorized", confidence: 0.94 },
    { name: "Card", value: "Debit ending 4417", confidence: 0.99 },
    { name: "Transactions", value: "$389.20 and $412.75, ElectroMart Online, Oct 20", confidence: 0.91 },
    { name: "Card in possession", value: "Yes", confidence: 0.88 },
    { name: "Callback number", value: "920-555-0148", confidence: 0.97 },
    { name: "Other people on the account", value: "Ada Okafor (joint holder)", confidence: 0.72 },
  ],
  matches: [
    { cid: "CID 0047-221-930", name: "Michael A. Okafor", relation: "Primary holder", score: 0.96, why: "Card 4417 is his · phone matches · both charges found", action: "Match to this customer" },
    { cid: "CID 0047-221-931", name: "Ada N. Okafor", relation: "Related: joint holder", score: 0.81, why: "Joint holder on the same checking account", action: "Link as related" },
    { cid: "CID 0112-904-118", name: "Michael Okafor", relation: "Unlikely", score: 0.22, why: "Same name, different city, no card ending 4417", action: "Match anyway" },
  ] satisfies DeskMatch[],
};

export const REVIEW_JUDGE = {
  rubricTitle: "How the judge grades a review",
  rubricIntro:
    "A second Claude model, with its own rubric and no access to the reviewer's reasoning, scores each comment. Example scores from a weekly run:",
  rubric: [
    { question: "Correct", checks: "Is the problem real in this code?", score: 0.92 },
    { question: "Important", checks: "Would a senior engineer block on it?", score: 0.81 },
    { question: "Actionable", checks: "Is the fix clear and safe?", score: 0.88 },
  ],
  signalsTitle: "Three signals, one gate",
  signals: [
    { name: "Judge scores", note: "Every comment, every pull request" },
    { name: "Planted-bug test set", note: "Catch rate and false alarms, weekly" },
    { name: "Reviewer thumbs", note: "Keeps the judge calibrated to people" },
  ],
  gate: "A new prompt, rule or model ships only if all three hold or improve.",
  footnote: "Scores shown are illustrative; the pilot sets the real baseline.",
};
