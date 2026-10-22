# FinTechCo engineering rules

Claude reads this file at the start of every session. It is version-controlled and changes go through review like any other code.

- **Where Claude runs:** Only through FinTechCo's own Google Cloud (Vertex AI) or AWS (Bedrock) accounts. The model provider keeps no copies of our code or data.
- **Rule 1 (Card security):** Never write a full card number to a log. Show only the last four digits, like `XXXX-XXXX-XXXX-1234`. This applies in every language we use.
- **Rule 2 (From experiment to production):** Before a data science model becomes a production service, it needs clear input and output definitions that other teams can rely on, a score that always stays between 0 and 1, and a plain decision: approve, review, or decline.
- **Rule 3 (Logs):** Logs use a consistent, searchable format and never include customer data in free text.
- **Rule 4 (Prove it works):** Every change must pass the automated checks before it's done. Never edit the checks themselves to make them pass.
- **Rule 5 (Code review):** Every pull request is checked for security problems before a person reviews it: no passwords or keys in the code, no database queries built from customer input, and a permission check on anything that moves money.
