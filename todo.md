# PR #1 Review Todo

- [x] Do not merge until preview proxying strips app credentials before forwarding to user-built preview apps. The current proxy forwards `agentmom_session` to arbitrary preview servers.
- [x] Fix shared access code semantics. The admin UI can currently surface the first active invite, including an admin invite or an old short invite.
- [x] Fix auto-preview under `smolvm`. Host-local static servers are registered as `smolvm` services and then fetched from inside the guest.
- [x] Restore workspace switching in the sidebar.
- [x] Restore or replace the Events tab so tool failures, deployment failures, runtime events, and preview events are visible.
- [x] Keep generated account access codes consistent with the 4-character code direction, or explicitly decide to change that policy.
- [x] Add coverage for `accessCode`, `regenerateAccessCode`, and `setUserRole`.
- [x] Clean up auto-preview lifecycle so removing a preview closes any host static server it created.
- [x] Revisit mobile layout with auto-preview open; the fixed-height shell can clip the chat/composer.
- [x] Hide the access-code field on the login form; it only applies to signup.
