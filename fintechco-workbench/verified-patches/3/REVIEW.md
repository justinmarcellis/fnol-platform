# Review: pull request #1427, "Add self-serve refunds for support agents"

**Verdict:** was blocked, now ready for human review. 4 issues found and fixed; all 4 automated checks pass.

| # | Severity | Line | What was wrong | What changed |
|---|----------|------|----------------|--------------|
| 1 | Critical | 8, 11 | The order ID typed by the user was pasted straight into the database query. A crafted ID could refund every order. | Queries now pass the ID as a parameter, so it's treated as data, not instructions. |
| 2 | Critical | 4 | A live payments key was written in the code, so anyone with repo access could see it. | The key is now read from the environment (Secret Manager). **Rotate the exposed key.** |
| 3 | High | 7 | Anyone signed in could issue refunds. | Only users with the `refunds` role can issue one. |
| 4 | Medium | 7 | A refund could be larger than the payment, or the same order could be refunded twice. | Both are now rejected with a clear error. |

**For the human reviewer**
- Confirm `refunds` is the right role name for support agents.
- The exposed key is still in this branch's history. Rotate it before merging.
