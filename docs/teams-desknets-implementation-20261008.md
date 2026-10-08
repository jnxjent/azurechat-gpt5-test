# Teams DeskNets scheduling implementation (2026-10-08)

Teams personal chat now invokes the existing DeskNets scheduling agent. Candidate selection and time changes retain conversation context. Final registration remains manual: the Teams card opens an authenticated AzureChat confirmation page, which opens the native DeskNets add screen. Users review the details and press Add in DeskNets. No automatic registration or approval endpoint is called.

Identity comes from the authenticated Teams member lookup. The normalized email hash matches AzureChat ownership; conversation state is partitioned by user and Teams conversation. Requests use the existing agent credentials and read mode. Cosmos locks and activity deduplication prevent concurrent duplicate submissions; uncertain POST delivery is not automatically retried. Reset and topic changes rotate the agent conversation context. Explicit Salesforce and SharePoint/document questions retain their existing routes.

Existing DESKNETS_AGENT configuration and NEXTAUTH_URL are required. No browser-agent backend change is required. This implementation was prepared from TestSite commit c21803de2ae8f601babf348c31c0f8f04a1df559 in an isolated worktree and reflected into the regular workspace without replacing unrelated changes.

Validation: Teams DeskNets service tests, TypeScript checks, Next.js production build, Salesforce routing (62 assertions), Teams usage counting, and DeskNets intent/transport tests (22 tests). Actual Teams and native DeskNets end-to-end verification remains pending deployment. No deployment or production modification was performed.
