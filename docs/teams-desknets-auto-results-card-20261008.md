# Teams DeskNets automatic results and shared confirmation card

User-requested fixes following the first Teams rollout:

1. Send `少々お待ちください。結果判明したらお知らせします。` before starting or resuming scheduling work. Continue checking the existing run and return its terminal result in the original Teams turn; no separate status question is required. Polling uses AC's 330-second browser-run budget. The Cosmos lock lasts longer than that budget, preventing concurrent duplicate scheduling submissions. A connection failure or exceeded budget produces an explicit failure/slow-processing response rather than leaving the wait notice as the final answer. Scheduling POSTs are never automatically retried.
2. The Teams confirmation page now renders the actual shared `DeskNetsApprovalCard`, including the Teams web meeting creation, saved meeting information, copy action, and native DeskNets handoff. Meeting creation remains an explicit button action. Final schedule registration remains the user's manual Add operation in DeskNets. The shared card accepts an optional return-to-candidates callback so this page directs users back to their Teams conversation instead of submitting into an unrelated AC chat.

Prepared on the isolated TestSite-based Local OK worktree. Only corresponding changes were reflected into the regular workspace; its older shared card was modified surgically.

Validation: delayed-run test simulates a 60-second completion and verifies the waiting notice occurs before POST, with one POST and automatic GET completion; Teams DeskNets tests; 26 DeskNets intent/transport/card rendering tests; Salesforce routing (62 assertions); Teams usage counting; production build; regular-workspace TypeScript check.

No deployment or production modification was performed for these fixes. Live Teams delivery and Graph meeting creation remain to be verified after TestSite deployment.
