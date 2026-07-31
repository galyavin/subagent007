---
name: governed-recursion-class-inheritance
description: Preserve one root-resolved model class across governed recursive descendants.
last_updated: 2026-07-31
---

# Governed recursive class inheritance

Use when changing model-class behavior beneath `system_skill_name` recursion.

1. Keep the root's resolved class only in authenticated recursive-control and live
   run-task context; do not add a public field, router, or persistent workflow state.
2. When governed, omit `model_class` from the child-facing delegate schema, compare
   recursive caller context with the active parent's private class, reject any
   selector or forged context, and construct the descendant with the inherited class.
3. Preserve generic recursive `model_class` schema and forwarding unchanged.
4. Test governed schema omission, at least two inherited hops with existing
   `resolved_model_class` reporting, rejected selector with no child admission,
   and generic class selection. Build before source-backed MCP tests.
